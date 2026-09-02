/**
 * R4.5 runtime-engine locks. These tests exercise the Node transport over a
 * real socket: the new request source must stay lazy, while direct and stream
 * responses preserve framing, cancellation and the public Request contract.
 */

import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { startNodeServer, type NodeServerHandle } from "../src/adapters/node.ts";
import { Keala } from "../src/core/app.ts";

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
        app.get("/probe", (c) => c.json({ method: c.method, host: c.get("host") }));
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
});
