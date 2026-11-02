import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createPlannedResponse, responseFactsOf } from "../../src/core/response-plan.ts";
import { bodyOf, createBodyParser } from "../../src/plugins/body-parser.ts";
import { Keala } from "../../src/core/app.ts";
import { startNodeServer, type NodeServerHandle } from "../../src/adapters/node.ts";
const servers: NodeServerHandle[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});
const start = async (app: Keala, maxRequestBodySize = 1000) => {
  const server = await startNodeServer(app, {
    port: 0,
    hostname: "127.0.0.1",
    maxRequestBodySize,
  }).ready();
  servers.push(server);
  return server;
};
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Node body and response cancellation boundaries", () => {
  for (const mode of ["raw", "clone", "stream", "headers-first"] as const) {
    it(`closes and releases a partial ${mode} body after a deadline`, async () => {
      const app = new Keala({ env: "test", requestTimeout: 20 });
      app.use(createBodyParser());
      let finished = false;
      app.post("/", async (c) => {
        try {
          if (mode === "headers-first") {
            void c.headers;
            await bodyOf(c).text();
          } else if (mode === "stream") {
            const reader = c.raw.body!.getReader();
            while (!(await reader.read()).done) {
              /* read until EOF or cancel */
            }
          } else await (mode === "clone" ? c.raw.clone() : c.raw).text();
          return c.text("late");
        } finally {
          finished = true;
        }
      });
      const server = await start(app);
      const wire = await new Promise<string>((resolve, reject) => {
        let output = "";
        const socket = connect(server.port, "127.0.0.1", () =>
          socket.write("POST / HTTP/1.1\r\nHost: test\r\nContent-Length: 100\r\n\r\nx"),
        );
        socket.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
        socket.on("end", () => resolve(output));
        socket.on("error", reject);
        socket.setTimeout(500, () => {
          socket.destroy();
          reject(new Error("early answer left the body/socket alive"));
        });
      });
      expect(wire).toContain("504");
      expect(wire.toLowerCase()).toContain("connection: close");
      for (let i = 0; i < 20; i++) {
        if (finished) break;
        await delay(1);
      }
      expect(finished).toBe(true);
    });
  }
  it("retains the peer IP for async error mapping after a raw body exceeds the cap", async () => {
    const app = new Keala({ env: "test" });
    app.onError(async (error, c) => {
      await delay(1);
      return c.text(`mapped ${c.ip}`, error.status);
    });
    app.post("/", async (c) => c.text(await c.raw.text()));
    const server = await start(app, 4);
    const response = await fetch(`http://127.0.0.1:${server.port}/`, {
      method: "POST",
      body: "12345",
    });
    expect(response.status).toBe(413);
    expect(await response.text()).toMatch(/^mapped (127\.0\.0\.1|::ffff:127\.0\.0\.1)$/);
  });
  it("cancels a response returned after the client already disconnected", async () => {
    const app = new Keala({ env: "test" });
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let disconnected!: () => void;
    const gone = new Promise<void>((resolve) => {
      disconnected = resolve;
    });
    let cancelled!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    app.get("/", async (c) => {
      c.signal.addEventListener("abort", disconnected, { once: true });
      enter();
      await gate;
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled();
          },
        }),
      );
    });
    const server = await start(app);
    const socket = connect(server.port, "127.0.0.1", () =>
      socket.write("GET / HTTP/1.1\r\nHost: test\r\n\r\n"),
    );
    await entered;
    socket.destroy();
    await gone;
    release();
    await expect(cancellation).resolves.toBeUndefined();
  });
  for (const mapper of ["builtin", "takeover", "async", "failure"] as const) {
    it(`releases the discarded response on ${mapper} error handling`, async () => {
      const app = new Keala({ env: "test" });
      if (mapper === "takeover") app.onError((_error, c) => c.text("mapped", 500));
      if (mapper === "async")
        app.onError(async (_error, c) => {
          await delay(0);
          return c.text("mapped", 500);
        });
      if (mapper === "failure")
        app.onError(() => {
          throw new Error("mapper failed");
        });
      let cancelled = false;
      app.use(async (_c, next) => {
        await next();
        throw new Error("outer failed");
      });
      app.get(
        "/",
        () =>
          new Response(
            new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
          ),
      );
      const response = await app.handle(new Request("http://local/"));
      expect(response.status).toBe(500);
      expect(cancelled).toBe(true);
    });
  }

  it("preserves a committed body transferred into the error takeover", async () => {
    const app = new Keala({ env: "test" });
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("kept"));
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    app.onError(() => new Response(body, { status: 500 }));
    app.use(async (_c, next) => {
      await next();
      throw new Error("outer failed");
    });
    app.get("/", () => new Response(body));
    const response = await app.handle(new Request("http://local/"));
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("kept");
    expect(cancelled).toBe(false);
  });
  for (const turns of [3, 4, 5]) {
    it(`keeps framing safe when public headers mutate ${turns} microtasks after an async return`, async () => {
      const app = new Keala({ env: "test" });
      app.get("/", async (c) => {
        const response = c.text("hello", 201, { "x-test": "live" });
        let remaining = turns;
        const mutate = () => {
          if (--remaining > 0) queueMicrotask(mutate);
          else response.headers.set("transfer-encoding", "chunked");
        };
        queueMicrotask(mutate);
        return response;
      });
      const server = await start(app);
      const wire = await new Promise<string>((resolve, reject) => {
        let output = "";
        const socket = connect(server.port, "127.0.0.1", () =>
          socket.write("GET / HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n"),
        );
        socket.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
        socket.on("end", () => resolve(output));
        socket.on("error", reject);
        socket.setTimeout(1000, () => {
          socket.destroy();
          reject(new Error("response did not finish"));
        });
      });
      const headers = wire.split("\r\n\r\n", 1)[0]!.toLowerCase();
      expect(headers).toContain("201 created");
      expect(headers.includes("transfer-encoding:") && headers.includes("content-length:")).toBe(
        false,
      );
      expect(wire).toContain("hello");
    });
  }
  it("keeps bare response plans unmaterialized during network sending", async () => {
    const app = new Keala({ env: "test" });
    const planned = createPlannedResponse("hello", {}, "text/plain; charset=utf-8");
    app.get("/", () => planned);
    const server = await start(app);
    expect(await (await fetch(`http://127.0.0.1:${server.port}/`)).text()).toBe("hello");
    expect(responseFactsOf(planned)?.native).toBeUndefined();
  });
  it("maps Response.error() to a server error", async () => {
    const app = new Keala({ env: "test" });
    app.get("/", () => Response.error());
    const server = await start(app);
    const response = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Internal Server Error");
  });
  it("corrects nonzero Content-Length on a null body before connection reuse", async () => {
    const app = new Keala({ env: "test" });
    app.get("/", () => new Response(null, { headers: { "content-length": "50" } }));
    const server = await start(app);
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`http://127.0.0.1:${server.port}/`);
      expect(response.headers.get("content-length")).toBe("0");
      expect(await response.text()).toBe("");
    }
  });
  it("keeps the native default bind address when HOST is present", async () => {
    const previous = process.env.HOST;
    process.env.HOST = "127.0.0.1";
    try {
      const server = await startNodeServer(new Keala({ env: "test" }), { port: 0 }).ready();
      servers.push(server);
      expect(["::", "0.0.0.0"]).toContain(server.hostname);
    } finally {
      if (previous === undefined) delete process.env.HOST;
      else process.env.HOST = previous;
    }
  });
});
