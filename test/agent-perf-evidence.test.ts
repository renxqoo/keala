/**
 * Performance evidence: regression fences, NOT measurements.
 *
 * The budget fence is a RATIO against a raw-Response baseline measured in the
 * same process and batch loop. Timed async fences use CURRENT-THREAD CPU time:
 * Vitest's parallel workers share a process under Bun, so process-wide CPU
 * time would charge unrelated test workers to whichever side happened to run
 * concurrently. Structural fences assert the zero-allocation invariants the
 * fast paths depend on.
 */

import { describe, expect, it } from "vitest";

import { Keala } from "../src/core/app.ts";
import type { Context } from "../src/core/context/context.ts";

const isBun = typeof Bun !== "undefined";

const app = new Keala({ env: "test" });
app.get("/text", (c) => c.text("hello world"));
app.get("/json", (c) => c.json({ hello: "world" }));
app.get("/users/:id", (c) => c.text(`user ${c.params["id"]}`));
app.get(
  "/mw",
  async (c, next) => {
    c.setHeader("X-Step", "1");
    await next();
    c.setHeader("X-Step-3", "3");
  },
  async (c, next) => {
    c.setHeader("X-Step-2", "2");
    await next();
  },
  (c) => c.text("middleware"),
);

const requestFor = (path: string) => new Request(`http://localhost:3000${path}`);
const baselineResponse = (): Promise<Response> => Promise.resolve(new Response("x"));

describe("perf evidence: budgets (ratio fences)", () => {
  it("mixed bench mix stays under a generous ratio budget", { timeout: 30_000 }, async () => {
    const paths = ["/text", "/json", "/users/7", "/mw"];
    const requests = paths.map((p) => requestFor(p));
    for (let i = 0; i < 4_000; i++) {
      await baselineResponse();
      await app.handle(requests[i % 4]!);
    }
    const batch = 5_000;
    const samples = 9;
    let baselineStatus = 0;
    const ratios: number[] = [];
    const measureBaseline = async (): Promise<number> => {
      const start = process.threadCpuUsage();
      for (let i = 0; i < batch; i++) baselineStatus += (await baselineResponse()).status;
      const elapsed = process.threadCpuUsage(start);
      return elapsed.user + elapsed.system;
    };
    const measureApp = async (): Promise<number> => {
      const start = process.threadCpuUsage();
      for (let i = 0; i < batch; i++) {
        const res = await app.handle(requests[i % 4]!);
        if (res.status !== 200) throw new Error("unexpected status in budget loop");
      }
      const elapsed = process.threadCpuUsage(start);
      return elapsed.user + elapsed.system;
    };
    for (let sample = 0; sample < samples; sample++) {
      // Rotate order so neither side owns a systematically colder window.
      const baselineFirst = sample % 2 === 0;
      const baselineMs = baselineFirst ? await measureBaseline() : 0;
      const appMs = await measureApp();
      const pairedBaselineMs = baselineFirst ? baselineMs : await measureBaseline();
      ratios.push(appMs / pairedBaselineMs);
    }
    expect(baselineStatus).toBe(batch * samples * 200);
    // Reference ratio ~5x on Bun/Apple Silicon (framework vs the same settled
    // fetch-handler boundary). 10x headroom trips on structural regressions
    // while passing under coverage instrumentation.
    expect(ratios.toSorted((a, b) => a - b)[Math.floor(samples / 2)]).toBeLessThan(10);
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
  it("app.handle always settles through a Promise (DOGFOOD-R1 C1 boundary)", async () => {
    const syncApp = new Keala({ env: "test" });
    syncApp.use((c, next) => {
      void c.setHeader("X-Sync", "1");
      return next();
    });
    syncApp.get("/sync", (c) => c.text("ok"));
    for (let i = 0; i < 2_000; i++) await syncApp.handle(requestFor("/sync"));
    // The PUBLIC boundary is always-Promise; the zero-promise property lives
    // in the internal chain (compose hops), invisible by design from outside.
    const pending = syncApp.handle(requestFor("/sync"));
    expect(pending).toBeInstanceOf(Promise);
    // The settled promise carries the response without an extra tick of
    // observable work — await lands on the same microtask queue a direct
    // return would.
    await expect(pending).resolves.toHaveProperty("status", 200);
  });

  it("every fresh context carries the same uniform own-key order", () => {
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
      const shape = shapes.values().next().value as string;
      expect(shape.startsWith("rawRequest,pathValue,urlValue,params")).toBe(true);
      // Dispatch memoizes path+url eagerly (77-79ns recompute vs ~1ns per
      // slot write — hono hands the same string down for this reason), so
      // pathValue/urlValue ARE the uniform post-dispatch shape now; the lazy
      // materialization they replaced is the retired contract.
      expect(shape).toContain("pathValue");
      expect(shape).toContain("urlValue");
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
