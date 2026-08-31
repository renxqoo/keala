/**
 * nativeSink tests: sink guards (loud refusals), the JS mirror semantics
 * (portable across runtimes), and the adapter's native routes table.
 */

import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// globalThis.Bun is non-writable AND non-configurable on the real Bun
// runtime — these suites stub it, so they run on the Node gate only (the
// real-runtime equivalents live in scripts/smoke.ts).
const REAL_BUN = typeof Bun !== "undefined";

import { Honu, startBunServer, type ServeImplementation } from "../src/index.ts";
import { buildNativeRoutes } from "../src/core/sink.ts";

const quiet = { env: "test" } as const;
const req = (path: string, init?: RequestInit) => new Request(`http://localhost:3000${path}`, init);

let root = "";
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "bk-sink-"));
  await writeFile(join(root, "app.js"), "console.log(1)");
  await writeFile(join(root, "index.html"), "<h1>i</h1>");
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("sink: guard matrix (every refusal is loud)", () => {
  it("rejects non-absolute and empty paths", () => {
    const app = new Honu(quiet);
    expect(() => app.sink("health", new Response("ok"))).toThrow(/absolute path/);
    expect(() => app.sink("", new Response("ok"))).toThrow(/absolute path/);
  });

  it("rejects values that are neither Response nor { dir }", () => {
    const app = new Honu(quiet);
    // @ts-expect-error -- runtime contract check for JS callers
    expect(() => app.sink("/health", "ok")).toThrow(/Response or \{ dir \}/);
  });

  it("rejects duplicate sinks of the same path", () => {
    const app = new Honu(quiet);
    app.sink("/health", new Response("ok"));
    expect(() => app.sink("/health", new Response("again"))).toThrow(/already registered/);
  });

  it("rejects static sinks on param/wildcard paths", () => {
    const app = new Honu(quiet);
    expect(() => app.sink("/users/:id", new Response("ok"))).toThrow(/plain paths/);
    expect(() => app.sink("/assets/*", new Response("ok"))).toThrow(/plain paths/);
  });

  it("rejects dir sinks without a /* suffix and empty dir values", () => {
    const app = new Honu(quiet);
    expect(() => app.sink("/assets", { dir: root })).toThrow(/\/\*/);
    expect(() => app.sink("/assets/*", { dir: "" })).toThrow(/directory path/);
  });

  it("rejects sinking when global middleware exists (it would be bypassed)", () => {
    const app = new Honu(quiet);
    app.use((_c, next) => next());
    expect(() => app.sink("/health", new Response("ok"))).toThrow(/without global middleware/);
  });

  it("rejects app.use(fn) after a sink exists (ordering invariants are bidirectional)", () => {
    const app = new Honu(quiet);
    app.sink("/health", new Response("ok"));
    expect(() => app.use((_c, next) => next())).toThrow(/bypasses global middleware/);
  });

  it("rejects app.param() after a sink exists", () => {
    const app = new Honu(quiet);
    app.sink("/health", new Response("ok"));
    expect(() => app.param("id", (_c, next) => next())).toThrow(/bypasses param middleware/);
  });

  it("rejects sinking when param middleware exists", () => {
    const app = new Honu(quiet);
    app.param("id", (_c, next) => next());
    expect(() => app.sink("/users/1", new Response("ok"))).toThrow(/without param middleware/);
  });

  it("rejects a sink overlapping an existing JS route (both directions)", () => {
    const direct = new Honu(quiet);
    direct.get("/health", (c) => c.text("js"));
    expect(() => direct.sink("/health", new Response("native"))).toThrow(/overlaps/);

    const subtree = new Honu(quiet);
    subtree.get("/assets/logo.png", (c) => c.text("js"));
    expect(() => subtree.sink("/assets/*", { dir: root })).toThrow(/overlaps/);
  });

  it("rejects JS routes registered AFTER a sink (native table would shadow them)", () => {
    const app = new Honu(quiet);
    app.sink("/health", new Response("ok"));
    expect(() => app.get("/health", (c) => c.text("js"))).toThrow(/natively-sunk/);
    // A deeper path is a different route — no shadowing, no refusal.
    expect(() => app.get("/health/x", (_c) => undefined)).not.toThrow();
    expect(() => app.ws("/health", { open: () => undefined })).toThrow(/natively-sunk/);
  });

  it("rejects mount() introducing param middleware alongside sinks", () => {
    const sub = new Honu(quiet);
    sub.param("id", (_c, next) => next());
    sub.get("/x/:id", (c) => c.text("x"));
    const app = new Honu(quiet);
    app.sink("/health", new Response("ok"));
    expect(() => app.mount("/m", sub)).toThrow(/param middleware alongside sunk/);

    const clean = new Honu(quiet);
    clean.get("/y", (c) => c.text("y"));
    expect(() => app.mount("/n", clean)).not.toThrow();
  });

  it("a 205 null-body sunk response survives the rebuild", async () => {
    const app = new Honu(quiet);
    app.sink("/reset", new Response(null, { status: 205 }));
    const res = await app.handle(req("/reset"));
    expect(res.status).toBe(205);
    expect(await res.text()).toBe("");
  });

  it("sibling subtrees and unrelated paths never conflict", () => {
    const app = new Honu(quiet);
    app.sink("/health", new Response("ok"));
    app.get("/users/:id", (c) => c.text("u"));
    app.sink("/assets/*", { dir: root });
    app.get("/assetx", (c) => c.text("x"));
    expect(app.stack.length).toBeGreaterThan(0);
  });
});

describe("sink: JS mirror (runtime-portable serving)", () => {
  it("serves the sunk response body, status and headers repeatedly", async () => {
    const app = new Honu(quiet);
    app.sink("/health", new Response("ok", { status: 200, headers: { "x-sunk": "yes" } }));
    for (let i = 0; i < 3; i++) {
      const res = await app.handle(req("/health"));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
      expect(res.headers.get("x-sunk")).toBe("yes");
    }
  });

  it("HEAD reuses the GET mirror (empty body, same status)", async () => {
    const app = new Honu(quiet);
    app.sink("/health", new Response("ok"));
    const res = await app.handle(new Request("http://localhost:3000/health", { method: "HEAD" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("non-GET methods answer 405 with the allowed set", async () => {
    const app = new Honu(quiet);
    app.sink("/health", new Response("ok"));
    const res = await app.handle(new Request("http://localhost:3000/health", { method: "POST" }));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toContain("GET");
  });

  it("a null-body (204) sunk response survives the rebuild", async () => {
    const app = new Honu(quiet);
    app.sink("/noop", new Response(null, { status: 204 }));
    const res = await app.handle(req("/noop"));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("multi-value headers (Set-Cookie) survive the rebuild", async () => {
    const headers = new Headers();
    headers.append("set-cookie", "a=1");
    headers.append("set-cookie", "b=2");
    const app = new Honu(quiet);
    app.sink("/sweet", new Response("ok", { headers }));
    const res = await app.handle(req("/sweet"));
    expect(res.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
  });

  it("the sunk Response instance stays unconsumed for the native table", async () => {
    const response = new Response("precious");
    const app = new Honu(quiet);
    app.sink("/health", response);
    await app.handle(req("/health"));
    // The native table reuses THIS instance; a consumed body would 500 there.
    expect(await response.text()).toBe("precious");
  });

  it("dir sinks mirror to serveStatic semantics (index, 404, traversal denial)", async () => {
    const app = new Honu(quiet);
    app.sink("/assets/*", { dir: root });
    expect((await app.handle(req("/assets/app.js"))).status).toBe(200);
    expect((await app.handle(req("/assets/"))).status).toBe(200); // index.html
    expect((await app.handle(req("/assets/missing.js"))).status).toBe(404);
    const escape = await app.handle(req("/assets/..%2f..%2fetc%2fpasswd"));
    expect([403, 404]).toContain(escape.status);
  });
});

describe("sink: native routes table (adapter)", () => {
  const fakeServe = (captured: { options: Record<string, unknown> }): ServeImplementation => {
    return (_options) => {
      captured.options = _options;
      return {
        port: 0,
        hostname: "localhost",
        stop: () => undefined,
        fetch: () => new Response("fake"),
        reload: () => undefined,
      };
    };
  };

  it("builds the table with Response entries and {dir} entries", () => {
    const app = new Honu(quiet);
    const health = new Response("ok");
    app.sink("/health", health);
    app.sink("/assets/*", { dir: root });
    const routes = buildNativeRoutes(app.nativeSinks);
    // Method-scoped: a bare key would answer POST with the sunk response
    // (verified against Bun 1.4) while the JS mirror answers 405.
    expect(routes["/health"]).toEqual({ GET: health });
    expect(routes["/assets/*"]).toEqual({ GET: { dir: root } });
  });

  it("startBunServer embeds the routes table and honors nativeRoutes: false", () => {
    const app = new Honu(quiet);
    app.sink("/health", new Response("ok"));

    const withTable: { options: Record<string, unknown> } = { options: {} };
    startBunServer(app, { port: 0 }, undefined, fakeServe(withTable));
    expect((withTable.options["routes"] as Record<string, unknown>)["/health"]).toBeDefined();

    const withoutTable: { options: Record<string, unknown> } = { options: {} };
    startBunServer(app, { port: 0, nativeRoutes: false }, undefined, fakeServe(withoutTable));
    expect(withoutTable.options["routes"]).toBeUndefined();
  });

  it("an app without sinks gets no routes key", () => {
    const app = new Honu(quiet);
    app.get("/x", (c) => c.text("x"));
    const captured: { options: Record<string, unknown> } = { options: {} };
    startBunServer(app, { port: 0 }, undefined, fakeServe(captured));
    expect(captured.options["routes"]).toBeUndefined();
  });

  it("reloadNativeRoutes throws before listen()", () => {
    const app = new Honu(quiet);
    app.sink("/health", new Response("ok"));
    expect(() => app.reloadNativeRoutes()).toThrow(/app\.listen/);
  });

  it.skipIf(REAL_BUN)(
    "sinking after listen() hot-reloads the table; reloadNativeRoutes works",
    async () => {
      const originalBun = (globalThis as { Bun?: unknown }).Bun;
      const reloads: unknown[] = [];
      const impl: ServeImplementation = (_options) => {
        return {
          port: 0,
          hostname: "localhost",
          stop: () => undefined,
          fetch: () => new Response("fake"),
          reload: (next) => reloads.push(next),
        };
      };
      (globalThis as { Bun?: unknown }).Bun = { serve: impl };
      try {
        const app = new Honu(quiet);
        const server = app.listen(0);
        expect(reloads.length).toBe(0);
        app.sink("/health", new Response("ok"));
        expect(reloads.length).toBe(1);
        expect((reloads[0] as Record<string, unknown>)["routes"]).toBeDefined();
        app.reloadNativeRoutes();
        expect(reloads.length).toBe(2);
        server.stop();

        // The opt-out is sticky: sinks after listen({nativeRoutes: false})
        // must NOT silently install a native table later.
        const optOut = new Honu(quiet);
        const optServer = optOut.listen({ port: 0, nativeRoutes: false });
        optOut.sink("/ping", new Response("pong"));
        expect(reloads.length).toBe(2); // no new reload
        expect(() => optOut.reloadNativeRoutes()).toThrow(/nativeRoutes: false/);
        expect((await optOut.handle(req("/ping"))).status).toBe(200); // JS mirror still serves
        optServer.stop();
      } finally {
        if (originalBun === undefined) delete (globalThis as { Bun?: unknown }).Bun;
        else (globalThis as { Bun?: unknown }).Bun = originalBun;
      }
    },
  );
});
