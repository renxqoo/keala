import { describe, expect, it, vi } from "vitest";
// globalThis.Bun is non-writable AND non-configurable on the real Bun
// runtime — these suites stub it, so they run on the Node gate only (the
// real-runtime equivalents live in scripts/smoke.ts).
const REAL_BUN = typeof Bun !== "undefined";

import { Eleu, startBunServer, type ServeImplementation } from "../src/index.ts";

// Bun's real server handle shape: `reload` is the actual hot-reload API (the
// old `update()` was fictional and has been removed from ServerHandle).
const fakeServe = (): {
  impl: ServeImplementation;
  options: () => Record<string, unknown>;
  stopped: () => boolean;
} => {
  let captured: Record<string, unknown> = {};
  let isStopped = false;
  const impl: ServeImplementation = (options) => {
    captured = options;
    return {
      port: (options["port"] as number) ?? 0,
      hostname: (options["hostname"] as string) ?? "localhost",
      stop: () => {
        isStopped = true;
      },
      fetch: () => new Response("fake"),
      reload: () => {},
    };
  };
  return { impl, options: () => captured, stopped: () => isStopped };
};

describe("startBunServer", () => {
  it("wires app.handle into the serve fetch handler and passes the server handle through the runtime so c.ip resolves", async () => {
    const app = new Eleu();
    app.use(async (c) => {
      c.body = { ip: c.ip, url: c.url };
    });
    const { impl, options } = fakeServe();
    startBunServer(app, { port: 4123 }, undefined, impl);

    const opts = options();
    expect(opts["port"]).toBe(4123);
    expect(typeof opts["fetch"]).toBe("function");
    const fetch = opts["fetch"] as (
      request: Request,
      server: { requestIP(request: Request): { address: string } | null },
    ) => Promise<Response>;
    const res = await fetch(new Request("http://localhost:4123/hello"), {
      requestIP: () => ({ address: "10.1.2.3" }),
    });
    expect(await res.json()).toEqual({ ip: "10.1.2.3", url: "/hello" });
  });

  it("passes through listen options", () => {
    const app = new Eleu();
    const { impl, options } = fakeServe();
    startBunServer(
      app,
      {
        port: 8080,
        hostname: "0.0.0.0",
        reusePort: true,
        idleTimeout: 30,
        maxRequestBodySize: 1024,
        development: false,
      },
      undefined,
      impl,
    );
    const opts = options();
    expect(opts["hostname"]).toBe("0.0.0.0");
    expect(opts["reusePort"]).toBe(true);
    expect(opts["idleTimeout"]).toBe(30);
    expect(opts["maxRequestBodySize"]).toBe(1024);
    expect(opts["development"]).toBe(false);
  });

  it("handles null requestIP results", async () => {
    const app = new Eleu();
    app.use(async (c) => {
      c.body = c.ip;
    });
    const { impl, options } = fakeServe();
    startBunServer(app, {}, undefined, impl);
    const fetch = options()["fetch"] as (
      request: Request,
      server: { requestIP(request: Request): { address: string } | null },
    ) => Promise<Response>;
    const res = await fetch(new Request("http://localhost/"), { requestIP: () => null });
    expect(await res.text()).toBe("");
  });

  it("notifies via onListen after boot", async () => {
    const app = new Eleu();
    const onListen = vi.fn();
    const { impl } = fakeServe();
    startBunServer(app, { port: 0 }, onListen, impl);
    await new Promise((resolve) => queueMicrotask(resolve));
    expect(onListen).toHaveBeenCalledTimes(1);
  });

  it("defaults to port 3000", () => {
    const app = new Eleu();
    const { impl, options } = fakeServe();
    startBunServer(app, {}, undefined, impl);
    expect(options()["port"]).toBe(3000);
  });

  it.skipIf(REAL_BUN)("throws a clear error without Bun and no injected implementation", () => {
    const app = new Eleu();
    const realBun = (globalThis as { Bun?: unknown }).Bun;
    delete (globalThis as { Bun?: unknown }).Bun;
    try {
      expect(() => startBunServer(app, { port: 3000 })).toThrow(/Bun\.serve/);
    } finally {
      if (realBun !== undefined) (globalThis as { Bun?: unknown }).Bun = realBun;
    }
  });

  it("exposes stop on the returned handle", () => {
    const app = new Eleu();
    const { impl, stopped } = fakeServe();
    const server = startBunServer(app, {}, undefined, impl);
    expect(typeof server.stop).toBe("function");
    expect(typeof server.reload).toBe("function");
    server.stop();
    expect(stopped()).toBe(true);
  });

  it("wires a default serve error handler that routes through app.onerror", async () => {
    const errors: Error[] = [];
    const app = new Eleu();
    app.onError((err) => errors.push(err));
    const { impl, options } = fakeServe();
    startBunServer(app, {}, undefined, impl);
    const onError = options()["error"] as (error: Error) => Response;
    const boom = new Error("stream exploded");
    const res = onError(boom);
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Internal Server Error");
    expect(errors).toEqual([boom]);
  });

  it("a throwing error listener never breaks the serve error callback", async () => {
    const app = new Eleu();
    app.onError(() => {
      throw new Error("listener bug");
    });
    const { impl, options } = fakeServe();
    startBunServer(app, {}, undefined, impl);
    const res = (options()["error"] as (error: Error) => Response)(new Error("x"));
    expect(res.status).toBe(500);
  });

  it("honors a custom onServeError", async () => {
    const app = new Eleu();
    const { impl, options } = fakeServe();
    startBunServer(
      app,
      { onServeError: () => new Response("boom", { status: 599 }) },
      undefined,
      impl,
    );
    const res = (options()["error"] as (error: Error) => Response)(new Error("x"));
    expect(res.status).toBe(599);
    expect(await res.text()).toBe("boom");
  });

  it("dispatches websocket error events to the owning route", async () => {
    const app = new Eleu();
    const seen: Array<{ code: unknown; ctx: unknown }> = [];
    app.ws("/chat", {
      error: (ws, err, c) => {
        seen.push({ code: err, ctx: (c as { path: string }).path });
        void ws;
      },
    });
    const { impl, options } = fakeServe();
    startBunServer(app, {}, undefined, impl);
    const wsHandlers = options()["websocket"] as Record<
      string,
      (ws: unknown, ...rest: unknown[]) => void
    >;
    const error = wsHandlers["error"] as (ws: unknown, err: Error) => void;
    error({ data: { wsKey: "/chat", ctx: { path: "/chat" } } }, new Error("socket died"));
    await new Promise((r) => setTimeout(r, 0)); // handlers dispatch on a microtask
    expect(seen).toEqual([{ code: new Error("socket died"), ctx: "/chat" }]);
  });

  it("websocket error for an unknown route data key is a no-op", () => {
    const app = new Eleu();
    app.ws("/chat", {
      error: () => {
        throw new Error("must not run");
      },
    });
    const { impl, options } = fakeServe();
    startBunServer(app, {}, undefined, impl);
    const wsHandlers = options()["websocket"] as Record<string, (ws: unknown) => void>;
    expect(() =>
      (wsHandlers["error"] as (ws: unknown, err: Error) => void)(
        { data: { wsKey: "/nope" } },
        new Error("x"),
      ),
    ).not.toThrow();
  });
});

describe.skipIf(REAL_BUN)("app.listen argument parsing", () => {
  const { impl } = fakeServe();
  const originalBun = (globalThis as { Bun?: unknown }).Bun;

  it("accepts (port), (port, cb), ({port, hostname}) and string ports", async () => {
    (globalThis as { Bun?: unknown }).Bun = { serve: impl };
    try {
      const app = new Eleu();
      const a = app.listen(3001);
      expect(a.port).toBe(3001);

      const app2 = new Eleu();
      let listened = false;
      const handle = app2.listen("3002", () => {
        listened = true;
      });
      await new Promise((resolve) => queueMicrotask(resolve));
      expect(handle.port).toBe(3002);
      expect(listened).toBe(true);

      const app3 = new Eleu();
      const handle3 = app3.listen({ port: 3003, hostname: "127.0.0.1" });
      expect(handle3.port).toBe(3003);
      expect(handle3.hostname).toBe("127.0.0.1");

      const app5 = new Eleu();
      const handle5 = app5.listen(0);
      expect(handle5.port).toBe(0);
    } finally {
      if (originalBun === undefined) delete (globalThis as { Bun?: unknown }).Bun;
      else (globalThis as { Bun?: unknown }).Bun = originalBun;
    }
  });
});
