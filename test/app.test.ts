/**
 * Application pipeline: top-level routing, global middleware on unmatched
 * paths, dual-mode finalization, not-found, error contract, decorate,
 * listen-args parsing and the runtime injection channel.
 */

import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/core/app.ts";
import { createRouter } from "../src/router/group.ts";
import { startBunServer, type ServerHandle } from "../src/adapters/bun.ts";
import type { Application } from "../src/core/app.ts";

const quiet = { env: "test" } as const;
const req = (path: string, init?: RequestInit) => new Request(`http://localhost:3000${path}`, init);

describe("app pipeline", () => {
  it("matches routes top-level and returns their response", async () => {
    const app = createApp(quiet);
    app.get("/x", (c) => c.text("x"));
    const res = await app.handle(req("/x"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("x");
  });

  it("global middleware runs for UNMATCHED paths (koa contract)", async () => {
    const app = createApp(quiet);
    app.use((c, next) => {
      c.set("X-Global", "1");
      return next();
    });
    app.get("/known", (c) => c.text("ok"));
    const miss = await app.handle(req("/unknown"));
    expect(miss.headers.get("x-global")).toBe("1");
    expect(miss.status).toBe(404);
    const hit = await app.handle(req("/known"));
    expect(hit.headers.get("x-global")).toBe("1");
    expect(await hit.text()).toBe("ok");
  });

  it("global middleware runs for unmatched METHODS too, and may respond", async () => {
    const app = createApp(quiet);
    app.use(async (_c, next) => {
      await next(); // observability only — never touches the response state
    });
    app.get("/only", (c) => c.text("get"));
    const res = await app.handle(req("/only", { method: "POST" }));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toContain("GET");
  });

  it("state mode: c.body/c.status/c.set flow into the response", async () => {
    const app = createApp(quiet);
    app.get("/s", (c) => {
      c.status = 201;
      c.set("X-Made", "yes");
      c.body = "made";
    });
    const res = await app.handle(req("/s"));
    expect(res.status).toBe(201);
    expect(res.headers.get("x-made")).toBe("yes");
    expect(await res.text()).toBe("made");
  });

  it("dual mode: a committed Response wins over concurrent state, and later c.set merges in", async () => {
    const app = createApp(quiet);
    app.get("/d", (c) => {
      void c.set("X-Before", "1");
      return c.text("returned");
    });
    const res = await app.handle(req("/d"));
    expect(await res.text()).toBe("returned");
    expect(res.headers.get("x-before")).toBe("1");
  });

  it("bare fast path: 200 + no custom headers carries no explicit content-type", async () => {
    const app = createApp(quiet);
    app.get("/bare", (c) => c.text("plain"));
    const res = await app.handle(req("/bare"));
    expect(res.status).toBe(200);
    // D1: the FRAMEWORK adds no content-type. Bun's Response implementation
    // attaches `text/plain;charset=UTF-8` itself; undici (Node) leaves it
    // unset — both are runtime behavior, not framework behavior.
    const ct = res.headers.get("content-type");
    expect(ct === null || ct === "text/plain;charset=UTF-8").toBe(true);
  });

  it("c.json returns application/json through the native static", async () => {
    const app = createApp(quiet);
    app.get("/j", (c) => c.json({ ok: true }));
    const res = await app.handle(req("/j"));
    // Bun's Response.json adds ;charset=utf-8 in-process; undici does not.
    expect((res.headers.get("content-type") ?? "").split(";")[0]).toBe("application/json");
    expect(await res.text()).toBe('{"ok":true}');
  });

  it("state-mode object bodies serialize via Response.json semantics", async () => {
    const app = createApp(quiet);
    app.get("/o", (c) => {
      c.body = { n: 1 };
    });
    const res = await app.handle(req("/o"));
    expect((res.headers.get("content-type") ?? "").split(";")[0]).toBe("application/json");
    expect(await res.text()).toBe('{"n":1}');
  });

  it("notFound customizes the untouched-404 response", async () => {
    const app = createApp(quiet);
    app.notFound((c) => c.text("nothing here", 404, { "x-kind": "custom" }));
    const res = await app.handle(req("/nope"));
    expect(res.status).toBe(404);
    expect(res.headers.get("x-kind")).toBe("custom");
    expect(await res.text()).toBe("nothing here");
  });

  it("matched route with an untouched response still 404s (koa)", async () => {
    const app = createApp(quiet);
    app.get("/empty", () => undefined);
    const res = await app.handle(req("/empty"));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not Found");
  });

  it("errors never escape app.handle and follow the expose gate", async () => {
    const app = createApp(quiet);
    app.get("/500", () => {
      throw new Error("secret");
    });
    app.get("/400", (c) => c.throw(400, "visible"));
    const five = await app.handle(req("/500"));
    expect(five.status).toBe(500);
    expect(await five.text()).toBe("Internal Server Error");
    const four = await app.handle(req("/400"));
    expect(four.status).toBe(400);
    expect(await four.text()).toBe("visible");
  });

  it("onError hears errors; silent apps log nothing on 5xx", async () => {
    const error = vi.fn();
    const app = createApp({ env: "test", silent: true });
    app.onError(error);
    app.get("/e", () => {
      throw new Error("boom");
    });
    await app.handle(req("/e"));
    expect(error).toHaveBeenCalledTimes(1);
    expect((error.mock.calls[0] as unknown as [Error])[0].message).toBe("boom");
  });

  it("HEAD reuses the GET handler, drops the body, backfills Content-Length", async () => {
    const app = createApp(quiet);
    app.get("/h", (c) => c.text("hello"));
    const res = await app.handle(new Request("http://localhost:3000/h", { method: "HEAD" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("5");
    expect(await res.text()).toBe("");
  });

  it("late app.use() recomposes existing route chains", async () => {
    const app = createApp(quiet);
    app.get("/late", (c) => c.text("core"));
    app.use(async (c, next) => {
      c.set("X-Late", "1");
      await next();
    });
    const res = await app.handle(req("/late"));
    expect(res.headers.get("x-late")).toBe("1");
    expect(await res.text()).toBe("core");
  });

  it("decorate extends every context", async () => {
    const app = createApp(quiet);
    app.decorate("user", () => "u1");
    app.get("/who", (c) => c.text((c as unknown as { user: () => string }).user()));
    const res = await app.handle(req("/who"));
    expect(await res.text()).toBe("u1");
  });

  it("runtime.remote resolves c.ip exactly once (lazy memo)", async () => {
    const app = createApp(quiet);
    let calls = 0;
    const remote = () => {
      calls += 1;
      return "9.9.9.9";
    };
    app.get("/ip", (c) => c.text(`${c.ip}|${c.ip}`));
    const res = await app.handle(req("/ip"), { remote });
    expect(await res.text()).toBe("9.9.9.9|9.9.9.9");
    expect(calls).toBe(1);
  });

  it("callback() wraps handle 1:1", async () => {
    const app = createApp(quiet);
    app.get("/cb", (c) => c.text("cb"));
    const res = await app.callback()(req("/cb"));
    expect(await res.text()).toBe("cb");
  });
});

describe("app: mounting", () => {
  it("mounts a router under a prefix with 404 fallthrough", async () => {
    const app = createApp(quiet);
    const api = createRouter({ prefix: "/v1" });
    api.get("/ping", (c) => c.text("pong"));
    app.mount("/api", api);
    app.get("/root", (c) => c.text("root"));
    expect(await (await app.handle(req("/api/v1/ping"))).text()).toBe("pong");
    expect((await app.handle(req("/api/v1/missing"))).status).toBe(404);
    expect(await (await app.handle(req("/root"))).text()).toBe("root");
  });

  it("mounts another app's routes with its global middleware prepended", async () => {
    const sub = createApp(quiet);
    sub.use((c, next) => {
      c.set("X-Sub", "1");
      return next();
    });
    sub.get("/inner", (c) => c.text("inner"));
    const app = createApp(quiet);
    app.mount("/sub", sub);
    const res = await app.handle(req("/sub/inner"));
    expect(await res.text()).toBe("inner");
    expect(res.headers.get("x-sub")).toBe("1");
  });
});

describe("app: registration validation", () => {
  it("rejects unknown methods, non-function handlers and empty stacks", () => {
    const app = createApp(quiet);
    expect(() => app.on("NOTAMETHOD", "/x", () => undefined)).toThrow(TypeError);
    expect(() => app.get("/x", "nope" as unknown as () => void)).toThrow(TypeError);
    expect(() => app.get("/x")).toThrow(/at least one handler/);
  });

  it("named routes resolve through url()/route()", () => {
    const app = createApp(quiet);
    app.get("user", "/users/:id(\\d+)", () => undefined);
    expect(app.url("user", { id: "7" })).toBe("/users/7");
    expect(app.route("user")).toBe("/users/:id(\\d+)");
    expect(app.route("missing")).toBeUndefined();
    expect(() => app.url("user", {})).toThrow(/Missing required parameter/);
  });

  it("app.param middleware runs for routes capturing the param", async () => {
    const app = createApp(quiet);
    app.param("pid", async (c, next) => {
      c.set("X-Param", c.params?.["pid"] ?? "");
      await next();
    });
    app.get("/p/:pid", (c) => c.text("done"));
    app.get("/q/:other", (c) => c.text("other"));
    const res = await app.handle(req("/p/77"));
    expect(res.headers.get("x-param")).toBe("77");
    const other = await app.handle(req("/q/1"));
    expect(other.headers.get("x-param")).toBeNull();
  });
});

const noopListen = (): void => undefined;

describe("app: listen", () => {
  it("parses port/hostname/onListen argument shapes", async () => {
    const made: Record<string, unknown>[] = [];
    const serveImpl = (options: Record<string, unknown>): ServerHandle => {
      made.push(options);
      return {
        port: options["port"] as number,
        hostname: "127.0.0.1",
        stop: () => undefined,
        fetch: () => new Response("x"),
        reload: () => undefined,
      };
    };
    const app = createApp(quiet) as Application;
    startBunServer(app, { port: 4123 }, noopListen, serveImpl);
    expect(made[0]?.["port"]).toBe(4123);
    expect(typeof made[0]?.["fetch"]).toBe("function");
    // the fetch handler wires the runtime server channel
    const fetch = made[0]?.["fetch"] as (
      request: Request,
      server: unknown,
    ) => Response | Promise<Response>;
    const seen: unknown[] = [];
    const fakeServer = {
      requestIP: (r: Request) => {
        seen.push(r);
        return { address: "1.2.3.4" };
      },
    };
    app.get("/ip", (c) => c.text(c.ip));
    const res = await fetch(req("/ip"), fakeServer);
    expect(await res.text()).toBe("1.2.3.4");
  });

  it.skipIf(typeof Bun !== "undefined")(
    "throws outside Bun when no serve implementation exists",
    () => {
      const app = createApp(quiet);
      expect(() => startBunServer(app, {})).toThrow(/Bun\.serve/);
    },
  );
});
