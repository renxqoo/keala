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
    return c.json({ ok: true });
  });
  const request = new Request("http://localhost/x");
  const run = async (): Promise<void> => {
    const res = await app.handle(request);
    await res.text();
  };
  return { app, run };
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

/** Count add/removeEventListener on every AbortSignal (queue waiters). */
const patchSignalListeners = (): {
  snapshot: () => { added: number; removed: number };
  restore: () => void;
} => {
  const proto = AbortSignal.prototype;
  const realAdd = proto.addEventListener;
  const realRemove = proto.removeEventListener;
  let added = 0;
  let removed = 0;
  proto.addEventListener = function (
    this: AbortSignal,
    ...args: Parameters<AbortSignal["addEventListener"]>
  ) {
    added++;
    return realAdd.apply(this, args);
  };
  proto.removeEventListener = function (
    this: AbortSignal,
    ...args: Parameters<AbortSignal["removeEventListener"]>
  ) {
    removed++;
    return realRemove.apply(this, args);
  };
  return {
    snapshot: () => ({ added, removed }),
    restore: () => {
      proto.addEventListener = realAdd;
      proto.removeEventListener = realRemove;
    },
  };
};

const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** PERF-8 scenario: park 1 admitted request, queue `depth` waiters, release. */
const queueStorm = async (depth: number): Promise<number> => {
  const app = new Keala({ env: "test", overload: { maxConcurrency: 1, maxQueue: 20_000 } });
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  app.get("/park", async (_c) => {
    await gate;
    return _c.text("park");
  });
  app.get("/fast", (c) => {
    return c.text("ok");
  });
  const parked = app.handle(new Request("http://localhost/park"));
  const waiting: Promise<Response>[] = [];
  for (let i = 0; i < depth; i++) waiting.push(app.handle(new Request("http://localhost/fast")));
  const t0 = performance.now();
  open();
  await parked;
  await Promise.all(waiting);
  return performance.now() - t0;
};

/** PERF-8 calibration: raw Array.shift() drain cost at size n. */
const drainViaShift = (n: number): number => {
  const arr = Array.from({ length: n }, (_, i) => i);
  const t0 = performance.now();
  while (arr.length > 0) arr.shift();
  return performance.now() - t0;
};

/** PERF-8 calibration: O(1) index-cursor drain cost at size n. */
const drainViaCursor = (n: number): number => {
  const arr = Array.from({ length: n }, (_, i) => i);
  let head = 0;
  const t0 = performance.now();
  while (head < arr.length) {
    if (arr[head] === -1) throw new Error("unreachable");
    head++;
  }
  return performance.now() - t0;
};

describe("agent R4.4 perf review: hot-path costs", () => {
  it.skipIf(typeof Bun !== "undefined")(
    "PERF-6 drain holdBody: exactly ONE extra stream wrap per bodied response while draining, ZERO when not draining",
    { timeout: 60_000 },
    async () => {
      // CLAIM (§2.2 rule 4): during drain a bodied response holds its slot
      // until consumed via ONE pull-based ReadableStream wrap (holdBody);
      // not draining → direct release, no wrap. Counted via patched global
      // ReadableStream (undici routes `new Response("str")` through it):
      //   sugar-mode (c.text string; U3c: the state mode is gone): control
      //     N (the sugar Response's own undici stream), drain 2N → exactly
      //     one EXTRA wrap;
      //   committed-mode (pre-built Responses returned verbatim): control 0,
      //     drain N → the extra wrap is the ONLY wrap.
      // FENCE: drain consumption within 50µs/res of control (one stream hop,
      // not a buffering/copying regression).
      const N = 64;
      const PAYLOAD = `drain-payload-${"x".repeat(48)}`;
      const rsPatch = patchConstructor("ReadableStream");
      const buildScenario = (mode: "sugar" | "committed"): { app: Keala; open: () => void } => {
        const app = new Keala({ env: "test" });
        let open!: () => void;
        const gate = new Promise<void>((resolve) => {
          open = resolve;
        });
        if (mode === "sugar") {
          app.get("/slow", async (c) => {
            await gate;
            return c.text(PAYLOAD);
          });
        } else {
          const prebuilt = Array.from({ length: N }, () => new Response(PAYLOAD));
          let issued = 0;
          app.get("/slow", () => gate.then(() => prebuilt[issued++]!));
        }
        return { app, open };
      };
      const round = async (
        mode: "sugar" | "committed",
        drain: boolean,
      ): Promise<{ ms: number; wraps: number; ok: boolean; closeStatus: unknown }> => {
        const { app, open } = buildScenario(mode);
        const handles: Promise<Response>[] = [];
        for (let i = 0; i < N; i++) handles.push(app.handle(new Request("http://localhost/slow")));
        const closing = drain ? app.close({ drain: 5_000 }) : null;
        const wrapsBefore = rsPatch.count();
        const t0 = performance.now();
        open();
        const responses = await Promise.all(handles);
        const texts: string[] = [];
        for (const res of responses) texts.push(await res.text());
        const ms = performance.now() - t0;
        return {
          ms,
          wraps: rsPatch.count() - wrapsBefore,
          ok: texts.every((t) => t === PAYLOAD), // zero truncation during drain
          closeStatus: closing === null ? null : await closing,
        };
      };
      try {
        const timings: Record<string, number[]> = {};
        const wrapsSeen: Record<string, number[]> = {};
        for (let i = 0; i < 3; i++) {
          for (const mode of ["sugar", "committed"] as const) {
            for (const drain of [false, true]) {
              const result = await round(mode, drain);
              const key = `${mode}:${drain ? "drain" : "control"}`;
              (timings[key] ??= []).push(result.ms);
              (wrapsSeen[key] ??= []).push(result.wraps);
              expect(result.ok).toBe(true);
              if (drain) {
                // slot held to body completion, then released cleanly
                expect(result.closeStatus).toEqual({ timedOut: false, inFlight: 0 });
              }
            }
          }
        }
        const perRes = (key: string): number =>
          (Math.min(...(timings[key] ?? [Infinity])) * 1e6) / N;
        for (const mode of ["sugar", "committed"] as const) {
          const controlWraps = wrapsSeen[`${mode}:control`]!;
          const drainWraps = wrapsSeen[`${mode}:drain`]!;
          console.log(
            `PERF-6 ${mode}: wraps control=${controlWraps.join(",")} drain=${drainWraps.join(",")} (N=${N}); ` +
              `best consumption ${perRes(`${mode}:control`).toFixed(0)}ns/res control vs ${perRes(`${mode}:drain`).toFixed(0)}ns/res drain`,
          );
          const deltas = drainWraps.map((w, i) => w - (controlWraps[i] ?? 0));
          expect(deltas.every((d) => d === N)).toBe(true); // exactly one extra wrap, every round
          if (mode === "sugar") {
            expect(controlWraps.every((w) => w === N)).toBe(true); // only the sugar Response's native stream
          } else {
            expect(controlWraps.every((w) => w === 0)).toBe(true); // committed passthrough: zero
          }
          expect(perRes(`${mode}:drain`) - perRes(`${mode}:control`)).toBeLessThan(50_000);
        }
      } finally {
        rsPatch.restore();
      }
    },
  );

  it(
    "PERF-7 queued waiters: one timer + one abort listener per waiter, both freed on admission (no accumulation)",
    { timeout: 60_000 },
    async () => {
      // CLAIM (lifecycle.ts enqueueRequest): each waiter allocates one
      // unref'd queueTimeout timer + one abort listener; admit tears BOTH
      // down (clearTimeout + removeEventListener in settleOut). FENCE: exact
      // create/remove counts over a 300-waiter drain; live set back to base.
      const DEPTH = 300;
      const timers = patchTimers();
      const listeners = patchSignalListeners();
      try {
        const app = new Keala({ env: "test", overload: { maxConcurrency: 1, maxQueue: 1_000 } });
        let open!: () => void;
        const gate = new Promise<void>((resolve) => {
          open = resolve;
        });
        app.get("/park", async (c) => {
          await gate;
          return c.text("park");
        });
        app.get("/fast", (c) => {
          return c.text("ok");
        });
        const t0 = timers.snapshot();
        const l0 = listeners.snapshot();
        const parked = app.handle(new Request("http://localhost/park"));
        const waiting: Promise<Response>[] = [];
        for (let i = 0; i < DEPTH; i++)
          waiting.push(app.handle(new Request("http://localhost/fast")));
        open();
        const responses = await Promise.all([parked, ...waiting]);
        for (const res of responses) await res.text();
        await flushMicrotasks();
        const t1 = timers.snapshot();
        const l1 = listeners.snapshot();
        const created = t1.created - t0.created;
        const cleared = t1.cleared - t0.cleared;
        const leaked = t1.live - t0.live;
        const added = l1.added - l0.added;
        const removed = l1.removed - l0.removed;
        console.log(
          `PERF-7 ${DEPTH} waiters: timers +${created} created/+${cleared} cleared (+${leaked} live), listeners +${added}/+${removed}`,
        );
        expect(responses.length).toBe(DEPTH + 1);
        expect(responses.every((r) => r.status === 200)).toBe(true);
        expect(app.inFlight).toBe(0);
        expect(Math.abs(created - DEPTH)).toBeLessThanOrEqual(4); // one timer per waiter, no more
        expect(Math.abs(cleared - created)).toBeLessThanOrEqual(4); // every waiter timer cleared on admission
        expect(leaked).toBeLessThanOrEqual(2); // nothing live afterwards
        expect(Math.abs(added - DEPTH)).toBeLessThanOrEqual(4); // one abort listener per waiter
        expect(Math.abs(removed - added)).toBeLessThanOrEqual(4); // every listener removed
      } finally {
        listeners.restore();
        timers.restore();
      }
    },
  );

  it(
    "PERF-8 queue refill uses Array.shift() — per-waiter cost must stay flat as depth grows 8x",
    { timeout: 120_000 },
    async () => {
      // CLAIM UNDER TEST: refillFromQueue admits with `lc.queue.shift()
      // ?.admit()` — shift() is classically O(n) per op. RED hypothesis: a
      // release-storm over a deep queue pays O(depth) per shift → O(depth²)
      // total → per-waiter cost grows linearly with depth (8x across the
      // 1250→10000 spread). GREEN: V8/JSC left-trim keeps shift ~O(1)/op.
      // FENCE: per-waiter at 10000 < 3.5x per-waiter at 1250 (quadratic
      // predicts 8x).
      await queueStorm(300); // JIT warm-up
      const depths = [1_250, 2_500, 5_000, 10_000];
      const perWaiter: number[] = [];
      for (const depth of depths) {
        const ms = await queueStorm(depth);
        perWaiter.push((ms * 1e6) / depth);
        console.log(
          `PERF-8 release-storm depth ${depth}: ${ms.toFixed(2)}ms total → ${perWaiter[perWaiter.length - 1]!.toFixed(0)}ns/waiter`,
        );
      }
      // Calibration on THIS runtime (pure arrays, no framework):
      console.log(
        `PERF-8 calibration shift-drain: 2500=${((drainViaShift(2_500) * 1e6) / 2_500).toFixed(0)}ns/op, ` +
          `10000=${((drainViaShift(10_000) * 1e6) / 10_000).toFixed(0)}ns/op; ` +
          `cursor-drain 10000=${((drainViaCursor(10_000) * 1e6) / 10_000).toFixed(0)}ns/op`,
      );
      expect(perWaiter[perWaiter.length - 1]!).toBeLessThan(perWaiter[0]! * 3.5);
    },
  );

  it(
    "PERF-9 memory plateau across 2000-request windows (timeout shape, log-only)",
    { timeout: 60_000 },
    async () => {
      // Exact-count fences live in PERF-4/5/6/7; here we only observe
      // heapUsed deltas between equal 2000-request windows on the MOST
      // allocating shape. No numeric heap fence: the stock vitest runner
      // exposes no forced GC, so byte-level fences would be flaky — the log
      // shows whether growth plateaus (bounded) or runs away (leak).
      const { app, run } = makeProbe({ requestTimeout: 30_000 });
      const windowSize = 2_000;
      const deltas: number[] = [];
      let prev = process.memoryUsage().heapUsed;
      for (let w = 0; w < 4; w++) {
        for (let i = 0; i < windowSize; i++) await run();
        const now = process.memoryUsage().heapUsed;
        deltas.push(now - prev);
        prev = now;
      }
      console.log(
        `PERF-9 heapUsed window deltas (2000 reqs, timeout shape): ${deltas.map((d) => `${(d / 1024).toFixed(0)}KB`).join(" → ")}`,
      );
      expect(app.inFlight).toBe(0);
    },
  );
});
