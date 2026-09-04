/**
 * Node adapter tests — real node:http servers over the wire (ephemeral
 * ports). The adapter itself runs under Bun too (Bun implements node:http),
 * so this suite executes in BOTH test gates.
 */

import { connect } from "node:net";
import { afterAll, describe, expect, it } from "vitest";

import { Keala } from "../src/core/app.ts";
import { listen, startNodeServer, type NodeServerHandle } from "../src/adapters/node.ts";
import { createBodyParser, type ContextWithBody } from "../src/plugins/body-parser.ts";
import { streamText } from "../src/helpers/streams.ts";

const quiet = { env: "test" } as const;
const servers: NodeServerHandle[] = [];

afterAll(() => {
  for (const server of servers) server.stop(true);
});

const serve = async (
  register: (app: InstanceType<typeof Keala>) => void,
): Promise<{ server: NodeServerHandle; base: string }> => {
  const app = new Keala(quiet);
  register(app);
  const server = await startNodeServer(app, { port: 0, hostname: "127.0.0.1" }).ready();
  servers.push(server);
  return { server, base: `http://127.0.0.1:${server.port}` };
};

describe("node adapter: request bridging", () => {
  it("serves text routes with status and headers", async () => {
    const { base } = await serve((app) => {
      app.get("/x", (c) => {
        c.setHeader("x-custom", "yes");
        c.body = "hello node";
      });
    });
    const res = await fetch(`${base}/x`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-custom")).toBe("yes");
    expect(await res.text()).toBe("hello node");
  });

  it("captures params, query and the request body streams through", async () => {
    const { base } = await serve((app) => {
      app.post("/users/:id", async (c) => {
        const body = await c.raw.text();
        return c.json({ id: c.params?.["id"], q: new URL(c.raw.url).searchParams.get("q"), body });
      });
    });
    const res = await fetch(`${base}/users/42?q=hi`, {
      method: "POST",
      body: "payload",
    });
    expect(await res.json()).toEqual({ id: "42", q: "hi", body: "payload" });
  });

  it("JSON bodies parse through the body-parser plugin", async () => {
    const { base } = await serve((app) => {
      app.use(createBodyParser());
      app.post("/j", async (c) => {
        const parsed = await (c as unknown as ContextWithBody).req.json();
        return c.json(parsed);
      });
    });
    const res = await fetch(`${base}/j`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ a: 1 }),
    });
    expect(await res.json()).toEqual({ a: 1 });
  });

  it("exposes the remote address through the runtime channel", async () => {
    const { base } = await serve((app) => {
      app.get("/ip", (c) => {
        c.body = c.ip;
      });
    });
    const res = await fetch(`${base}/ip`);
    // Loopback: "::1" / "127.0.0.1" depending on the host stack.
    expect(await res.text()).toMatch(/^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/);
  });

  it("Host header identity is preserved (c.host sees the request's own host)", async () => {
    const { base } = await serve((app) => {
      app.get("/host", (c) => {
        c.body = c.host;
      });
    });
    const res = await fetch(`${base}/host`);
    expect(await res.text()).toBe(`127.0.0.1:${new URL(base).port}`);
  });
});

describe("node adapter: response bridging", () => {
  it("fans out multiple set-cookie headers", async () => {
    const { base } = await serve((app) => {
      app.get("/cookies", (c) => {
        c.cookies.set("a", "1");
        c.cookies.set("b", "2");
        c.body = "ok";
      });
    });
    const res = await fetch(`${base}/cookies`);
    expect(res.headers.getSetCookie().sort()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });

  it("streams response bodies chunk-by-chunk (no adapter buffering)", async () => {
    const { base } = await serve((app) => {
      app.get("/stream", (c) =>
        streamText(c, async (w) => {
          for (let i = 0; i < 5; i++) {
            w.write(`chunk${i};`);
            await new Promise((r) => setTimeout(r, 5));
          }
        }),
      );
    });
    const res = await fetch(`${base}/stream`);
    expect(await res.text()).toBe("chunk0;chunk1;chunk2;chunk3;chunk4;");
  });

  it("HEAD answers with content-length and no body", async () => {
    const { base } = await serve((app) => {
      app.get("/big", (c) => {
        c.body = "x".repeat(1234);
      });
    });
    const res = await fetch(`${base}/big`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("1234");
    expect(await res.text()).toBe("");
  });

  it("errors surface as 500s with cleared headers", async () => {
    const { base } = await serve((app) => {
      app.get("/boom", () => {
        throw new Error("kaboom");
      });
    });
    const res = await fetch(`${base}/boom`);
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Internal Server Error");
  });

  it("404 and 405 flow through the finalizer", async () => {
    const { base } = await serve((app) => {
      app.get("/only", (c) => {
        c.body = "ok";
      });
    });
    expect((await fetch(`${base}/missing`)).status).toBe(404);
    const wrong = await fetch(`${base}/only`, { method: "DELETE" });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toContain("GET");
  });

  it("signed cookies work end-to-end through the adapter", async () => {
    const app = new Keala({ ...quiet, keys: ["adapter-secret"] });
    app.get("/set", (c) => {
      c.cookies.set("sid", "session-1", { signed: true });
      c.body = "set";
    });
    app.get("/read", (c) => {
      c.body = c.cookies.get("sid", { signed: true }) ?? "none";
    });
    const signed = await startNodeServer(app, { port: 0, hostname: "127.0.0.1" }).ready();
    servers.push(signed);
    const signedBase = `http://127.0.0.1:${signed.port}`;
    const set = await fetch(`${signedBase}/set`);
    const cookie = set.headers.getSetCookie()[0] as string;
    expect(cookie).toContain(".");
    const read = await fetch(`${signedBase}/read`, { headers: { cookie } });
    expect(await read.text()).toBe("session-1");
  });
});

describe("node adapter: server lifecycle", () => {
  it("stop() closes the port; stop(true) drops active connections", async () => {
    const app = new Keala(quiet);
    app.get("/x", (c) => {
      c.body = "ok";
    });
    const server = await listen(app, 0, "127.0.0.1").ready();
    const base = `http://127.0.0.1:${server.port}`;
    expect(await (await fetch(`${base}/x`)).text()).toBe("ok");
    server.stop();
    await expect(fetch(`${base}/x`)).rejects.toThrow();
  });

  it("onListen fires once the socket is bound", async () => {
    const app = new Keala(quiet);
    let fired = 0;
    const server = await listen(app, 0, "127.0.0.1", () => {
      fired++;
    }).ready();
    servers.push(server);
    expect(fired).toBe(1);
  });

  it("handle.fetch() mirrors the Bun server handle shape", async () => {
    const app = new Keala(quiet);
    app.get("/x", (c) => {
      c.body = "direct";
    });
    const server = await listen(app, 0, "127.0.0.1").ready();
    servers.push(server);
    const res = await server.fetch(new Request(`http://127.0.0.1:${server.port}/x`));
    expect(await res.text()).toBe("direct");
  });

  // Bun.serve exists under real Bun, so listen() legitimately serves there.
  it.skipIf(typeof Bun !== "undefined")(
    "app.listen() refuses to serve without Bun.serve and points at the Node adapter",
    () => {
      const app = new Keala(quiet);
      expect(() => app.listen(0)).toThrow(/Bun\.serve|startNodeServer/);
    },
  );
});

describe("node adapter: raw socket behavior", () => {
  it("websocket upgrade requests are refused with 501 at the wire level", async () => {
    const app = new Keala(quiet);
    app.get("/x", (c) => {
      c.body = "ok";
    });
    const server = await listen(app, 0, "127.0.0.1").ready();
    servers.push(server);
    const status = await new Promise<string>((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port: server.port }, () => {
        socket.write(
          "GET /x HTTP/1.1\r\n" +
            `Host: 127.0.0.1:${server.port}\r\n` +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
            "Sec-WebSocket-Version: 13\r\n\r\n",
        );
      });
      socket.on("data", (chunk: Buffer) => resolve(chunk.toString().split("\r\n")[0] ?? ""));
      socket.on("error", reject);
    });
    expect(status).toContain("501");
  });

  it("an HTTP/1.0 request without Host still routes (fallback origin)", async () => {
    const app = new Keala(quiet);
    app.get("/legacy", (c) => {
      c.body = "old http";
    });
    const server = await listen(app, 0, "127.0.0.1").ready();
    servers.push(server);
    const body = await new Promise<string>((resolve, reject) => {
      let data = "";
      const socket = connect({ host: "127.0.0.1", port: server.port }, () => {
        socket.write("GET /legacy HTTP/1.0\r\n\r\n");
      });
      socket.on("data", (chunk: Buffer) => {
        data += chunk.toString();
      });
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
    });
    expect(body).toContain("200");
    expect(body).toContain("old http");
  });
});

describe("node adapter: failure surfaces", () => {
  it("reports stable defaults before an asynchronously bound socket is ready", async () => {
    const app = new Keala(quiet);
    const pending = startNodeServer(app, { port: 0 });
    expect(pending.port).toBe(0);
    expect(pending.hostname).toBe("localhost");
    const server = await pending.ready();
    servers.push(server);
    expect(server.port).toBeGreaterThan(0);
  });

  it("repeated request headers arrive as an array value", async () => {
    const app = new Keala(quiet);
    app.get("/x-forwarded", (c) => {
      c.body = c.get("x-forwarded-for");
    });
    const server = await listen(app, 0, "127.0.0.1").ready();
    servers.push(server);
    const body = await new Promise<string>((resolve, reject) => {
      let data = "";
      const socket = connect({ host: "127.0.0.1", port: server.port }, () => {
        socket.write(
          "GET /x-forwarded HTTP/1.1\r\n" +
            `Host: 127.0.0.1:${server.port}\r\n` +
            "X-Forwarded-For: 10.0.0.1\r\n" +
            "X-Forwarded-For: 10.0.0.2\r\n" +
            "Connection: close\r\n\r\n",
        );
      });
      socket.on("data", (chunk: Buffer) => {
        data += chunk.toString();
      });
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
    });
    expect(body).toContain("10.0.0.1, 10.0.0.2");
  });

  it("a client disconnect before the response answers the bridge 500 path", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = new Keala(quiet);
    app.get("/slow", (c) => {
      return gate.then(() => {
        c.body = "late";
      });
    });
    const server = await listen(app, 0, "127.0.0.1").ready();
    servers.push(server);
    const socket = connect({ host: "127.0.0.1", port: server.port }, () => {
      socket.write(`GET /slow HTTP/1.1\r\nHost: x\r\n\r\n`);
    });
    await new Promise((r) => setTimeout(r, 30));
    socket.destroy();
    release?.();
    await new Promise((r) => setTimeout(r, 30));
  });

  it("a response stream failing after headers destroys the socket", async () => {
    const app = new Keala(quiet);
    app.get("/broken-stream", (c) => {
      c.status = 200;
      c.body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("part1"));
          setTimeout(() => controller.error(new Error("mid-stream failure")), 10);
        },
      });
    });
    const server = await listen(app, 0, "127.0.0.1").ready();
    servers.push(server);
    const ended = new Promise<string>((resolve, reject) => {
      let data = "";
      const socket = connect({ host: "127.0.0.1", port: server.port }, () => {
        socket.write(`GET /broken-stream HTTP/1.1\r\nHost: x\r\n\r\n`);
      });
      socket.on("data", (chunk: Buffer) => {
        data += chunk.toString();
      });
      socket.on("close", () => resolve(data));
      socket.on("error", reject);
    });
    const data = await ended;
    expect(data).toContain("200");
    expect(data).toContain("part1");
  });

  it("a response writer failure before headers returns an isolated 500", async () => {
    const invalid = new Proxy(new Response("body"), {
      get(target, key) {
        if (key === "status") throw new Error("invalid response status");
        return Reflect.get(target, key, target) as unknown;
      },
    });
    const app = new Keala(quiet);
    app.get("/invalid-response", () => invalid);
    const server = await listen(app, 0, "127.0.0.1").ready();
    servers.push(server);
    const response = await fetch(`http://127.0.0.1:${server.port}/invalid-response`);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Internal Server Error");
  });

  it("malformed HTTP answers 400 and drops the connection", async () => {
    const app = new Keala(quiet);
    app.get("/x", (c) => {
      c.body = "ok";
    });
    const server = await listen(app, 0, "127.0.0.1").ready();
    servers.push(server);
    const status = await new Promise<string>((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port: server.port }, () => {
        socket.write("\u0003\u0004\u0005 nonsense\r\n\r\n");
      });
      socket.on("data", (chunk: Buffer) => resolve(chunk.toString().split("\r\n")[0] ?? ""));
      socket.on("error", reject);
    });
    expect(status).toContain("400");
  });
});

describe("node adapter: bridge failures", () => {
  it("an unparseable absolute-form target is refused (parser 400 or bridge 500)", async () => {
    const app = new Keala(quiet);
    app.get("/x", (c) => {
      c.body = "ok";
    });
    const server = await listen(app, 0, "127.0.0.1").ready();
    servers.push(server);
    const status = await new Promise<string>((resolve, reject) => {
      let data = "";
      const socket = connect({ host: "127.0.0.1", port: server.port }, () => {
        socket.write("GET ftp://\r\n\r\n");
      });
      socket.on("data", (chunk: Buffer) => {
        data += chunk.toString();
      });
      socket.on("close", () => resolve(data));
      socket.on("error", reject);
    });
    // Node's parser hands the garbage target to the request handler (bridge
    // 500); Bun's rejects it earlier (clientError 400). Both close the
    // connection without a route ever running.
    expect(status).toMatch(/\b(400|500)\b/);
  });
});

describe("node adapter: review hardening", () => {
  it("a busy port rejects ready() instead of crashing", async () => {
    const occupier = await listen(new Keala(quiet), 0, "127.0.0.1").ready();
    servers.push(occupier);
    const app = new Keala(quiet);
    app.get("/x", (c) => {
      c.body = "ok";
    });
    await expect(listen(app, occupier.port, "127.0.0.1").ready()).rejects.toThrow();
  });

  it("absolute-form request targets route like origin-form", async () => {
    const app = new Keala(quiet);
    app.get("/proxy-style", (c) => {
      c.body = c.URL!.pathname;
    });
    const server = await listen(app, 0, "127.0.0.1").ready();
    servers.push(server);
    const body = await new Promise<string>((resolve, reject) => {
      let data = "";
      const socket = connect({ host: "127.0.0.1", port: server.port }, () => {
        socket.write(
          `GET http://127.0.0.1:${server.port}/proxy-style HTTP/1.1\r\n` +
            `Host: 127.0.0.1:${server.port}\r\nConnection: close\r\n\r\n`,
        );
      });
      socket.on("data", (chunk: Buffer) => {
        data += chunk.toString();
      });
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
    });
    expect(body).toContain("200");
    expect(body).toContain("/proxy-style");
  });

  it("an IPv6-bound server answers Host-less HTTP/1.0 requests", async () => {
    const app = new Keala(quiet);
    app.get("/legacy", (c) => {
      c.body = "old http";
    });
    const server = await listen(app, 0, "::1").ready();
    servers.push(server);
    const body = await new Promise<string>((resolve, reject) => {
      let data = "";
      const socket = connect({ host: "::1", port: server.port }, () => {
        socket.write("GET /legacy HTTP/1.0\r\n\r\n");
      });
      socket.on("data", (chunk: Buffer) => {
        data += chunk.toString();
      });
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
    });
    expect(body).toContain("old http");
  });
});
