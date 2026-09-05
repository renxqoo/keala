import { describe, expect, it, vi } from "vitest";

import { mergeMountedWs } from "../../src/core/registration.ts";
import { parseListenArgs } from "../../src/core/listen.ts";
import { createRouterState, registerDef } from "../../src/router/router.ts";
import { EMPTY_MIDDLEWARE_STACK } from "../../src/core/middleware-stack.ts";
import { Keala } from "../../src/core/app.ts";
import { Router } from "../../src/router/group.ts";
import { typeIs } from "../../src/negotiation/typeis.ts";
import { startBunServer, type ServerHandle } from "../../src/adapters/bun.ts";
/**
 * Registration/parse guards extracted from agent-r5-runtime-locks for its
 * 500-line budget: the mergeMountedWs missing-handlers refusal and the full
 * parseListenArgs option-bag coverage.
 */

describe("listen and mount guards", () => {
  it("mergeMountedWs refuses a def whose ws handlers are missing", () => {
    const state = createRouterState();
    const def = registerDef(state, "GET", "/ws", [() => undefined]);
    def.wsKey = "/old-key";
    // A ws def whose key is absent from the handlers map would silently
    // register an upgrade that can never find its socket handlers.
    expect(() =>
      mergeMountedWs(new Map(), state, "/prefix", [], def, EMPTY_MIDDLEWARE_STACK, new Map()),
    ).toThrow(/no ws handlers found/);
  });

  it("parseListenArgs covers the full option bag", () => {
    const full = parseListenArgs([
      {
        port: 1,
        reusePort: true,
        maxRequestBodySize: 4096,
        development: true,
        onServeError: () => undefined,
      },
    ]);
    expect(full.listen.port).toBe(1);
    expect(full.listen.reusePort).toBe(true);
    expect(full.listen.maxRequestBodySize).toBe(4096);
    expect(full.listen.development).toBe(true);
    expect(typeof full.listen.onServeError).toBe("function");
  });

  it("parseListenArgs accepts positional args, numeric strings and extra bag keys", () => {
    const onListen = () => {};
    const parsed = parseListenArgs([3000, "0.0.0.0", onListen]);
    expect(parsed.listen.port).toBe(3000);
    expect(parsed.hostname).toBe("0.0.0.0");
    expect(parsed.onListen).toBe(onListen);
    expect(parseListenArgs(["8080"]).listen.port).toBe(8080);
    const bag = parseListenArgs([
      { port: 99, hostname: "h", idleTimeout: 9, nativeRoutes: false, websocket: true },
    ]);
    expect(bag.listen.port).toBe(99);
    expect(bag.hostname).toBe("h");
    expect(bag.listen.idleTimeout).toBe(9);
    expect(bag.listen.nativeRoutes).toBe(false);
    expect(bag.listen.websocket).toBe(true);
  });
});

/**
 * Branch-coverage completion for the core: the shortcut verbs, mount
 * parameter merging, callback alias, listen parsing, emitter disposal, and
 * typeis wildcard shorthands.
 */

// globalThis.Bun is non-writable AND non-configurable on the real Bun
// runtime — these suites stub it, so they run on the Node gate only (the
// real-runtime equivalents live in scripts/smoke.ts).
const REAL_BUN = typeof Bun !== "undefined";

const quiet = { env: "test" } as const;
const req = (path: string, init?: RequestInit) => new Request(`http://localhost:3000${path}`, init);

describe("coverage: every method shortcut registers a working route", () => {
  it.each(["get", "post", "put", "patch", "delete", "head", "options"] as const)(
    "app.%s routes its method",
    async (verb) => {
      const app = new Keala(quiet);
      app[verb]("/x", (c) => c.text("hit"));
      const res = await app.handle(req("/x", { method: verb.toUpperCase() }));
      expect(res.status).toBe(200);
    },
  );

  it("the named two-argument form registers under the name", async () => {
    const app = new Keala(quiet);
    app.get("thing", "/things/:id", (c) => c.text(c.params["id"] ?? ""));
    expect(app.url("thing", { id: "9" })).toBe("/things/9");
    expect(await (await app.handle(req("/things/9"))).text()).toBe("9");
  });

  it("routeShortcut rejects malformed registrations", () => {
    const app = new Keala(quiet);
    expect(() => app.get(42 as unknown as string, () => undefined)).toThrow(/path string/);
    expect(() => app.get("/x", null as unknown as () => void)).toThrow(/at least one handler/);
  });
});

describe("coverage: mount parameter middleware merge", () => {
  it("a later mount does not clobber an existing param middleware", async () => {
    const app = new Keala(quiet);
    app.param("id", async (c, next) => {
      c.setHeader("X-App", "1");
      await next();
    });
    const other = new Router();
    other.param("id", () => {
      throw new Error("must not replace the app-level middleware");
    });
    other.get("/z/:id", (c) => c.text("z"));
    app.mount("/o", other);
    const res = await app.handle(req("/o/z/1"));
    expect(res.headers.get("x-app")).toBe("1");
    expect(await res.text()).toBe("z");
  });
});

describe("coverage: listen argument parsing", () => {
  const serveImpl = (options: Record<string, unknown>): ServerHandle => ({
    port: options["port"] as number,
    hostname: "127.0.0.1",
    stop: () => undefined,
    fetch: async () => new Response("x"),
    reload: () => undefined,
  });

  it.skipIf(REAL_BUN)("accepts numeric string ports, hostnames and option objects", () => {
    const made: Record<string, unknown>[] = [];
    const impl = (options: Record<string, unknown>): ServerHandle => {
      made.push(options);
      return serveImpl(options);
    };
    const app = new Keala(quiet);
    // inject a fake Bun.serve so listen() runs its full parsing path
    (globalThis as { Bun?: unknown }).Bun = { serve: impl };
    try {
      app.listen("4321", "example.com");
      const second = new Keala(quiet);
      second.listen(4322);
      const third = new Keala(quiet);
      third.listen({
        port: 4323,
        hostname: "h",
        reusePort: true,
        idleTimeout: 30,
        development: false,
        maxRequestBodySize: 1024,
      });
    } finally {
      delete (globalThis as { Bun?: unknown }).Bun;
    }
    expect(made[0]?.["hostname"]).toBe("example.com");
    expect(made[0]?.["port"]).toBe(4321);
    expect(made[2]?.["port"]).toBe(4323);
    expect(made[2]?.["reusePort"]).toBe(true);
    expect(made[2]?.["idleTimeout"]).toBe(30);
    expect(made[2]?.["maxRequestBodySize"]).toBe(1024);
    expect(made[2]?.["development"]).toBe(false);
  });
});

describe("coverage: typeis wildcard shorthands", () => {
  it(".ext matches by extension suffix and +suffix", () => {
    expect(typeIs("image/svg+xml", [".xml"])).toBe(".xml");
    expect(typeIs("text/x-svg/svg", [".svg"])).toBe(".svg");
    // no candidate matches -> false (null is reserved for absent content-type)
    expect(typeIs("application/octet-stream", [".stream"])).toBe(false);
  });

  it("*/subtype matches any type with that subtype", () => {
    expect(typeIs("image/png", ["*/png"])).toBe("*/png");
    expect(typeIs("image/jpeg", ["*/png"])).toBe(false);
  });

  it("plain and mismatched types behave", () => {
    expect(typeIs("text/html", ["html"])).toBe("html");
    expect(typeIs("text/html", ["json"])).toBe(false);
    expect(typeIs(null, ["html"])).toBeNull();
  });
});

describe("coverage: startBunServer error listener", () => {
  it("wires onListen through a microtask", async () => {
    const heard = vi.fn();
    const app = new Keala(quiet);
    startBunServer(app, { port: 0 }, heard, () => ({
      port: 0,
      hostname: "x",
      stop: () => undefined,
      fetch: async () => new Response("x"),
      reload: () => undefined,
    }));
    await Promise.resolve();
    expect(heard).toHaveBeenCalledTimes(1);
  });
});
