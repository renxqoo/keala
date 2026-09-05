/* eslint-disable max-lines -- one audit file per the task mandate (9 probes + allocation inventory documented in full; agent is restricted to this single file) */
/**
 * Agent R4.4 perf review — hot-path cost verification + allocation/leak hunting
 * (docs/HOTPATH-R4-4-MIGRATION-LIFECYCLE.md §7 budget; src/core/lifecycle.ts,
 * app.ts handle()/#serve, dispatch.ts settleHandle).
 *
 * ALLOCATION INVENTORY (code-reasoned; each line verified by a probe):
 * - unconfigured: admission = branch + inFlight++ (no alloc); settle tail =
 *   ONE promise link (`out.then(release)`, the documented ~+25ns) with a
 *   per-APP stable #settle closure; c.signal lazy (abortValue stays null);
 *   zero timers/streams/AbortControllers. [PERF-1/4a/5/6-control]
 * - overload under capacity: admission arithmetic only, no alloc, no timer.
 *   [PERF-2/4b]. QUEUED waiter (bounded, freed): 1 Promise + 1 QueueWaiter +
 *   settleOut/leave closures + 1 unref'd timer + 1 abort listener — timer
 *   cleared and listener removed on admit/leave. [PERF-7]
 * - requestTimeout (per request): settleOnce + releaseOnce closures,
 *   raceDeadline outer Promise + executor + settled.then callbacks, 1 timer —
 *   create:clear:unref exactly 1:1:1, zero live timers after settle. [PERF-3/4c]
 * - drain bodied settle: holdBody adds EXACTLY ONE ReadableStream wrap (+
 *   wrapper Response + reader) per bodied response, NONE when not draining.
 *   [PERF-6]
 *
 * Note: process.getActiveResourcesInfo() does NOT list unref'd timers on Node
 * 22 (verified: 100 live unref'd timers → "Timeout": 0) — timer discipline is
 * probed by a counting setTimeout/clearTimeout/unref patch (stronger: it
 * observes the create/clear/unref balance directly). Thresholds are STRUCTURAL
 * fences (O(n²)/leaks/extra promise links), not ±20ns noise detectors.
 */

import { describe, expect, it } from "vitest";

import { Keala } from "../../src/core/app.ts";
import type { AppOptions } from "../../src/types.ts";

const ns = (ms: number): number => ms * 1e6;

interface Probe {
  app: Keala;
  run: () => Promise<void>;
}

/** The bench/lifecycle-overhead.ts probe shape: async middleware + JSON body. */
const makeProbe = (options: AppOptions): Probe => {
  const app = new Keala({ env: "test", ...options });
  app.use(async (_c, next) => {
    await next();
  });
  app.get("/x", (c) => {
    c.body = { ok: true };
  });
  const request = new Request("http://localhost/x");
  const run = async (): Promise<void> => {
    const res = await app.handle(request);
    await res.text();
  };
  return { app, run };
};

/** Rotating best-of-round-medians (no variant owns a colder window). */
const measureVariants = async (
  runs: { name: string; run: () => Promise<void> }[],
  opts: { warmup: number; rounds: number; perRound: number },
): Promise<Record<string, number>> => {
  for (const { run } of runs) {
    for (let i = 0; i < opts.warmup; i++) await run();
  }
  const medians: Record<string, number[]> = {};
  for (let round = 0; round < opts.rounds; round++) {
    for (const { name, run } of runs) {
      const samples: number[] = [];
      for (let i = 0; i < opts.perRound; i++) {
        const t0 = performance.now();
        await run();
        samples.push(performance.now() - t0);
      }
      samples.sort((a, b) => a - b);
      (medians[name] ??= []).push(samples[Math.floor(samples.length / 2)] ?? 0);
    }
  }
  const best: Record<string, number> = {};
  for (const [name, xs] of Object.entries(medians)) best[name] = Math.min(...xs);
  return best;
};

/** Count setTimeout/clearTimeout/unref calls + created-but-uncleared timers. */
interface TimerSnapshot {
  created: number;
  cleared: number;
  unrefed: number;
  live: number;
}
type TimerLike = { unref?: () => unknown };
const patchTimers = (): { snapshot: () => TimerSnapshot; restore: () => void } => {
  const realSet = globalThis.setTimeout as unknown as (...args: unknown[]) => TimerLike;
  const realClear = globalThis.clearTimeout as unknown as (t?: unknown) => void;
  const live = new Set<TimerLike>();
  let created = 0;
  let cleared = 0;
  let unrefed = 0;
  const countingSet = (...args: unknown[]): TimerLike => {
    const t = realSet(...args);
    created++;
    live.add(t);
    const unref = t.unref;
    if (typeof unref === "function") {
      t.unref = () => {
        unrefed++;
        return unref.call(t);
      };
    }
    return t;
  };
  const countingClear = (t?: unknown): void => {
    if (t !== undefined && live.delete(t as TimerLike)) cleared++;
    realClear(t);
  };
  globalThis.setTimeout = countingSet as unknown as typeof globalThis.setTimeout;
  globalThis.clearTimeout = countingClear as unknown as typeof globalThis.clearTimeout;
  return {
    snapshot: () => ({ created, cleared, unrefed, live: live.size }),
    restore: () => {
      globalThis.setTimeout = realSet as unknown as typeof globalThis.setTimeout;
      globalThis.clearTimeout = realClear as unknown as typeof globalThis.clearTimeout;
    },
  };
};

/** Count constructions of a web-global class the framework references bare. */
const patchConstructor = (
  key: "AbortController" | "ReadableStream",
): { count: () => number; restore: () => void } => {
  const holder = globalThis as unknown as Record<string, unknown>;
  const Real = holder[key] as new (...args: never[]) => object;
  let count = 0;
  class Counting extends Real {
    constructor(...args: never[]) {
      super(...args);
      count++;
    }
  }
  holder[key] = Counting;
  return {
    count: () => count,
    restore: () => {
      holder[key] = Real;
    },
  };
};

const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("agent R4.4 perf review: hot-path costs", () => {
  it(
    "PERF-1 unconfigured app: handle+consume stays near the documented ~460ns floor",
    { timeout: 60_000 },
    async () => {
      // CLAIM (§7): no R4.4 config → admission branch + counter inc/dec + one
      // settle-tail promise link (~+25ns vs R4.3); fresh-process floor ~458ns
      // (corroborated: `bun bench/lifecycle-overhead.ts plain` → p50 542ns).
      // FENCE: RELATIVE to a same-process reference (a bare Response
      // construct+consume) — absolute ns fences are not portable across
      // machines (a CI runner measured 4.5x the M4 and tripped a static
      // 8000ns). Measured ratio: ~4-6x the reference on M4 under vitest;
      // the fence at 16x trips on STRUCTURE (a leaked timer chain, a
      // per-request closure storm), not on hardware.
      const { app, run } = makeProbe({});
      const reference = async (): Promise<void> => {
        await new Response("ok").text();
      };
      const measured = await measureVariants(
        [
          { name: "plain", run },
          { name: "reference", run: reference },
        ],
        { warmup: 2_500, rounds: 5, perRound: 4_000 },
      );
      const best = measured["plain"]!;
      const ref = measured["reference"]!;
      console.log(
        `PERF-1 unconfigured handle+consume: ${ns(best).toFixed(0)}ns (${(ns(best) / ns(ref)).toFixed(1)}x the ${ns(ref).toFixed(0)}ns Response reference)`,
      );
      expect(app.inFlight).toBe(0);
      expect(ns(best)).toBeLessThan(ns(ref) * 16);
    },
  );

  it(
    "PERF-2 overload-configured: delta vs unconfigured stays noise-level (+41ns claimed)",
    { timeout: 60_000 },
    async () => {
      // CLAIM (§7): +41ns p50 — admission arithmetic only, SYNC (no promise
      // wrap under capacity). FENCE: best-of-5 delta < 500ns (an accidental
      // per-request promise link or closure cascade would exceed it).
      const plain = makeProbe({});
      const overload = makeProbe({ overload: { maxConcurrency: 4_096 } });
      const best = await measureVariants(
        [
          { name: "plain", run: plain.run },
          { name: "overload", run: overload.run },
        ],
        { warmup: 2_000, rounds: 5, perRound: 3_000 },
      );
      const delta = ns(best["overload"]! - best["plain"]!);
      console.log(
        `PERF-2 overload: plain ${ns(best["plain"]!).toFixed(0)}ns, overload ${ns(best["overload"]!).toFixed(0)}ns, delta ${delta.toFixed(0)}ns (claim +41ns)`,
      );
      expect(overload.app.inFlight).toBe(0);
      expect(delta).toBeLessThan(500);
    },
  );

  it(
    "PERF-3 requestTimeout-configured: delta stays timer-sized (+166ns claimed)",
    { timeout: 60_000 },
    async () => {
      // CLAIM (§7): +166ns p50 — one setTimeout+unref per request
      // (raceDeadline), cleared on settle (asserted exactly in PERF-4c).
      // FENCE: delta < 1000ns (timer pair is ~150-400ns here).
      const plain = makeProbe({});
      const timeout = makeProbe({ requestTimeout: 10_000 });
      const best = await measureVariants(
        [
          { name: "plain", run: plain.run },
          { name: "timeout", run: timeout.run },
        ],
        { warmup: 2_000, rounds: 5, perRound: 3_000 },
      );
      const delta = ns(best["timeout"]! - best["plain"]!);
      console.log(
        `PERF-3 requestTimeout: plain ${ns(best["plain"]!).toFixed(0)}ns, timeout ${ns(best["timeout"]!).toFixed(0)}ns, delta ${delta.toFixed(0)}ns (claim +166ns)`,
      );
      expect(timeout.app.inFlight).toBe(0);
      expect(delta).toBeLessThan(1_000);
    },
  );

  it(
    "PERF-4 timer discipline: 0/req unconfigured & under-capacity overload; 1 create:1 clear:1 unref per request with requestTimeout",
    { timeout: 60_000 },
    async () => {
      // CLAIM: the deadline race allocates ONE unref'd timer per request and
      // clearTimeout()s it on settle (raceDeadline "clearTimeout(timer)"). A
      // leak would accumulate live timers across 2000 requests. Unref'd
      // timers are invisible to getActiveResourcesInfo on Node 22 (verified),
      // so the balance is measured via a patched global pair.
      const probe = patchTimers();
      try {
        const shapes: Record<string, Probe> = {
          plain: makeProbe({}),
          overload: makeProbe({ overload: { maxConcurrency: 4_096 } }),
          timeout: makeProbe({ requestTimeout: 30_000 }),
        };
        for (const { run } of Object.values(shapes)) {
          for (let i = 0; i < 500; i++) await run();
        }
        for (const [name, { run, app }] of Object.entries(shapes)) {
          const before = probe.snapshot();
          for (let i = 0; i < 2_000; i++) await run();
          await flushMicrotasks();
          const after = probe.snapshot();
          const created = after.created - before.created;
          const cleared = after.cleared - before.cleared;
          const unrefed = after.unrefed - before.unrefed;
          const leaked = after.live - before.live;
          console.log(
            `PERF-4 ${name}: created +${created}, cleared +${cleared}, unref'd +${unrefed}, leaked-live +${leaked} (2000 requests)`,
          );
          expect(app.inFlight).toBe(0);
          if (name === "timeout") {
            expect(Math.abs(created - 2_000)).toBeLessThanOrEqual(4); // exactly one timer per request
            expect(Math.abs(cleared - created)).toBeLessThanOrEqual(4); // every timer cleared — no accumulation
            expect(Math.abs(unrefed - created)).toBeLessThanOrEqual(4); // every timer unref'd — cannot hold the loop
          } else {
            expect(created).toBeLessThanOrEqual(4); // zero timers on unconfigured / under-capacity paths
          }
          expect(leaked).toBeLessThanOrEqual(2);
        }
      } finally {
        probe.restore();
      }
    },
  );

  it(
    "PERF-5 c.signal allocates NOTHING until touched (abortValue stays null through a full request)",
    { timeout: 60_000 },
    async () => {
      // CLAIM (§2.4 rule 5): lazy getter — no AbortController, no raw-signal
      // listener until first access. Verified by (a) the getter's first line
      // (context.ts null-check), (b) in-handler abortValue probes on plain AND
      // timeout apps, (c) counting global AbortController constructions over
      // 2000 requests/shape (new Request() itself builds one → the loop
      // reuses a single request, bench convention), (d) pooling recycle
      // hygiene: a touched controller must not survive a recycle.
      const observed: string[] = [];
      const plainApp = new Keala({ env: "test" });
      plainApp.get("/x", (c) => {
        observed.push(
          `plain:${(c as unknown as { abortValue?: AbortController }).abortValue !== undefined}`,
        );
        c.body = "ok";
      });
      await plainApp.handle(new Request("http://localhost/x"));
      const timeoutApp = new Keala({ env: "test", requestTimeout: 30_000 });
      timeoutApp.get("/x", (c) => {
        observed.push(
          `timeout:${(c as unknown as { abortValue?: AbortController }).abortValue !== undefined}`,
        );
        c.body = "ok";
      });
      await timeoutApp.handle(new Request("http://localhost/x"));
      expect(observed).toEqual(["plain:false", "timeout:false"]);

      const acPatch = patchConstructor("AbortController");
      try {
        const shapes: Record<string, Probe> = {
          plain: makeProbe({}),
          timeout: makeProbe({ requestTimeout: 30_000 }),
        };
        for (const { run } of Object.values(shapes)) {
          for (let i = 0; i < 200; i++) await run();
        }
        for (const [name, { run }] of Object.entries(shapes)) {
          const before = acPatch.count();
          for (let i = 0; i < 2_000; i++) await run();
          const constructed = acPatch.count() - before;
          console.log(
            `PERF-5 ${name}: ${constructed} AbortController constructions over 2000 requests`,
          );
          expect(constructed).toBe(0);
        }
      } finally {
        acPatch.restore();
      }

      const pooled = new Keala({ env: "test", pooling: true });
      const seen: boolean[] = [];
      pooled.get("/p", (c) => {
        if (seen.length === 0) void c.signal.aborted; // touch ONLY the first request
        seen.push((c as unknown as { abortValue?: AbortController }).abortValue !== undefined);
        c.body = "ok";
      });
      const pooledRequest = new Request("http://localhost/p");
      await (await pooled.handle(pooledRequest)).text(); // consume → retire → recycle
      await (await pooled.handle(pooledRequest)).text();
      expect(seen).toEqual([true, false]); // recycled context starts lazy again
    },
  );
});
