/**
 * rateLimit store contract tests (M8c): the 0.8 `{ hit, get }` interface
 * replaces the 0.7 Map get/set — admission is ONE atomic store call, so a
 * shared Redis adapter (INCR + EXPIRE) cannot race two workers past the
 * limit the way a read-modify-write round trip across the network could.
 */

import { describe, expect, it } from "vitest";

import { Keala } from "../../src/core/app.ts";
import {
  memoryRateLimitStore,
  rateLimit,
  type RateLimitStore,
} from "../../src/middleware/rate-limit.ts";

const quiet = { env: "test" } as const;

describe("rateLimit store: hit() atomic admission", () => {
  it("performs exactly ONE store call per request — no read-modify-write window", async () => {
    const calls: string[] = [];
    const store: RateLimitStore = {
      hit(key, windowMs, max) {
        calls.push(`hit ${key} ${windowMs} ${max}`);
        return { count: 1, resetAt: Date.now() + windowMs };
      },
      get(key) {
        calls.push(`get ${key}`);
        return undefined;
      },
    };
    const app = new Keala(quiet);
    app.use(rateLimit({ limit: 5, windowMs: 60_000, store, key: (c) => c.header("x-k") ?? "?" }));
    app.get("/x", (c) => c.text("ok"));
    for (let i = 0; i < 2; i++) {
      await app.handle(new Request("http://127.0.0.1:3000/x", { headers: { "x-k": "tenant" } }));
    }
    // The admission decision is a single hit() — the limiter never does a
    // get → decide → set sequence an external store could interleave.
    expect(calls).toEqual(["hit tenant 60000 5", "hit tenant 60000 5"]);
  });

  it("admits while the hit count stays within limit, 429s past it (INCR semantics)", async () => {
    let count = 0;
    const resetAt = Date.now() + 60_000;
    const store: RateLimitStore = {
      hit: () => ({ count: ++count, resetAt }),
      get: () => ({ count, resetAt }),
    };
    const app = new Keala(quiet);
    app.use(rateLimit({ limit: 2, windowMs: 60_000, store }));
    app.get("/x", (c) => c.text("ok"));
    const hit = () => app.handle(new Request("http://127.0.0.1:3000/x"));
    const statuses = [(await hit()).status, (await hit()).status, (await hit()).status];
    expect(statuses).toEqual([200, 200, 429]);
  });

  it("429 Retry-After derives from the bucket resetAt, floored by retryAfterSeconds", async () => {
    let count = 0;
    const store: RateLimitStore = {
      hit: () => ({ count: ++count, resetAt: Date.now() + 5_000 }),
      get: () => undefined,
    };
    const app = new Keala(quiet);
    app.use(rateLimit({ limit: 1, windowMs: 5_000, headers: true, store }));
    app.get("/x", (c) => c.text("ok"));
    const hit = () => app.handle(new Request("http://127.0.0.1:3000/x"));
    expect((await hit()).status).toBe(200);
    const limited = await hit();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("5");
    expect(limited.headers.get("ratelimit-remaining")).toBe("0");
    expect(limited.headers.get("ratelimit-reset")).toBe("5");
  });

  it("a sub-second window keeps retryAfterSeconds as the floor", async () => {
    let count = 0;
    const store: RateLimitStore = {
      hit: () => ({ count: ++count, resetAt: Date.now() + 100 }),
      get: () => undefined,
    };
    const app = new Keala(quiet);
    app.use(rateLimit({ limit: 1, windowMs: 100, retryAfterSeconds: 2, store }));
    app.get("/x", (c) => c.text("ok"));
    const hit = () => app.handle(new Request("http://127.0.0.1:3000/x"));
    await hit();
    expect((await hit()).headers.get("retry-after")).toBe("2");
  });

  it("emits RateLimit-Remaining that counts down with the hit count", async () => {
    let count = 0;
    const resetAt = Date.now() + 60_000;
    const store: RateLimitStore = {
      hit: () => ({ count: ++count, resetAt }),
      get: () => ({ count, resetAt }),
    };
    const app = new Keala(quiet);
    app.use(rateLimit({ limit: 3, windowMs: 60_000, headers: true, store }));
    app.get("/x", (c) => c.text("ok"));
    const remaining: (string | null)[] = [];
    for (let i = 0; i < 3; i++) {
      remaining.push(
        (await app.handle(new Request("http://127.0.0.1:3000/x"))).headers.get(
          "ratelimit-remaining",
        ),
      );
    }
    expect(remaining).toEqual(["2", "1", "0"]);
  });

  it("a bare Map is no longer accepted — the 0.8 interface is { hit, get }", () => {
    // @ts-expect-error -- a bare Map is the retired 0.7 store shape
    expect(() => rateLimit({ store: new Map() })).toThrow(/hit/);
  });
});

describe("memoryRateLimitStore: the built-in Map-backed hit() store", () => {
  it("increments within the window and resets atomically once it lapses", async () => {
    const store = memoryRateLimitStore();
    const first = store.hit("k", 40, 1);
    expect(first.count).toBe(1);
    expect(store.hit("k", 40, 1).count).toBe(2);
    expect(store.get("k")).toBe(first); // same live bucket, get() reads through
    await new Promise((resolve) => setTimeout(resolve, 50));
    const fresh = store.hit("k", 40, 1);
    expect(fresh.count).toBe(1);
    expect(fresh.resetAt).toBeGreaterThan(first.resetAt);
  });

  it("retains at most maxKeys buckets, evicting oldest-first", () => {
    const store = memoryRateLimitStore(3);
    for (const key of ["a", "b", "c", "d"]) store.hit(key, 60_000, 100);
    expect(store.get("a")).toBeUndefined();
    expect(store.get("b")).toBeDefined();
    expect(store.get("d")).toBeDefined();
  });

  it("serves as the default store through the middleware", async () => {
    const store = memoryRateLimitStore();
    const app = new Keala(quiet);
    app.use(rateLimit({ limit: 1, windowMs: 60_000, store, key: (c) => c.header("x-k") ?? "?" }));
    app.get("/x", (c) => c.text("ok"));
    const hit = (k: string) =>
      app.handle(new Request("http://127.0.0.1:3000/x", { headers: { "x-k": k } }));
    expect((await hit("t")).status).toBe(200);
    expect((await hit("t")).status).toBe(429);
    // A different key has its own budget — per-key fairness is intact.
    expect((await hit("other")).status).toBe(200);
  });
});
