/**
 * R4.10 audit regressions — the Node adapter findings:
 *
 *  NA-P1  a re-sent consumed Response (cached module-level constant) answers
 *         a FRAMED 500 through the serve-error path — the old degrade branch
 *         emitted an unframed bodiless response that killed the keep-alive
 *         socket and dropped a pipelined follow-up. Unified-loud: the same
 *         story as the Bun adapter.
 *  NA-P2  one shared close listener per socket (pipelining no longer trips
 *         MaxListenersExceededWarning), idleTimeout/maxRequestBodySize are
 *         accepted Bun-parity options (keep-alive mapping + a HARD transport
 *         body cap), Bun-only keys fail with their migration story.
 */

import { afterAll, describe, expect, it } from "vitest";
import net from "node:net";

import { Keala } from "../src/index.ts";
import { startNodeServer, type NodeServerHandle } from "../src/adapters/node.ts";
import { createBodyParser, type ContextWithBody } from "../src/plugins/body-parser.ts";

const quiet = { env: "test" } as const;
const servers: NodeServerHandle[] = [];
afterAll(() => {
  for (const server of servers) server.stop(true);
});

/**
 * Raw-socket exchange: write via the callback, read until the socket idles
 * for `idleMs`. Keep-alive reuse is the point — fetch pools hide the wire.
 */
const exchange = async (
  port: number,
  write: (socket: net.Socket) => void,
  idleMs = 300,
): Promise<string> => {
  const socket = net.connect(port, "127.0.0.1");
  const chunks: Buffer[] = [];
  let idle: NodeJS.Timeout | undefined;
  const arm = (resolve: (value: string) => void): void => {
    clearTimeout(idle);
    idle = setTimeout(() => {
      socket.destroy();
      resolve(Buffer.concat(chunks).toString("latin1"));
    }, idleMs);
  };
  return new Promise<string>((resolve) => {
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      arm(resolve);
    });
    socket.on("error", () => {
      clearTimeout(idle);
      resolve(Buffer.concat(chunks).toString("latin1"));
    });
    socket.on("connect", () => {
      arm(resolve);
      write(socket);
    });
  });
};

describe("audit NA-P1: consumed-Response reuse is framed-loud on the wire", () => {
  it("a cached module-level response: first hit answers, every reuse is a framed 500 on the SAME socket", async () => {
    const cached = new Response("cached-page", {
      status: 404,
      headers: { "content-type": "text/plain" },
    });
    const app = new Keala(quiet);
    app.notFound(() => cached);
    const server = startNodeServer(app, { port: 0 });
    servers.push(server);
    await server.ready();
    const wire = await exchange(
      server.port,
      (socket) => {
        socket.write("GET /one HTTP/1.1\r\nHost: x\r\n\r\n");
        // keep-alive: the second request rides the same connection
        setTimeout(() => socket.write("GET /two HTTP/1.1\r\nHost: x\r\n\r\n"), 150);
      },
      600,
    );
    const statuses = wire.match(/HTTP\/1\.1 \d{3}/g) ?? [];
    expect(statuses).toEqual(["HTTP/1.1 404", "HTTP/1.1 500"]);
    // The reused response is FRAMED (a length delimiter present) — never the
    // unframed bodiless answer that desynced the connection.
    expect(wire.toLowerCase()).toContain("content-length:");
    expect(wire).toContain("Internal Server Error");
  });
});

describe("audit NA-P2: options surface and listener hygiene", () => {
  it("idleTimeout and maxRequestBodySize are accepted (Bun parity)", async () => {
    const app = new Keala(quiet);
    app.get("/", (c) => c.text("ok"));
    const server = startNodeServer(app, { port: 0, idleTimeout: 30, maxRequestBodySize: 64 });
    servers.push(server);
    await server.ready();
    const res = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(await res.text()).toBe("ok");
  });

  it("maxRequestBodySize is a HARD transport cap — looser plugin limits cannot reopen it", async () => {
    const app = new Keala(quiet);
    app.use(createBodyParser({ jsonLimit: 1024 * 1024 }));
    app.post("/", async (c) => c.text(`len:${(await (c as ContextWithBody).req.text()).length}`));
    const server = startNodeServer(app, { port: 0, maxRequestBodySize: 64 });
    servers.push(server);
    await server.ready();
    const small = await fetch(`http://127.0.0.1:${server.port}/`, { method: "POST", body: "hi" });
    expect([small.status, await small.text()]).toEqual([200, "len:2"]);
    const big = await fetch(`http://127.0.0.1:${server.port}/`, {
      method: "POST",
      body: "x".repeat(200),
    });
    expect(big.status).toBe(413);
  });

  it("Bun-only keys fail with their migration story, not a bare unknown-option", () => {
    const app = new Keala(quiet);
    expect(() => startNodeServer(app, { port: 0, reusePort: true })).toThrow(/cluster/);
    expect(() => startNodeServer(app, { port: 0, nativeRoutes: false })).toThrow(/native routing/);
    expect(() => startNodeServer(app, { port: 0, websocket: {} })).toThrow(/Bun-only/);
    expect(() => startNodeServer(app, { port: 0, idleTimout: 1 })).toThrow(/unknown option/);
  });

  it("pipelining many concurrent responses on one socket never warns about listeners", async () => {
    const warnings: string[] = [];
    const original = process.emitWarning;
    process.emitWarning = ((warning: unknown) => {
      if (String(warning).includes("MaxListenersExceeded")) warnings.push(String(warning));
      return undefined;
    }) as typeof process.emitWarning;
    const app = new Keala(quiet);
    app.get("/slow", async (c) => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      c.setHeader("X-Tag", "p");
      return c.text("done");
    });
    const server = startNodeServer(app, { port: 0 });
    servers.push(server);
    await server.ready();
    try {
      const wire = await exchange(
        server.port,
        (socket) => {
          // 20 pipelined requests before any response completes
          for (let i = 0; i < 20; i++) {
            socket.write(`GET /slow HTTP/1.1\r\nHost: x\r\n\r\n`);
          }
        },
        900,
      );
      const statuses = wire.match(/HTTP\/1\.1 200/g) ?? [];
      expect(statuses.length).toBeGreaterThanOrEqual(20);
      expect(warnings).toEqual([]);
    } finally {
      process.emitWarning = original;
    }
  });
});
