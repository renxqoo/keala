/**
 * Performance-evidence regression fences (red-team perf audit, 2026-08-30).
 *
 * These are NOT precision measurements. Every bound below is deliberately
 * loose (3-10x above the reference numbers) so the suite stays flake-free on
 * any reasonable machine/runtime. They exist to catch REGRESSIONS only:
 *
 *  - a hidden-class split in the per-request state objects (a field added in
 *    a different order per request would deoptimize every prototype accessor)
 *  - a reintroduced Promise on the fully-synchronous fast path
 *  - a per-request leak (retained heap growth)
 *  - an allocation blow-up in the per-request object graph
 *  - header-name/value validation being "optimized away" (CRLF injection)
 *  - percent-decoding of route params being dropped
 *
 * Reference measurements this file was calibrated against (Bun 1.4,
 * Apple Silicon, in-process loops, /tmp probes of the perf audit):
 *   GET /text end-to-end        ~280-322 ns/req   (raw Response ~187-211)
 *   mixed 4-route bench mix     ~507 ns/req
 *   retained request graph      ~712 B/req (ctx side ~330 + response ~380)
 *   leak over 100K requests     ~0 B/req
 */

import { describe, expect, it } from "vitest";

import { createApp } from "../src/application/app.ts";
import { createRouter } from "../src/router/router.ts";
import { createContext, requestStateOf } from "../src/context/context.ts";
import type { Context } from "../src/context/context.ts";
import { responseStateOf } from "../src/http/response.ts";

type BunGlobal = { gc: (force?: boolean) => void };
const bunRuntime: BunGlobal | undefined = (globalThis as { Bun?: BunGlobal }).Bun;
const isBun = bunRuntime !== undefined;
const forceGc = (): void => {
  bunRuntime?.gc(true);
};

/** The exact bench mix: 4 routes, static + trie + async middleware chain. */
const buildBenchApp = (capture?: (ctx: Context) => void) => {
  const app = createApp({ env: "test" });
  const router = createRouter();
  router.get("/text", (ctx) => {
    ctx.body = "hello world";
  });
  router.get("/json", (ctx) => {
    ctx.body = { hello: "world" };
  });
  router.get("/users/:id", (ctx) => {
    ctx.body = `user ${ctx.params["id"]}`;
  });
  router.get(
    "/mw",
    async (ctx, next) => {
      ctx.set("X-Step", "1");
      await next();
      ctx.set("X-Step-3", "3");
    },
    async (ctx, next) => {
      ctx.set("X-Step-2", "2");
      await next();
    },
    (ctx) => {
      ctx.type = "text/plain";
      ctx.body = "middleware";
    },
  );
  if (capture !== undefined) {
    app.use((ctx, next) => {
      capture(ctx);
      return next();
    });
  }
  app.use(router.routes());
  return app;
};

const requestFor = (path: string): Request =>
  new Request(`http://127.0.0.1:4103${path}`, { method: "GET" });

describe("perf evidence: structural fast-path fences", () => {
  it("a fully synchronous middleware chain settles without a Promise", async () => {
    const app = buildBenchApp();
    await app.handle(requestFor("/mw")); // warm the compiled chains
    const result = app.handle(requestFor("/text"));
    expect(result).toBeInstanceOf(Response);
    expect(typeof (result as Promise<Response>).then).toBe("undefined");
    const response = await result;
    expect(response.status).toBe(200);
  });

  it("static-map and trie routes both dispatch correctly", async () => {
    const app = buildBenchApp();
    const text = (await (await app.handle(requestFor("/text"))).text()) as string;
    const json = (await (await app.handle(requestFor("/json"))).json()) as {
      hello: string;
    };
    const user = (await (await app.handle(requestFor("/users/42"))).text()) as string;
    expect(text).toBe("hello world");
    expect(json.hello).toBe("world");
    expect(user).toBe("user 42");
  });
});

describe("perf evidence: per-request hidden-class stability", () => {
  it("ctx state keeps a fixed own-property order (no shape splits)", async () => {
    const app = buildBenchApp();
    const captured: Context[] = [];
    const probe = createApp({ env: "test" });
    probe.use((ctx, next) => {
      captured.push(ctx);
      return next();
    });
    probe.use((ctx) => {
      ctx.body = "ok";
    });
    await probe.handle(requestFor("/anything"));
    expect(captured.length).toBeGreaterThan(0);
    expect(Object.keys(captured[0] as object)).toEqual([
      "appValue",
      "requestValue",
      "responseValue",
      "stateValue",
      "_cookies",
    ]);
    void app;
  });

  it("request state keeps a fixed own-property order", async () => {
    const app = buildBenchApp();
    const ctx = createContext(app, requestFor("/text"), undefined);
    const state = requestStateOf(ctx);
    expect(Object.keys(state as object)).toEqual([
      "rawRequest",
      "peer",
      "settings",
      "remote",
      "remoteValue",
      "_url",
      "_query",
      "originalUrlValue",
    ]);
  });

  it("response state keeps a fixed own-property order", async () => {
    const app = buildBenchApp();
    const ctx = createContext(app, requestFor("/text"), undefined);
    const state = responseStateOf(ctx.response);
    expect(Object.keys(state as object)).toEqual([
      "peer",
      "_status",
      "_message",
      "_headers",
      "_body",
      "_flags",
    ]);
  });

  it("pooled contexts are recycled and keep the identical shape", async () => {
    const pooled = createApp({ env: "test", pooling: true });
    const router = createRouter();
    const seen: Context[] = [];
    router.get("/p", (ctx) => {
      ctx.body = "pooled";
    });
    pooled.use((ctx, next) => {
      seen.push(ctx);
      return next();
    });
    pooled.use(router.routes());
    await pooled.handle(requestFor("/p"));
    await pooled.handle(requestFor("/p"));
    await pooled.handle(requestFor("/p"));
    expect(seen.length).toBe(3);
    // Recycling means the SAME context object (pool cap 128, serial traffic).
    expect(seen[0]).toBe(seen[1]);
    expect(seen[1]).toBe(seen[2]);
    // Router-dispatched contexts carry a 6th own key (`params`, set to
    // undefined by resetContext but kept as a slot): exactly TWO stable
    // shapes exist across the whole population — never-routed (5 keys) and
    // routed (6 keys). Both orders must stay fixed.
    expect(Object.keys(seen[0] as object)).toEqual([
      "appValue",
      "requestValue",
      "responseValue",
      "stateValue",
      "_cookies",
      "params",
    ]);
  });
});

describe("perf evidence: optimization-safety fences", () => {
  it("header value validation rejects CR/LF/NUL (do not optimize away)", async () => {
    const app = buildBenchApp();
    const ctx = createContext(app, requestFor("/text"), undefined);
    expect(() => ctx.set("X-Test", "a\r\nb")).toThrow();
    expect(() => ctx.set("X-Test", "a\nb")).toThrow();
    expect(() => ctx.set("X-Test", "a\u0000b")).toThrow();
    expect(() => ctx.set("bad name", "v")).toThrow();
    expect(() => ctx.set("bad\u007fname", "v")).toThrow();
    // The framework-reserved fast-path names stay writable.
    expect(() => ctx.set("Content-Type", "text/plain")).not.toThrow();
  });

  it("route params keep percent-decoding (guard must stay an optimization)", async () => {
    const app = buildBenchApp();
    const res = await app.handle(requestFor("/users/a%20b%2Fc"));
    expect(await res.text()).toBe("user a b/c");
  });

  it("redirect Location stays percent-encoded", async () => {
    const app = buildBenchApp();
    const ctx = createContext(app, requestFor("/text"), undefined);
    ctx.response.redirect("http://example.com/a b<c");
    expect(ctx.response.get("Location")).toBe("http://example.com/a%20b%3Cc");
  });
});

describe("perf evidence: budgets (regression fences, NOT measurements)", () => {
  it("mixed bench mix stays under a generous time budget", { timeout: 30_000 }, async () => {
    const app = buildBenchApp();
    const paths = ["/text", "/json", "/users/7", "/mw"];
    const requests = paths.map((p) => requestFor(p));
    for (let i = 0; i < 4_000; i++) await app.handle(requests[i % 4]!); // warm
    const N = 20_000;
    const start = performance.now();
    for (let i = 0; i < N; i++) {
      const res = await app.handle(requests[i % 4]!);
      if (res.status !== 200) throw new Error("unexpected status in budget loop");
    }
    const nsPerReq = ((performance.now() - start) * 1e6) / N;
    // Reference: ~507 ns/req on Bun 1.4 / Apple Silicon. Budget: ~10x.
    expect(nsPerReq).toBeLessThan(5_000);
  });

  it.skipIf(!isBun)(
    "retained per-request object graph stays under a byte budget",
    { timeout: 60_000 },
    async () => {
      const bag: Context[] = [];
      const responses: Response[] = [];
      const app = buildBenchApp((ctx) => bag.push(ctx));
      const req = requestFor("/text");
      for (let i = 0; i < 5_000; i++) responses.push((await app.handle(req)) as Response);
      bag.length = 0;
      responses.length = 0;
      forceGc();
      forceGc();
      const before = process.memoryUsage().heapUsed;
      for (let i = 0; i < 5_000; i++) {
        responses.push((await app.handle(req)) as Response);
      }
      forceGc();
      forceGc();
      const perRequest = (process.memoryUsage().heapUsed - before) / 5_000;
      // Reference: ~712 B/req (ctx graph ~330 + response graph ~380).
      // Budget ~3x reference: catches graph blow-ups, tolerates runtime noise.
      expect(perRequest).toBeLessThan(2_400);
      bag.length = 0;
      responses.length = 0;
    },
  );

  it.skipIf(!isBun)(
    "sustained traffic does not retain heap (leak fence)",
    { timeout: 60_000 },
    async () => {
      const app = buildBenchApp();
      const requests = ["/text", "/json", "/users/3", "/mw"].map((p) => requestFor(p));
      for (let i = 0; i < 10_000; i++) await app.handle(requests[i % 4]!);
      forceGc();
      forceGc();
      const before = process.memoryUsage().heapUsed;
      for (let i = 0; i < 30_000; i++) await app.handle(requests[i % 4]!);
      forceGc();
      forceGc();
      const deltaMb = Math.abs(process.memoryUsage().heapUsed - before) / 1_048_576;
      // Reference: ~0.00 MB over 100K requests. Budget: 8 MB over 30K.
      expect(deltaMb).toBeLessThan(8);
    },
  );
});
