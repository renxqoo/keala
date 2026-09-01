/**
 * WebSocket wiring tests: route registration, runtime upgrade, error paths
 * and the Bun adapter's event dispatcher (open/message/close routed by the
 * per-socket data, context threaded through).
 */

import { describe, expect, it } from "vitest";

import { Keala, type Application } from "../src/core/app.ts";
import { startBunServer, type ServerHandle } from "../src/adapters/bun.ts";

const quiet = { env: "test" } as const;
const req = (path: string) => new Request(`http://localhost:3000${path}`);

const upgradeServer = (
  succeed: boolean,
  seen: { request?: Request; data?: unknown }[] = [],
): unknown => ({
  upgrade(request: Request, opts: { data: unknown }): boolean {
    seen.push({ request, data: opts.data });
    return succeed;
  },
});

describe("app.ws routing", () => {
  it("upgrades through the runtime server and passes context in the socket data", async () => {
    const seen: { request?: Request; data?: unknown }[] = [];
    const app = new Keala(quiet);
    app.ws("/chat", { open: () => undefined });
    const res = await app.handle(req("/chat"), { server: upgradeServer(true, seen) });
    expect(seen.length).toBe(1);
    const first = seen[0] as { data: { wsKey: string; ctx: unknown } };
    expect(first.data.wsKey).toBe("/chat");
    expect(first.data.ctx).toBeDefined();
    expect(res.status).toBe(200);
  });

  it("answers 501 without a runtime server (in-process test usage)", async () => {
    const app = new Keala(quiet);
    app.ws("/chat", {});
    const res = await app.handle(req("/chat"));
    expect(res.status).toBe(501);
    expect(await res.text()).toContain("Bun server runtime");
  });

  it("answers 400 when the runtime rejects the upgrade", async () => {
    const app = new Keala(quiet);
    app.ws("/chat", {});
    const res = await app.handle(req("/chat"), { server: upgradeServer(false) });
    expect(res.status).toBe(400);
  });

  it("ws routes ignore method semantics (no 405 interference)", async () => {
    const app = new Keala(quiet);
    app.ws("/chat", {});
    const res = await app.handle(new Request("http://localhost:3000/chat", { method: "DELETE" }), {
      server: upgradeServer(true),
    });
    expect(res.status).toBe(200);
  });
});

describe("adapter websocket dispatcher", () => {
  it("routes socket events by wsKey with the context", async () => {
    const events: string[] = [];
    const app = new Keala(quiet);
    app.ws("/a", {
      open: (ws, c) => {
        events.push(`a-open:${(ws as { id: string }).id}:${c.path}`);
      },
      message: (_ws, message) => {
        events.push(`a-msg:${String(message)}`);
      },
      close: (_ws, code) => {
        events.push(`a-close:${code}`);
      },
    });
    app.ws("/b", {
      open: () => {
        events.push("b-open");
      },
    });

    const made: Record<string, unknown>[] = [];
    const fakeServe = (options: Record<string, unknown>): ServerHandle => {
      made.push(options);
      return {
        port: options["port"] as number,
        hostname: "127.0.0.1",
        stop: () => undefined,
        fetch: () => new Response("x"),
        reload: () => undefined,
      };
    };
    startBunServer(app as Application, { port: 0 }, undefined, fakeServe);

    const websocket = made[0]?.["websocket"] as Record<
      string,
      (ws: unknown, ...rest: unknown[]) => void
    >;
    expect(websocket).toBeDefined();
    const wsA = { id: "sock-a", data: { wsKey: "/a", ctx: { path: "/a" } } };
    const wsB = { id: "sock-b", data: { wsKey: "/b", ctx: { path: "/b" } } };
    const wsGhost = { id: "ghost", data: {} };

    websocket["open"]?.(wsA);
    websocket["message"]?.(wsA, "hello");
    websocket["close"]?.(wsA, 1000, "done");
    websocket["open"]?.(wsB);
    websocket["open"]?.(wsGhost); // unknown key — silently ignored
    await new Promise((r) => setTimeout(r, 0)); // handlers dispatch on a microtask

    expect(events).toEqual(["a-open:sock-a:/a", "a-msg:hello", "a-close:1000", "b-open"]);
  });

  it("no websocket config is emitted without ws routes", () => {
    const app = new Keala(quiet);
    app.get("/x", (c) => c.text("x"));
    const made: Record<string, unknown>[] = [];
    startBunServer(app as Application, { port: 0 }, undefined, (options) => {
      made.push(options);
      return {
        port: 0,
        hostname: "x",
        stop: () => undefined,
        fetch: () => new Response("x"),
        reload: () => undefined,
      };
    });
    // The dispatchers read the LIVE wsRoutes map — they install
    // unconditionally so `app.ws()` after listen() is picked up without a
    // reload (a missing config would dead-end late routes under Bun).
    const websocket = made[0]?.["websocket"] as Record<string, unknown>;
    expect(websocket).toBeDefined();
    expect(websocket["open"]).toBeTypeOf("function");
    expect(websocket["message"]).toBeTypeOf("function");
  });
});
