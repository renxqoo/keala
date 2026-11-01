import { request } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Keala } from "../../src/core/app.ts";
import { Router } from "../../src/router/group.ts";
import { startNodeServer, type NodeServerHandle } from "../../src/adapters/node.ts";
import { basicAuth } from "../../src/middleware/auth.ts";
import { cache } from "../../src/middleware/cache.ts";
import { serveStatic } from "../../src/middleware/serve-static.ts";
import { streamSSE } from "../../src/helpers/streams.ts";

const servers: NodeServerHandle[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const start = async (app: Keala, cap?: number) => {
  const server = await startNodeServer(app, {
    port: 0,
    hostname: "127.0.0.1",
    ...(cap === undefined ? {} : { maxRequestBodySize: cap }),
  }).ready();
  servers.push(server);
  return server;
};
const fileRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), "keala-refactor-"));
  roots.push(root);
  await mkdir(join(root, "private"));
  await writeFile(join(root, "private/token.txt"), "protected");
  return root;
};
const rawGet = (port: number, path: string): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      res.on("end", () => resolve({ status: res.statusCode as number, body }));
    });
    req.on("error", reject);
    req.end();
  });

describe("refactor: authorization and shared input boundaries", () => {
  for (const scope of ["/assets/private/token.txt", "/assets/private/deep/*"]) {
    for (const order of ["middleware-first", "sink-first"] as const) {
      it(`rejects directory sink overlapping ${scope} (${order})`, async () => {
        const root = await fileRoot();
        const app = new Keala({ env: "test" });
        const auth = basicAuth({ username: "u", password: "p" });
        if (order === "middleware-first") {
          app.use(scope, auth);
          expect(() => app.sink("/assets/*", { dir: root })).toThrow(/middleware|overlap/i);
        } else {
          app.sink("/assets/*", { dir: root });
          expect(() => app.use(scope, auth)).toThrow(/middleware|overlap|sink/i);
        }
      });
    }
  }
  it("refuses dot-segment aliases of scoped private files over real Node HTTP", async () => {
    const root = await fileRoot();
    const app = new Keala({ env: "test" });
    app.use("/private/*", basicAuth({ username: "u", password: "p" }));
    app.use(serveStatic({ root }));
    const server = await start(app);
    expect((await rawGet(server.port, "/private/token.txt")).status).toBe(401);
    for (const path of ["/public/%2e%2e/private/token.txt", "/%2e/private/token.txt"]) {
      const result = await rawGet(server.port, path);
      expect(result.status).toBeGreaterThanOrEqual(400);
      expect(result.body).not.toContain("protected");
    }
  });
  for (const reader of ["text", "clone", "stream"] as const) {
    it(`enforces transport cap for raw ${reader} reads`, async () => {
      const app = new Keala({ env: "test" });
      app.post("/body", async (c) => {
        const source = reader === "clone" ? c.raw.clone() : c.raw;
        if (reader === "stream") {
          const body = source.body!.getReader();
          while (!(await body.read()).done) {
            /* consume the stream */
          }
        } else await source.text();
        return c.text("accepted");
      });
      const server = await start(app, 4);
      const response = await fetch(`http://127.0.0.1:${server.port}/body`, {
        method: "POST",
        body: "1234567890",
      });
      expect(response.status).toBe(413);
      await response.text();
    });
  }
});

describe("refactor: response ownership", () => {
  it("sends the final JSON replacement over Node, matching fetch", async () => {
    const app = new Keala({ env: "test" });
    app.use(async (c, next) => {
      await next();
      return c.json({ public: true });
    });
    app.get("/data", (c) => c.json({ secret: "internal" }));
    expect(await (await app.handle(new Request("http://localhost/data"))).json()).toEqual({
      public: true,
    });
    const server = await start(app);
    const response = await fetch(`http://127.0.0.1:${server.port}/data`);
    expect(await response.json()).toEqual({ public: true });
  });
  it("cancels the discarded SSE producer on automatic HEAD fallback", async () => {
    const app = new Keala({ env: "test" });
    let aborted = false;
    let original: Response | undefined;
    app.get("/events", (c) => {
      original = streamSSE(
        c,
        (sse) =>
          new Promise<void>((resolve) => {
            sse.onAbort(() => {
              aborted = true;
              resolve();
            });
          }),
        { heartbeat: 1 },
      );
      return original;
    });
    try {
      const response = await app.handle(new Request("http://localhost/events", { method: "HEAD" }));
      expect(response.body).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(aborted).toBe(true);
    } finally {
      await original?.body?.cancel();
    }
  });
  it("bypasses anonymous cache replay for a Cookie-bearing request", async () => {
    const app = new Keala({ env: "test" });
    let computed = 0;
    app.get("/me", cache(), (c) => {
      computed++;
      return c.text(c.header("cookie") ? "member" : "guest");
    });
    expect(await (await app.handle(new Request("http://localhost/me"))).text()).toBe("guest");
    const response = await app.handle(
      new Request("http://localhost/me", { headers: { cookie: "sid=alice" } }),
    );
    expect(await response.text()).toBe("member");
    expect(computed).toBe(2);
    expect(response.headers.get("x-cache")).toBeNull();
  });
  for (const [destination, expected] of [
    ["/new/:id?view=full", "/new/42?view=full"],
    ["/new/:id#details", "/new/42#details"],
    ["/new/:id?/end?view=full", "/new/42/end?view=full"],
  ] as const) {
    it(`preserves redirect suffix ${destination} for App and Router`, async () => {
      for (const grouped of [false, true]) {
        const app = new Keala({ env: "test" });
        if (grouped) {
          const router = new Router();
          router.redirect("/old/:id", destination);
          app.mount("/", router);
        } else app.redirect("/old/:id", destination);
        const response = await app.handle(new Request("http://localhost/old/42"));
        expect(response.headers.get("location")).toBe(expected);
      }
    });
  }
});

describe("refactor: runtime lifecycle", () => {
  it("refuses starting the public Node listener after close", async () => {
    const app = new Keala({ env: "test" });
    await app.close();
    expect(() => {
      const server = startNodeServer(app, { port: 0 });
      servers.push(server);
    }).toThrow(/clos|drain|shut/i);
  });
  it("supports asynchronous deadlines without Promise.withResolvers", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Promise, "withResolvers");
    const app = new Keala({ env: "test", requestTimeout: 20 });
    app.get("/", async (c) => c.text("ok"));
    let response: Promise<Response>;
    try {
      Object.defineProperty(Promise, "withResolvers", { configurable: true, value: undefined });
      response = app.handle(new Request("http://localhost/"));
    } finally {
      if (descriptor) Object.defineProperty(Promise, "withResolvers", descriptor);
      else Reflect.deleteProperty(Promise, "withResolvers");
    }
    expect(await (await response).text()).toBe("ok");
  });
});
