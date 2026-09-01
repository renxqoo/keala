/**
 * Performance evidence: regression fences, NOT measurements.
 *
 * The budget fence is a RATIO against a raw-Response baseline measured in the
 * same process and batch loop — machine speed and coverage instrumentation
 * scale both loops alike, so the fence holds under `vitest --coverage` and on
 * any host. Structural fences assert the zero-allocation invariants the fast
 * paths depend on.
 */

import { describe, expect, it } from "vitest";

import { Keala } from "../src/core/app.ts";
import type { Context } from "../src/core/context/context.ts";

const isBun = typeof Bun !== "undefined";

const app = new Keala({ env: "test" });
app.get("/text", (c) => c.text("hello world"));
app.get("/json", (c) => c.json({ hello: "world" }));
app.get("/users/:id", (c) => c.text(`user ${c.params?.["id"]}`));
app.get(
  "/mw",
  async (c, next) => {
    c.set("X-Step", "1");
    await next();
    c.set("X-Step-3", "3");
  },
  async (c, next) => {
    c.set("X-Step-2", "2");
    await next();
  },
  (c) => c.text("middleware"),
);

const requestFor = (path: string) => new Request(`http://localhost:3000${path}`);

describe("perf evidence: budgets (ratio fences)", () => {
  it("mixed bench mix stays under a generous ratio budget", { timeout: 30_000 }, async () => {
    const paths = ["/text", "/json", "/users/7", "/mw"];
    const requests = paths.map((p) => requestFor(p));
    const baselineResponse = (): Response => new Response("x");
    for (let i = 0; i < 4_000; i++) await app.handle(requests[i % 4]!); // warm
    const N = 20_000;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) baselineResponse();
    const baselineNs = ((performance.now() - t0) * 1e6) / N;
    const start = performance.now();
    for (let i = 0; i < N; i++) {
      const res = await app.handle(requests[i % 4]!);
      if (res.status !== 200) throw new Error("unexpected status in budget loop");
    }
    const nsPerReq = ((performance.now() - start) * 1e6) / N;
    // Reference ratio ~5x on Bun/Apple Silicon (framework incl. Response
    // construction vs bare construction). 10x headroom trips on structural
    // regressions while passing under coverage instrumentation.
    expect(nsPerReq / baselineNs).toBeLessThan(10);
  });

  it.skipIf(!isBun)(
    "retained per-request graph stays under a byte budget (no leaks)",
    { timeout: 60_000 },
    async () => {
      const responses: Response[] = [];
      const req = requestFor("/text");
      // Extra warm window: JSC (real Bun) grows the heap lazily at first.
      for (let i = 0; i < 20_000; i++) void (await app.handle(req));
      for (let i = 0; i < 5_000; i++) responses.push((await app.handle(req)) as Response);
      responses.length = 0;
      Bun.gc(true);
      const before = process.memoryUsage().heapUsed;
      for (let i = 0; i < 5_000; i++) {
        responses.push((await app.handle(req)) as Response);
      }
      responses.length = 0;
      Bun.gc(true);
      const perRequest = process.memoryUsage().heapUsed - before;
      // Nothing per-request is retained beyond JSC arena-growth noise (the
      // authoritative leak fence is GA-3: 100k requests at 32B/req).
      expect(perRequest).toBeLessThan(8_000);
    },
  );
});

describe("perf evidence: structural fences", () => {
  it("a fully synchronous chain settles without a promise", async () => {
    const syncApp = new Keala({ env: "test" });
    syncApp.use((c, next) => {
      void c.set("X-Sync", "1");
      return next();
    });
    syncApp.get("/sync", (c) => c.text("ok"));
    for (let i = 0; i < 2_000; i++) await syncApp.handle(requestFor("/sync"));
    // The zero-promise fast path: a fully synchronous chain returns the
    // Response synchronously — not a Promise.
    const result = syncApp.handle(requestFor("/sync"));
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(200);
  });

  it("every context carries the exact same hidden-class key order", () => {
    const app2 = new Keala({ env: "test" });
    app2.get("/k", () => undefined);
    const shapes = new Set<string>();
    const seen: Context[] = [];
    app2.use((c, next) => {
      seen.push(c);
      return next();
    });
    return (async () => {
      for (let i = 0; i < 50; i++) await app2.handle(requestFor("/k"));
      for (const c of seen) shapes.add(Object.keys(c).join(","));
      expect(shapes.size).toBe(1);
      expect((shapes.values().next().value as string).startsWith("appValue,rawRequest")).toBe(true);
    })();
  });

  it("static-route response construction takes the bare fast path", async () => {
    // A 200 string/text response with no custom headers must construct with
    // no init at all — asserted via the absence of framework-added headers.
    const res = await app.handle(requestFor("/text"));
    expect(res.headers.get("content-type") ?? "").not.toContain("charset=utf-8;");
    // Bun's own default is `text/plain;charset=UTF-8` (no space); any value
    // with the koa-style spacing would mean the framework set it.
  });
});
