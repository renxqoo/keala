/**
 * Branch-coverage completion for the core: the shortcut verbs, mount
 * parameter merging, callback alias, listen parsing, emitter disposal, and
 * typeis wildcard shorthands.
 */

import { describe, expect, it, vi } from "vitest";

// globalThis.Bun is non-writable AND non-configurable on the real Bun
// runtime — these suites stub it, so they run on the Node gate only (the
// real-runtime equivalents live in scripts/smoke.ts).
const REAL_BUN = typeof Bun !== "undefined";

import { createApp } from "../src/core/app.ts";
import { createRouter } from "../src/router/group.ts";
import { createEmitter } from "../src/core/emitter.ts";
import { typeIs } from "../src/negotiation/typeis.ts";
import { startBunServer, type ServerHandle } from "../src/adapters/bun.ts";

const quiet = { env: "test" } as const;
const req = (path: string, init?: RequestInit) => new Request(`http://localhost:3000${path}`, init);

describe("coverage: every method shortcut registers a working route", () => {
  it.each(["get", "post", "put", "patch", "delete", "head", "options"] as const)(
    "app.%s routes its method",
    async (verb) => {
      const app = createApp(quiet);
      app[verb]("/x", (c) => c.text("hit"));
      const res = await app.handle(req("/x", { method: verb.toUpperCase() }));
      expect(res.status).toBe(200);
    },
  );

  it("the named two-argument form registers under the name", async () => {
    const app = createApp(quiet);
    app.get("thing", "/things/:id", (c) => c.text(c.params?.["id"] ?? ""));
    expect(app.url("thing", { id: "9" })).toBe("/things/9");
    expect(await (await app.handle(req("/things/9"))).text()).toBe("9");
  });

  it("routeShortcut rejects malformed registrations", () => {
    const app = createApp(quiet);
    expect(() => app.get(42 as unknown as string, () => undefined)).toThrow(/path string/);
    expect(() => app.get("/x", null as unknown as () => void)).toThrow(/at least one handler/);
  });
});

describe("coverage: mount parameter middleware merge", () => {
  it("a later mount does not clobber an existing param middleware", async () => {
    const app = createApp(quiet);
    app.param("id", async (c, next) => {
      c.set("X-App", "1");
      await next();
    });
    const other = createRouter();
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
    fetch: () => new Response("x"),
    reload: () => undefined,
  });

  it.skipIf(REAL_BUN)("accepts numeric string ports, hostnames and option objects", () => {
    const made: Record<string, unknown>[] = [];
    const impl = (options: Record<string, unknown>): ServerHandle => {
      made.push(options);
      return serveImpl(options);
    };
    const app = createApp(quiet);
    // inject a fake Bun.serve so listen() runs its full parsing path
    (globalThis as { Bun?: unknown }).Bun = { serve: impl };
    try {
      app.listen("4321", "example.com");
      app.listen(4322);
      app.listen({
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

describe("coverage: emitter disposal paths", () => {
  it("disposal is idempotent and off() tolerates unknown listeners", () => {
    const emitter = createEmitter();
    const heard: number[] = [];
    const dispose = emitter.on("x", () => heard.push(1));
    emitter.off("x", () => undefined); // unknown listener — no-op
    emitter.off("ghost", () => undefined); // unknown event — no-op
    dispose();
    dispose(); // second call — no-op
    expect(emitter.emit("x")).toBe(false);
    expect(emitter.listenerCount("x")).toBe(0);
  });

  it("once() fires exactly once even when manually disposed after firing", () => {
    const emitter = createEmitter();
    let hits = 0;
    emitter.once("go", () => {
      hits += 1;
    });
    expect(emitter.emit("go")).toBe(true);
    expect(emitter.emit("go")).toBe(false);
    expect(hits).toBe(1);
  });

  it("emit copies the listener list (unsubscribe during emit is safe)", () => {
    const emitter = createEmitter();
    const seen: string[] = [];
    // a runs first and disposes b; the iteration copy still delivers b.
    let disposeB: () => void = () => undefined;
    emitter.on("e", () => {
      seen.push("a");
      disposeB();
    });
    disposeB = emitter.on("e", () => seen.push("b"));
    emitter.emit("e");
    expect(seen).toEqual(["a", "b"]);
    expect(emitter.listenerCount("e")).toBe(1);
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
    const app = createApp(quiet);
    startBunServer(app, { port: 0 }, heard, () => ({
      port: 0,
      hostname: "x",
      stop: () => undefined,
      fetch: () => new Response("x"),
      reload: () => undefined,
    }));
    await Promise.resolve();
    expect(heard).toHaveBeenCalledTimes(1);
  });
});
