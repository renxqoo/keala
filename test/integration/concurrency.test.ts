import { describe, expect, it } from "vitest";

import { Keala, Router, createError } from "../../src/index.ts";
/**
 * Concurrency / interleaving / lifecycle red-team suite.
 *
 * CONFIRMED-BUG tests are written with the CORRECT (design-intent)
 * expectation and currently FAIL — each one's comment carries the label
 * CONFIRMED-BUG plus the reproduction, expected-vs-actual and the root cause
 * (file:line). "语义锁定" tests encode locked keala semantics (historically
 * verified against koa 3.2.1, or documented deliberate deviations) and must
 * stay green.
 *
 * migration notes (see docs/MIGRATION.md §2):
 *  - routing is app-level (`app.get` / `app.mount`); no router middleware API
 *  - `currentContext` / `pooling` app options no longer exist (removed from
 *    the core) — their tests were dropped; context recycling semantics are
 *    covered by test/pooling.test.ts against `resetContext`
 *  - the inherited koa CONFIRMED-BUGs around the identical-querystring no-op, the error
 *    statusText leak and the lazy ip thunk were fixed and are now
 *    green 语义锁定 locks.
 *
 * koa is no longer a contract (docs/KEALA-NATIVE-API-MIGRATION.md U1); the
 * `.parity/koa` clone this suite was originally audited against is archived
 * reference material.
 *
 * 0.7 migration: the "same-request interleaving: query cache" suite is gone —
 * requests are read-only now (url/path/search/querystring setters deleted),
 * so there is no rewrite-driven cache invalidation left to lock.
 */

const quiet = { env: "test" } as const;
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// 1. Cross-request isolation under concurrency
// ---------------------------------------------------------------------------
describe("concurrent isolation", () => {
  const buildApp = () => {
    const app = new Keala({ ...quiet, keys: ["k"] });
    const router = new Router();
    router.get("/user/:id", async (c) => {
      await delay(Number(c.params["id"]) % 3);
      c.setHeader("X-Path", "param");
      c.body = `user:${c.params["id"]}:${c.query("tag") ?? "none"}`;
    });
    router.get("/static", (c) => {
      c.type = "json";
      c.body = { stable: true };
    });
    router.get("/error", () => {
      throw createError(418, "teapot");
    });
    router.get("/redirect", (c) => {
      c.redirect(`/user/${c.query("to") ?? "0"}`);
    });
    router.get("/cookie", (c) => {
      c.cookies.set("sid", `s-${c.query("n") ?? "0"}`, { signed: true });
      c.body = `cookie:${c.cookies.get("sid")}`;
    });
    app.mount("/", router);
    return app;
  };

  it("语义锁定: 50-way concurrent mixed traffic matches the serial baseline", async () => {
    const paths = Array.from({ length: 50 }, (_, i) => {
      const kind = i % 5;
      if (kind === 0) return `/user/${i}?tag=t${i}`;
      if (kind === 1) return "/static";
      if (kind === 2) return "/error";
      if (kind === 3) return `/redirect?to=${i}`;
      return `/cookie?n=${i}`;
    });
    const serialize = async (app: ReturnType<typeof buildApp>) => {
      const out: Array<{ status: number; body: string; allow: string | null; cookie: string[] }> =
        [];
      for (const path of paths) {
        const res = await app.handle(new Request(`http://localhost:3000${path}`));
        out.push({
          status: res.status,
          body: await res.text(),
          allow: res.headers.get("allow"),
          cookie: res.headers
            .getSetCookie()
            .map((cookie) => cookie.replace(/s-\d+/, "s-N").replace(/user\/\d+/, "user/N")),
        });
      }
      return out;
    };
    const serial = await serialize(buildApp());
    const app = buildApp();
    const concurrent = await Promise.all(
      paths.map(async (path) => {
        const res = await app.handle(new Request(`http://localhost:3000${path}`));
        return {
          status: res.status,
          body: await res.text(),
          allow: res.headers.get("allow"),
          cookie: res.headers
            .getSetCookie()
            .map((cookie) => cookie.replace(/s-\d+/, "s-N").replace(/user\/\d+/, "user/N")),
        };
      }),
    );
    expect(concurrent).toEqual(serial);
    // Sanity: the baseline itself is non-trivial.
    expect(serial.filter((r) => r.status === 418).length).toBe(10);
    expect(serial.filter((r) => r.status === 302).length).toBe(10);
  });

  it("语义锁定: ctx.state stays request-private across await points under concurrency", async () => {
    const app = new Keala(quiet);
    const violations: string[] = [];
    app.use(async (c) => {
      const mine = c.query("token") as string;
      c.state["token"] = mine;
      await delay(Number(mine) % 4);
      if (c.state["token"] !== mine) violations.push(`token:${mine}->${String(c.state["token"])}`);
      const extra = Object.keys(c.state).filter((k) => k !== "token");
      if (extra.length > 0) violations.push(`extra:${mine}:${extra.join(",")}`);
      c.body = String(c.state["token"]);
    });
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        Promise.resolve(app.handle(new Request(`http://localhost:3000/?token=${i}`))).then((r) =>
          r.text(),
        ),
      ),
    );
    expect(violations).toEqual([]);
    expect(results).toEqual(Array.from({ length: 30 }, (_, i) => String(i)));
  });

  it("语义锁定: concurrent 405s each produce the right Allow header", async () => {
    const app = new Keala(quiet);
    app.use(async (_c, next) => {
      await next();
    });
    app.get("/only-get", (c) => {
      c.body = "g";
    });
    app.put("/only-put", (c) => {
      c.body = "p";
    });
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        app.handle(
          new Request(`http://localhost:3000/${i % 2 === 0 ? "only-get" : "only-put"}`, {
            method: "POST",
          }),
        ),
      ),
    );
    for (const [i, res] of responses.entries()) {
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe(i % 2 === 0 ? "HEAD, GET" : "PUT");
    }
  });

  // the 405 bookkeeping is per-request state (`routerAllowed` on the context,
  // nulled by initContext/resetContext), so a recycled context cannot leak a
  // foreign request's allowed-methods set — the old pooled leak is structurally
  // gone. The recycling contract itself is locked in test/pooling.test.ts
  // (resetContext field conservation); this locks the observable sequence.
  it("语义锁定: a 405 answer never bleeds into the next request's 404", async () => {
    const app = new Keala(quiet);
    app.use(async (_c, next) => {
      await next();
    });
    app.get("/only-get", (c) => {
      c.body = "g";
    });
    app.post("/only-post", async (_c, next) => {
      // Defers downstream (fall-through style): the route's handler wrote
      // nothing, so status stays 404 with no Allow header.
      await next();
    });
    const first = await app.handle(
      new Request("http://localhost:3000/only-get", { method: "POST" }),
    );
    expect(first.status).toBe(405);
    const second = await app.handle(
      new Request("http://localhost:3000/only-post", { method: "POST" }),
    );
    expect(second.status).toBe(404);
    expect(second.headers.get("allow")).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// 3. Error-path lifecycle
// ---------------------------------------------------------------------------
describe("error path lifecycle", () => {
  it("语义锁定: a failed response keeps staged headers and set-cookie, drops the failed body", async () => {
    // The error response carries headers the chain already staged (middleware
    // security headers must reach error pages); the failed BODY is discarded
    // and the 5xx message stays hidden.
    const errors: unknown[] = [];
    const app = new Keala(quiet);
    app.onError((e) => void errors.push(e));
    app.use(async (c) => {
      c.setHeader("X-Custom", "leak");
      c.append("Set-Cookie", "sid=dead; Path=/");
      c.status = 200;
      c.body = "partial";
      throw createError(500, "boom");
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(500);
    expect(res.headers.get("x-custom")).toBe("leak");
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).toBe("Internal Server Error");
    expect(res.headers.getSetCookie()).toEqual(["sid=dead; Path=/"]);
    expect(errors).toHaveLength(1);
  });

  it("语义锁定: upstream middleware may recover after a downstream error", async () => {
    const app = new Keala(quiet);
    app.onError(() => {});
    app.use(async (c, next) => {
      try {
        await next();
      } catch {
        c.status = 200;
        c.body = "recovered";
      }
    });
    app.use(async () => {
      throw createError(418, "first");
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("recovered");
  });

  it("语义锁定: when a request throws twice, the surviving error wins exactly once", async () => {
    const messages: string[] = [];
    const app = new Keala(quiet);
    app.onError((e: Error) => void messages.push(e.message));
    app.use(async (_c, next) => {
      try {
        await next();
      } catch {
        throw createError(503, "second");
      }
    });
    app.use(async () => {
      throw createError(418, "first");
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("Service Unavailable");
    expect(messages).toEqual(["second"]);
  });

  it("语义锁定: an error listener that throws never escapes app.handle", async () => {
    const app = new Keala(quiet);
    app.onError(() => {
      throw new Error("listener exploded");
    });
    app.use(async () => {
      throw new Error("original");
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Internal Server Error");
  });

  it("语义锁定: the built-in 405 layer stays silent when the matched route itself errors", async () => {
    // The route handler runs (method matched) and throws: the rejection skips
    // the 405/Allow fixup and the error path owns the response, exactly like
    // @koa/router under koa-compose.
    const app = new Keala(quiet);
    app.onError(() => {});
    app.get("/get-only", () => {
      throw createError(410, "gone");
    });
    const res = await app.handle(new Request("http://localhost:3000/get-only"));
    expect(res.status).toBe(410);
    expect(res.headers.get("allow")).toBe(null);
  });
});

/**
 * Concurrency / interleaving / lifecycle red-team suite (part 2: emitter
 * races, lazy singletons, stream bodies). Part 1 lives in
 * test/agent-concurrency.test.ts.
 *
 * CONFIRMED-BUG tests are written with the CORRECT (design-intent)
 * expectation and currently FAIL — each one's comment carries the label
 * CONFIRMED-BUG plus the reproduction, expected-vs-actual and the root cause
 * (file:line). "语义锁定" tests encode locked keala semantics (historically
 * verified against koa 3.2.1, or documented deliberate deviations) and must
 * stay green.
 *
 * migration notes: the inherited koa CONFIRMED-BUGs around the lazy ip memoization
 * (undefined thunk result / null requestIP result re-consulted) are fixed in
 * The core: `ipValue` now distinguishes unresolved from resolved-empty and the
 * resolver runs exactly once. The failing-body-stream error channel is a
 * documented divergence (observeStream is opt-in by design, off by
 * default; docs/DESIGN.md §4) and is carried as a labeled skip until the
 * opt-in switch ships (P2).
 *
 * koa is no longer a contract (docs/KEALA-NATIVE-API-MIGRATION.md U1).
 */

const enc = (value: string): Uint8Array => new TextEncoder().encode(value);

// ---------------------------------------------------------------------------
// 5. Lazy singletons on the flat context
// ---------------------------------------------------------------------------
describe("lazy singletons", () => {
  it("语义锁定: the cookies facade is created once and shared across await points", async () => {
    const app = new Keala({ ...quiet, keys: ["k"] });
    const observed: boolean[] = [];
    app.use(async (c, next) => {
      const first = c.cookies;
      c.cookies.set("a", "1");
      await next();
      observed.push(c.cookies === first);
      c.body = "ok";
    });
    app.use(async (c) => {
      c.cookies.set("b", "2");
      await delay(2);
    });
    await app.handle(new Request("http://localhost:3000/"));
    expect(observed).toEqual([true]);
  });

  it("语义锁定: ctx.state is one object per request and fresh across requests", async () => {
    const app = new Keala(quiet);
    const states: unknown[] = [];
    app.use(async (c) => {
      states.push(c.state);
      c.state["n"] = states.length;
      await delay(1);
      c.body = JSON.stringify({ keys: Object.keys(c.state) });
    });
    const first = await app.handle(new Request("http://localhost:3000/"));
    const second = await app.handle(new Request("http://localhost:3000/"));
    expect(states[0]).not.toBe(states[1]);
    expect(await first.text()).toBe(JSON.stringify({ keys: ["n"] }));
    expect(await second.text()).toBe(JSON.stringify({ keys: ["n"] }));
  });

  // Fixed (was an inherited koa CONFIRMED-BUG): the remote source is consulted ONCE
  // per request even when it resolves to nothing — `ipValue` distinguishes
  // unresolved (null) from resolved-empty (""), so a thunk returning
  // undefined is memoized after the first call.
  it("语义锁定: an ip thunk returning undefined is invoked exactly once", async () => {
    let calls = 0;
    const app = new Keala(quiet);
    app.use((c) => {
      const readings = [c.ip, c.ip, c.ip];
      c.body = readings.join("|");
    });
    await app.handle(new Request("http://localhost:3000/"), {
      remote: () => {
        calls++;
        return undefined;
      },
    });
    expect(calls).toBe(1);
  });

  // Fixed (same root cause): a `server.requestIP` source returning null
  // (Bun does this once the peer is gone) is consulted once per request, not
  // once per read.
  it("语义锁定: a requestIP host returning null is consulted exactly once", async () => {
    let calls = 0;
    const app = new Keala(quiet);
    app.use((c) => {
      c.body = `${c.ip},${c.ip}`;
    });
    await app.handle(new Request("http://localhost:3000/"), {
      server: {
        requestIP: () => {
          calls++;
          return null;
        },
      },
    });
    expect(calls).toBe(1);
  });

  it("语义锁定: a thunk with a concrete result is called exactly once", async () => {
    let calls = 0;
    const app = new Keala(quiet);
    app.use((c) => {
      c.body = [c.ip, c.ip, c.ip].join(",");
    });
    const res = await app.handle(new Request("http://localhost:3000/"), {
      remote: () => {
        calls++;
        return "10.0.0.9";
      },
    });
    expect(calls).toBe(1);
    expect(await res.text()).toBe("10.0.0.9,10.0.0.9,10.0.0.9");
  });
});

// ---------------------------------------------------------------------------
// 6. Stream bodies: error propagation and HEAD
// ---------------------------------------------------------------------------
describe("stream bodies", () => {
  it("语义锁定: HEAD with a stream body drops the body but keeps status and type", async () => {
    const app = new Keala(quiet);
    app.use((c) => {
      c.type = "text/plain";
      c.body = new ReadableStream({
        start(controller) {
          controller.enqueue(enc("abc"));
          controller.close();
        },
      });
    });
    const res = await app.handle(new Request("http://localhost:3000/", { method: "HEAD" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(res.headers.get("content-length")).toBe(null); // length of a stream is unknowable
    expect(await res.text()).toBe("");
  });

  it("语义锁定: consuming a healthy streamed body yields its chunks", async () => {
    const app = new Keala(quiet);
    app.use((c) => {
      c.body = new ReadableStream({
        start(controller) {
          controller.enqueue(enc("hello "));
          controller.enqueue(enc("stream"));
          controller.close();
        },
      });
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(await res.text()).toBe("hello stream");
  });

  // Documented divergence (was an inherited koa CONFIRMED-BUG): Koa pipes the body
  // through `Stream.pipeline(stream, res, err => ctx.onerror(err))` so a
  // mid-flight body failure reaches the app's error channel. keala hands the raw
  // stream to the fetch `Response` and — by design (docs/DESIGN.md §4) —
  // made stream error observation an OPT-IN feature (`observeStream`, off by
  // default to save 567ns/response and restore backpressure). The opt-in
  // switch has not shipped yet (P2); until it does, this lock is explicitly
  // parked rather than silently dropped.
  it("[P2 delivered] a failing body stream reaches the onStreamError hook (opt-in)", async () => {
    const seen: string[] = [];
    const app = new Keala({
      env: "test",
      onStreamError: (e) => seen.push(e.message),
    });
    app.use((c) => {
      c.body = new ReadableStream({
        start(controller) {
          controller.enqueue(enc("first"));
          queueMicrotask(() => controller.error(new Error("stream exploded")));
        },
      });
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    await expect(res.text()).rejects.toThrow();
    expect(seen).toContain("stream exploded");
  });
});
