/**
 * R4.5 runtime-engine locks. These tests exercise the Node transport over a
 * real socket: the new request source must stay lazy, while direct and stream
 * responses preserve framing, cancellation and the public Request contract.
 */

import { request as nodeRequest } from "node:http";
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { startNodeServer, type NodeServerHandle } from "../../src/adapters/node.ts";
import { Keala } from "../../src/core/app.ts";
import { bodyOf, createBodyParser } from "../../src/plugins/body-parser.ts";
import { createPlannedResponse } from "../../src/core/response-plan.ts";

const servers: NodeServerHandle[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

const start = async (register: (app: Keala) => void): Promise<NodeServerHandle> => {
  const app = new Keala({ env: "test" });
  register(app);
  const server = await startNodeServer(app, { port: 0, hostname: "127.0.0.1" }).ready();
  servers.push(server);
  return server;
};

const raw = (server: NodeServerHandle, request: string): Promise<string> =>
  new Promise((resolve, reject) => {
    let output = "";
    const socket = connect(server.port, "127.0.0.1", () => socket.write(request));
    socket.on("data", (chunk: Buffer) => {
      output += chunk.toString("latin1");
    });
    socket.on("end", () => resolve(output));
    socket.on("error", reject);
    socket.setTimeout(2_000, () => {
      socket.destroy();
      reject(new Error("raw socket response timed out"));
    });
  });

const withRequestConstructionCount = async (run: () => Promise<void>): Promise<number> => {
  const original = globalThis.Request;
  let constructed = 0;
  const counting = new Proxy(original, {
    construct(target, args, newTarget) {
      constructed++;
      return Reflect.construct(target, args, newTarget);
    },
  });
  Object.defineProperty(globalThis, "Request", {
    configurable: true,
    writable: true,
    value: counting,
  });
  try {
    await run();
  } finally {
    Object.defineProperty(globalThis, "Request", {
      configurable: true,
      writable: true,
      value: original,
    });
  }
  return constructed;
};

describe.skipIf(typeof Bun !== "undefined")("R4.5 Node request source", () => {
  it("does not materialize a Request for a GET route that only needs routing and headers", async () => {
    const count = await withRequestConstructionCount(async () => {
      const server = await start((app) => {
        app.get("/probe", (c) => c.json({ method: c.method, host: c.header("host") }));
      });
      const response = await raw(
        server,
        "GET /probe HTTP/1.1\r\nHost: example.test\r\nConnection: close\r\n\r\n",
      );
      expect(response).toContain('{"method":"GET","host":"example.test"}');
    });
    expect(count).toBe(0);
  });

  it("materializes c.raw once and preserves Request identity", async () => {
    const count = await withRequestConstructionCount(async () => {
      const server = await start((app) => {
        app.get("/raw", (c) => c.text(String(c.raw === c.raw)));
      });
      const response = await raw(
        server,
        "GET /raw HTTP/1.1\r\nHost: example.test\r\nConnection: close\r\n\r\n",
      );
      expect(response).toContain("true");
    });
    expect(count).toBe(1);
  });
});

describe("R4.5 Node response engine", () => {
  it("keeps pipelined direct responses framed and ordered", async () => {
    const server = await start((app) => {
      app.get("/json", (c) => c.json({ ok: true }));
      app.get("/text", (c) => c.text("second"));
    });
    const response = await raw(
      server,
      "GET /json HTTP/1.1\r\nHost: x\r\n\r\n" +
        "GET /text HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
    );
    expect(response.match(/HTTP\/1\.1 200/g)).toHaveLength(2);
    expect(response.indexOf('{"ok":true}')).toBeLessThan(response.indexOf("second"));
  });

  it("cancels a streaming producer when the client disconnects", async () => {
    let cancelled = false;
    const server = await start((app) => {
      app.get(
        "/stream",
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                controller.enqueue(new Uint8Array(64 * 1024));
              },
              cancel() {
                cancelled = true;
              },
            }),
          ),
      );
    });
    await new Promise<void>((resolve, reject) => {
      const socket = connect(server.port, "127.0.0.1", () => {
        socket.write("GET /stream HTTP/1.1\r\nHost: x\r\n\r\n");
      });
      socket.once("data", () => {
        socket.destroy();
        resolve();
      });
      socket.on("error", reject);
    });
    for (let attempt = 0; attempt < 50; attempt++) {
      if (cancelled) break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(cancelled).toBe(true);
  });

  it("preserves late rebuilt headers while retaining the direct body", async () => {
    const server = await start((app) => {
      app.use(async (c, next) => {
        await next();
        c.append("x-late", "second");
      });
      app.get("/late", (c) => c.text("direct", 201, { "x-late": "first" }));
    });
    const response = await fetch(`http://127.0.0.1:${server.port}/late`);
    expect(response.status).toBe(201);
    expect(response.headers.get("x-late")).toBe("first, second");
    expect(response.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await response.text()).toBe("direct");
  });

  it("exposes standard implicit content-type headers and honors direct deletion", async () => {
    const server = await start((app) => {
      app.get("/delete-content-type", (c) => {
        const response = c.text("direct");
        expect(response.headers.get("content-type")).toMatch(/^text\/plain/);
        response.headers.delete("content-type");
        return response;
      });
    });
    const response = await fetch(`http://127.0.0.1:${server.port}/delete-content-type`);
    expect(response.headers.get("content-type")).toBeNull();
    expect(await response.text()).toBe("direct");
  });

  it("writes planned byte bodies and every supported header-init shape", async () => {
    const server = await start((app) => {
      app.get("/record", (c) => c.text("record", 202, { "x-shape": "record" }));
      app.get("/headers", () => {
        const headers = new Headers({ "x-shape": "headers" });
        headers.append("set-cookie", "a=1");
        headers.append("set-cookie", "b=2");
        return createPlannedResponse(new Uint8Array([1, 2, 3]), {
          status: 203,
          statusText: "Non-Authoritative Information",
          headers,
        });
      });
      app.get("/tuples", () =>
        createPlannedResponse("tuples", {
          headers: [
            ["x-shape", "tuples"],
            ["x-second", "yes"],
          ],
        }),
      );
      app.get("/bare-status", (c) => c.text("status", 201));
      app.get("/bare-bytes", () => new Response(new Uint8Array([4, 5, 6])));
      app.get("/json-with-headers", (c) => c.json({ planned: true }, 207, { "x-planned": "json" }));
      app.get("/html", (c) => c.html("<strong>head</strong>"));
    });
    expect(server.hostname).toBe("127.0.0.1");

    const record = await fetch(`http://127.0.0.1:${server.port}/record`);
    expect(record.status).toBe(202);
    expect(record.headers.get("x-shape")).toBe("record");
    expect(await record.text()).toBe("record");

    const headers = await fetch(`http://127.0.0.1:${server.port}/headers`);
    expect(headers.status).toBe(203);
    expect(headers.statusText).toBe("Non-Authoritative Information");
    expect(headers.headers.get("x-shape")).toBe("headers");
    expect(headers.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
    expect([...new Uint8Array(await headers.arrayBuffer())]).toEqual([1, 2, 3]);

    const tuples = await fetch(`http://127.0.0.1:${server.port}/tuples`);
    expect(tuples.headers.get("x-shape")).toBe("tuples");
    expect(tuples.headers.get("x-second")).toBe("yes");
    expect(await tuples.text()).toBe("tuples");

    const status = await fetch(`http://127.0.0.1:${server.port}/bare-status`);
    expect(status.status).toBe(201); // 0.7: the c.message statusText staging is gone
    expect(await status.text()).toBe("status");

    const bytes = await fetch(`http://127.0.0.1:${server.port}/bare-bytes`);
    expect([...new Uint8Array(await bytes.arrayBuffer())]).toEqual([4, 5, 6]);

    const json = await fetch(`http://127.0.0.1:${server.port}/json-with-headers`);
    expect(json.status).toBe(207);
    expect(json.headers.get("x-planned")).toBe("json");
    expect(await json.json()).toEqual({ planned: true });

    const head = await fetch(`http://127.0.0.1:${server.port}/html`, { method: "HEAD" });
    expect(head.headers.get("content-type")).toMatch(/^text\/html/);
    expect(head.headers.get("content-length")).toBe("21");
    expect(await head.text()).toBe("");
  });
});

describe("R4.5 Node body ownership and cleanup", () => {
  it.skipIf(typeof Bun !== "undefined")(
    "rejects a partial upload when the client aborts without leaking the request",
    async () => {
      let observed: unknown;
      const server = await start((app) => {
        app.onError((error) => {
          observed = error;
        });
        app.use(createBodyParser({ jsonLimit: 256 }));
        app.post("/abort", async (c0) => {
          await bodyOf(c0).arrayBuffer();
          return c0.text("unreachable");
        });
      });

      await new Promise<void>((resolve, reject) => {
        const socket = connect(server.port, "127.0.0.1", () => {
          socket.write(
            "POST /abort HTTP/1.1\r\n" +
              "Host: x\r\n" +
              "Content-Type: application/octet-stream\r\n" +
              "Content-Length: 100\r\n\r\npartial",
          );
          socket.destroy();
          resolve();
        });
        socket.on("error", reject);
      });
      for (let attempt = 0; attempt < 50; attempt++) {
        if (observed !== undefined) break;
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      expect(observed).toBeInstanceOf(Error);
      expect((observed as Error).message).toContain("client disconnected");
    },
  );

  it.skipIf(typeof Bun !== "undefined")(
    "keeps c.raw consumed after the bounded parser owns the native body",
    async () => {
      const server = await start((app) => {
        app.use(createBodyParser({ jsonLimit: 64 }));
        app.post("/body", async (c) => {
          const value = await bodyOf(c).json();
          const bodyUsed = c.raw.bodyUsed;
          let secondReadRejected = false;
          try {
            await c.raw.text();
          } catch {
            secondReadRejected = true;
          }
          return c.json({ value, bodyUsed, secondReadRejected });
        });
      });
      const body = '{"n":1}';
      const response = await raw(
        server,
        `POST /body HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`,
      );
      expect(response).toContain('{"value":{"n":1},"bodyUsed":true,"secondReadRejected":true}');
    },
  );

  it("drains an unread request body before serving the next keep-alive request", async () => {
    const server = await start((app) => {
      app.post("/early", (c) => c.text("early"));
      app.get("/next", (c) => c.text("next"));
    });
    const response = await raw(
      server,
      "POST /early HTTP/1.1\r\nHost: x\r\nContent-Length: 8\r\n\r\n12345678" +
        "GET /next HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
    );
    expect(response.match(/HTTP\/1\.1 200/g)).toHaveLength(2);
    expect(response.indexOf("early")).toBeLessThan(response.indexOf("next"));
  });

  it("drains a materialized but unread c.raw body before the next request", async () => {
    const server = await start((app) => {
      app.post("/raw-early", (c) => {
        void c.raw;
        return c.text("early");
      });
      app.get("/next", (c) => c.text("next"));
    });
    const response = await raw(
      server,
      "POST /raw-early HTTP/1.1\r\nHost: x\r\nContent-Length: 8\r\n\r\n12345678" +
        "GET /next HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
    );
    expect(response.match(/HTTP\/1\.1 200/g)).toHaveLength(2);
    expect(response.indexOf("early")).toBeLessThan(response.indexOf("next"));
  });

  it("drains an oversized body after 413 and preserves the next pipelined request", async () => {
    const server = await start((app) => {
      app.use(createBodyParser({ jsonLimit: 4 }));
      app.post("/limited", async (c0) => {
        await bodyOf(c0).json();
        return c0.text("unreachable");
      });
      app.get("/next", (c) => c.text("next"));
    });
    const response = await raw(
      server,
      "POST /limited HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 8\r\n\r\n12345678" +
        "GET /next HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
    );
    expect(response.match(/HTTP\/1\.1 (?:413|200)/g)).toEqual(["HTTP/1.1 413", "HTTP/1.1 200"]);
    expect(response).toContain("next");
  });

  it.skipIf(typeof Bun !== "undefined")(
    "reads a lazily materialized c.raw stream once through the bounded facade",
    async () => {
      const server = await start((app) => {
        app.use(createBodyParser({ jsonLimit: 64 }));
        app.post("/raw-first", async (c) => {
          expect(c.raw).toBe(c.raw);
          expect(c.headers).toBe(c.headers);
          expect(c.header("x-missing")).toBe("");
          return c.json(await bodyOf(c).json());
        });
      });

      const response = await new Promise<string>((resolve, reject) => {
        const req = nodeRequest(
          {
            hostname: "127.0.0.1",
            port: server.port,
            path: "/raw-first",
            method: "POST",
            headers: { "content-type": "application/json" },
          },
          (res) => {
            let output = "";
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => (output += chunk));
            res.on("end", () => resolve(output));
          },
        );
        req.on("error", reject);
        req.write('{"message":"hello');
        setImmediate(() => req.end(' world"}'));
      });
      expect(response).toBe('{"message":"hello world"}');
    },
  );

  it.skipIf(typeof Bun !== "undefined")(
    "enforces the byte budget after c.raw has materialized the web stream",
    async () => {
      const server = await start((app) => {
        app.use(createBodyParser({ jsonLimit: 4 }));
        app.post("/raw-limited", async (c) => {
          void c.raw;
          return c.json(await bodyOf(c).json());
        });
      });
      const response = await fetch(`http://127.0.0.1:${server.port}/raw-limited`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "12345678",
      });
      expect(response.status).toBe(413);
    },
  );

  it("returns guarded empty bytes for an explicit zero-length body", async () => {
    const server = await start((app) => {
      app.use(createBodyParser({ jsonLimit: 4 }));
      app.post("/empty", async (c0) => {
        const bytes = await bodyOf(c0).arrayBuffer();
        return c0.text(String(bytes.byteLength));
      });
    });
    const response = await raw(
      server,
      "POST /empty HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
    );
    expect(response).toContain("\r\n\r\n0");
  });

  it.skipIf(typeof Bun !== "undefined")(
    "handles multi-chunk, empty and oversized chunked bodies in both native and web readers",
    async () => {
      const server = await start((app) => {
        // arrayBuffer() owns the formLimit budget (R4.10).
        app.use(createBodyParser({ formLimit: 16 }));
        app.post("/native", async (c0) => {
          const bytes = await bodyOf(c0).arrayBuffer();
          return c0.text(new TextDecoder().decode(bytes));
        });
        app.post("/raw", async (c) => {
          void c.raw;
          const bytes = await bodyOf(c).arrayBuffer();
          return c.text(String(bytes.byteLength));
        });
      });

      const postChunks = (
        path: string,
        chunks: string[],
      ): Promise<{ status: number; body: string }> =>
        new Promise((resolve, reject) => {
          const req = nodeRequest(
            {
              hostname: "127.0.0.1",
              port: server.port,
              path,
              method: "POST",
              headers: { "content-type": "application/octet-stream" },
            },
            (res) => {
              let output = "";
              res.setEncoding("utf8");
              res.on("data", (chunk: string) => (output += chunk));
              res.on("end", () => resolve({ status: res.statusCode ?? 0, body: output }));
            },
          );
          req.on("error", reject);
          const write = (index: number): void => {
            if (index === chunks.length) {
              req.end();
              return;
            }
            req.write(chunks[index]);
            setImmediate(() => write(index + 1));
          };
          write(0);
        });

      expect(await postChunks("/native", ["multi-", "chunk"])).toEqual({
        status: 200,
        body: "multi-chunk",
      });
      expect(await postChunks("/raw", [])).toEqual({ status: 200, body: "0" });
      expect(await postChunks("/raw", ["single"])).toEqual({ status: 200, body: "6" });
      expect(await postChunks("/native", ["123456789", "abcdefghi"])).toMatchObject({
        status: 413,
      });
      expect(await postChunks("/raw", ["123456789", "abcdefghi"])).toMatchObject({
        status: 413,
      });
    },
  );
});
