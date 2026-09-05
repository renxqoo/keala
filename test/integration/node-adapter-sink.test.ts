/**
 * Node adapter sink-mirror and serve-error surface: the static sink's
 * planned-response fast path (byte-identical repeat hits under the Node
 * writer) and the onServeError envelope replacement.
 */

import { afterAll, describe, expect, it } from "vitest";

import { Keala } from "../../src/core/app.ts";
import { listen, startNodeServer, type NodeServerHandle } from "../../src/adapters/node.ts";

const quiet = { env: "test" } as const;
const servers: NodeServerHandle[] = [];
afterAll(() => {
  for (const server of servers) server.stop(true);
});

describe("node adapter: sink mirrors and serve-error surface", () => {
  it("a static sink serves identical bytes across repeat hits (planned fast path)", async () => {
    const app = new Keala(quiet);
    app.sink(
      "/cached",
      new Response("cached-body", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8", "x-sunk": "yes" },
      }),
    );
    const server = await startNodeServer(app, { port: 0, hostname: "127.0.0.1" }).ready();
    servers.push(server);
    for (let hit = 0; hit < 3; hit++) {
      const res = await fetch(`http://127.0.0.1:${server.port}/cached`);
      expect([res.status, await res.text(), res.headers.get("x-sunk")]).toEqual([
        200,
        "cached-body",
        "yes",
      ]);
      expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    }
  });

  it("onServeError replaces the plain envelope before any byte is sent", async () => {
    const app = new Keala({ ...quiet, env: "production" });
    app.get("/boom", () => {
      throw new Error("handler");
    });
    // A consumed Response makes the writer throw synchronously before any
    // byte is sent — the deterministic onServeError trigger.
    app.get("/consumed", async () => {
      const response = new Response("secret");
      await response.text();
      return response;
    });
    const server = await startNodeServer(app, {
      port: 0,
      hostname: "127.0.0.1",
      onServeError: (error) => new Response(`mapped:${error.message}`, { status: 502 }),
    }).ready();
    servers.push(server);
    const funnel = await fetch(`http://127.0.0.1:${server.port}/boom`);
    expect([funnel.status, await funnel.text()]).toEqual([500, "Internal Server Error"]);
    const mapped = await fetch(`http://127.0.0.1:${server.port}/consumed`);
    expect(mapped.status).toBe(502);
    expect(await mapped.text()).toMatch(/^mapped:/);
  });
});

describe("review fixes: option surfaces and callback containment", () => {
  it("startNodeServer refuses unknown option keys (typo guard parity)", () => {
    const app = new Keala(quiet);
    expect(() => startNodeServer(app, { port: 0, idleTimout: 99 } as never)).toThrow(
      /unknown option/,
    );
    expect(() => startNodeServer(app, { port: 0 })).not.toThrow();
  });

  it("a throwing onListen callback never becomes an uncaughtException", async () => {
    const app = new Keala(quiet);
    app.get("/x", (c) => c.text("ok"));
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args[0]);
    };
    let server: NodeServerHandle | undefined;
    try {
      server = await listen(app, { port: 0, hostname: "127.0.0.1" }, undefined, () => {
        throw new Error("cb-boom");
      }).ready();
      const res = await fetch(`http://127.0.0.1:${server?.port ?? -1}/x`);
      expect([res.status, await res.text()]).toEqual([200, "ok"]);
      expect(errors.length).toBeGreaterThan(0);
    } finally {
      console.error = original;
      server?.stop(true);
    }
  });
});
