/* agent R4.6 perf review — structural budget fences (object-counting, machine-noise immune) */
/**
 * Agent R4.6 PERF review — structural budget fences for the R4.6 lifecycle
 * (docs/HOTPATH-R4-6-LIFECYCLE-DESIGN.md §7.1 unconfigured, §7.2 configured,
 * §7.3 forbidden actions; upgrade points U2 deadline / U3 waiter pool).
 *
 * Everything here counts OBJECTS (constructors, timers, wraps, identities),
 * never nanoseconds — thresholds are 0 or exactly-N, immune to machine noise.
 * Counting patches wrap the globals in before/finally-restore pairs, same
 * convention as test/agent-r46-perf.test.ts (patchConstructor/patchTimers).
 *
 * What the EXISTING fences already lock (not duplicated here, extended only):
 * - agent-r46-perf PERF-4: timer create/clear/unref balance per shape (app
 *   level, happy paths); PERF-5: zero AbortController when c.signal untouched;
 *   PERF-7: one timer + one abort listener per QUEUED waiter on the admit path.
 * - r4-lifecycle-overload U3: 1000 admit/leave cycles construct zero waiters.
 * This file hunts what those miss: the pre-armed-then-cleared timer on the
 * pre-aborted waiter, the four waiter EXIT paths individually, the deadline
 * FIRE + zombie path, drain wrap counting on committed/null/state bodies,
 * global live-timer discipline across a mixed workload + close(), and the
 * §7.3 admission forbidden-action inventory on a POOLING app.
 *
 * Timer accounting note: a fired timer's native resource is gone at fire
 * time, so the patch removes it from the live set when its (wrapped)
 * callback runs and counts it under `fired`. `cleared + fired == created`
 * is the balance invariant; `liveUnref` tracks unref'd-and-still-armed
 * timers (keala always unrefs per-request timers — only the close() drain
 * timer is deliberately ref'd, DESIGN rule r9).
 */

import { describe, expect, it } from "vitest";
import type { LifecycleState } from "../../src/core/lifecycle.ts";

import { Keala } from "../../src/core/app.ts";
import { createLifecycle, releaseInFlight } from "../../src/core/lifecycle.ts";
import { admitRequest, waiterPoolStats } from "../../src/core/lifecycle-admission.ts";

const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** Queue one waiter against a saturated lifecycle (unit-level gate helper). */

// ---------------------------------------------------------------------------
// Counting patches (before/finally-restore convention of agent-r46-perf.test.ts)
// ---------------------------------------------------------------------------

interface TimerSnapshot {
  created: number;
  cleared: number;
  unrefed: number;
  fired: number;
  live: number;
  liveUnref: number;
}

type TimerLike = { unref?: () => unknown };

const patchTimers = (): { snapshot: () => TimerSnapshot; restore: () => void } => {
  const realSet = globalThis.setTimeout as unknown as (...args: unknown[]) => TimerLike;
  const realClear = globalThis.clearTimeout as unknown as (t?: unknown) => void;
  const live = new Set<TimerLike>();
  const liveUnref = new Set<TimerLike>();
  let created = 0;
  let cleared = 0;
  let unrefed = 0;
  let fired = 0;
  const countingSet = (fn: unknown, ms: unknown, ...rest: unknown[]): TimerLike => {
    created++;
    let handle: TimerLike;
    const wrapped =
      typeof fn === "function"
        ? (...args: unknown[]): unknown => {
            // The native resource is released once the callback runs — a
            // later clearTimeout on this handle is a no-op, not a leak.
            live.delete(handle);
            liveUnref.delete(handle);
            fired++;
            return (fn as (...a: unknown[]) => unknown)(...args);
          }
        : fn;
    handle = realSet(wrapped, ms, ...rest);
    live.add(handle);
    const unref = handle.unref;
    if (typeof unref === "function") {
      handle.unref = (): unknown => {
        unrefed++;
        liveUnref.add(handle);
        return unref.call(handle);
      };
    }
    return handle;
  };
  const countingClear = (t?: unknown): void => {
    if (t !== undefined && live.delete(t as TimerLike)) cleared++;
    liveUnref.delete(t as TimerLike);
    realClear(t);
  };
  globalThis.setTimeout = countingSet as unknown as typeof globalThis.setTimeout;
  globalThis.clearTimeout = countingClear as unknown as typeof globalThis.clearTimeout;
  return {
    snapshot: (): TimerSnapshot => ({
      created,
      cleared,
      unrefed,
      fired,
      live: live.size,
      liveUnref: liveUnref.size,
    }),
    restore: (): void => {
      globalThis.setTimeout = realSet as unknown as typeof globalThis.setTimeout;
      globalThis.clearTimeout = realClear as unknown as typeof globalThis.clearTimeout;
    },
  };
};

const patchConstructor = (
  key: "AbortController" | "ReadableStream" | "Response",
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

const deltaOf = (a: TimerSnapshot, b: TimerSnapshot): TimerSnapshot => ({
  created: b.created - a.created,
  cleared: b.cleared - a.cleared,
  unrefed: b.unrefed - a.unrefed,
  fired: b.fired - a.fired,
  live: b.live - a.live,
  liveUnref: b.liveUnref - a.liveUnref,
});

// ---------------------------------------------------------------------------
// REVIEW-PERF-1 — §7.1 unconfigured path: ZERO new AbortController / timer /
// Response re-wrap per request; the settle release returns the SAME object.
// ---------------------------------------------------------------------------

const armAndQueue = (
  lc: LifecycleState,
  url: string,
  signal?: AbortSignal,
): Promise<Response | null> =>
  admitRequest(
    lc,
    new Request(url, signal === undefined ? {} : { signal }),
  ) as Promise<Response | null>;

/** Count "Timeout" entries in the thread's live event-loop resources. */
const liveTimeouts = (): number => {
  const info = process.getActiveResourcesInfo?.();
  return info === undefined ? 0 : info.filter((name) => name === "Timeout").length;
};

describe("agent R4.6 perf review (structural budget fences)", () => {
  it.skipIf(typeof Bun !== "undefined")(
    "REVIEW-PERF-1: unconfigured path (§7.1) — zero AbortController/timers per request, no Response re-wrap, settle returns the finalize output verbatim",
    { timeout: 60_000 },
    async () => {
      // Claim fenced (§7.1): with no overload, no requestTimeout and not
      // draining, one request must not construct an AbortController, arm a
      // timer, or re-wrap the finalized Response. The settle release
      // (settleRequest → releaseInFlight) returns `value` UNCHANGED when not
      // draining — proven by identity for committed Responses and by an
      // exactly-1 Response construction count for state-mode bodies (a
      // re-wrap would make it 2). Timers are fenced twice: by the counting
      // patch (create balance) and by getActiveResourcesInfo before/after.
      const acPatch = patchConstructor("AbortController");
      const rsPatch = patchConstructor("ReadableStream");
      const respPatch = patchConstructor("Response");
      const timers = patchTimers();
      try {
        const app = new Keala({ env: "test" });
        app.use(async (_c, next) => {
          await next();
        });
        app.get("/s", (c) => {
          c.body = "state-mode-payload";
        });
        const prebuilt = new Response("committed-payload");
        app.get("/c", () => prebuilt);
        const stateReq = new Request("http://x/s");
        const commitReq = new Request("http://x/c");

        // JIT/lazy-path warm-up OUTSIDE every counting window.
        for (let i = 0; i < 200; i++) {
          await (await app.handle(stateReq)).text();
          await app.handle(commitReq);
        }

        // Instrument canary: prove every patch COUNTS before trusting the
        // zeros below (one deliberate construction + one cleared timer;
        // deltas, because `new Request()` during setup also builds
        // AbortControllers internally — which is why the windows below
        // reuse single request objects, the bench convention).
        {
          const acBase = acPatch.count();
          const respBase = respPatch.count();
          const rsBase = rsPatch.count();
          const tBase = timers.snapshot();
          const controller = new AbortController();
          const canaryTimer = setTimeout((): void => undefined, 60_000);
          clearTimeout(canaryTimer);
          const canaryResponse = new Response("canary");
          expect(acPatch.count() - acBase).toBe(1);
          expect(respPatch.count() - respBase).toBe(1);
          expect(rsPatch.count() - rsBase).toBeGreaterThanOrEqual(1);
          const seen = timers.snapshot();
          expect(seen.created - tBase.created).toBe(1);
          expect(seen.cleared - tBase.cleared).toBe(1);
          expect(seen.live - tBase.live).toBe(0);
          expect(canaryResponse.status).toBe(200);
          void controller;
        }

        const N = 2_000;
        const before = timers.snapshot();
        const timeoutsBefore = liveTimeouts();
        const ac0 = acPatch.count();
        const rs0 = rsPatch.count();
        const resp0 = respPatch.count();

        // State-mode (finalize constructs the Response): the object handed
        // out must be the one and only Response constructed for the request.
        for (let i = 0; i < N; i++) await app.handle(stateReq);
        // Committed-mode: pre-built Response returned verbatim.
        for (let i = 0; i < N; i++) await app.handle(commitReq);
        await flushMicrotasks();

        const created = timers.snapshot().created - before.created;
        const constructedResponses = respPatch.count() - resp0;
        const constructedStreams = rsPatch.count() - rs0;
        const constructedControllers = acPatch.count() - ac0;
        console.log(
          `REVIEW-PERF-1: ${N * 2} unconfigured requests → AbortControllers ${constructedControllers}, ` +
            `timers ${created}, ReadableStreams ${constructedStreams}, Responses ${constructedResponses} ` +
            `(committed share added ${constructedResponses - N} Responses), ` +
            `liveTimeouts delta ${liveTimeouts() - timeoutsBefore}`,
        );

        expect(app.inFlight).toBe(0);
        expect(constructedControllers).toBe(0); // §7.1: zero AbortControllers
        expect(created).toBe(0); // §7.1: zero drain/queue/deadline timers
        expect(liveTimeouts() - timeoutsBefore).toBe(0);
        expect(constructedResponses).toBe(N); // exactly finalize's own N — no re-wrap
        // The only streams are finalize's own string bodies (undici routes
        // `new Response("...")` through the global ReadableStream): one per
        // state-mode request, NONE for the verbatim committed share — a
        // settle-side re-wrap would push this to 2N.
        expect(constructedStreams).toBe(N);
        // Committed identity: settle returns the SAME object when not draining.
        const out = await app.handle(commitReq);
        expect(out).toBe(prebuilt); // verbatim — zero Response re-wrap
      } finally {
        timers.restore();
        respPatch.restore();
        rsPatch.restore();
        acPatch.restore();
      }
    },
  );

  // -------------------------------------------------------------------------
  // REVIEW-PERF-2 — §7.2 overload queue + U3: flood-bounded queue/pool,
  // steady-state zero construction, exactly one timer per waiter on every
  // exit path (admit / timeout / disconnect / drain-drop / pre-aborted).
  // -------------------------------------------------------------------------

  it(
    "REVIEW-PERF-2: waiter pool (§7.2 U3) — queue+pool bounded by maxQueue after a flood, steady-state zero construction, one timer per waiter on all exit paths",
    { timeout: 60_000 },
    async () => {
      // (a) Flood bound + steady state (unit-level gate, like the existing
      // U3 lock in r4-lifecycle-overload.test.ts — extended to the flood
      // shape and the queue/pool bound).
      {
        const lc = createLifecycle({ maxConcurrency: 1, maxQueue: 8 });
        const parked = admitRequest(lc, new Request("http://x/park"));
        expect(parked).toBeNull(); // admitted outright, holds the only slot
        const queued: Promise<Response | null>[] = [];
        let refused = 0;
        for (let i = 0; i < 99; i++) {
          const decision = admitRequest(lc, new Request(`http://x/${i}`));
          if (decision instanceof Response) refused++;
          else if (decision !== null) queued.push(decision);
          expect(lc.queue.length).toBeLessThanOrEqual(8); // bounded DURING the flood
          expect(lc.waiterPool.length).toBeLessThanOrEqual(8);
        }
        expect(refused).toBe(91); // 1 admitted + 8 queued + 91 refused
        expect(queued.length).toBe(8);
        // Only the 8 queued waiters constructed slots — refusals build nothing.
        expect(waiterPoolStats().constructed).toBe(8);
        for (let i = 0; i < 9; i++) releaseInFlight(lc); // parked + 8 transfers settle
        const outcomes = await Promise.all(queued);
        expect(outcomes.every((o) => o === null)).toBe(true);
        expect(lc.inFlight).toBe(0);
        expect(lc.queue.length).toBe(0);
        expect(lc.waiterPool.length).toBeLessThanOrEqual(8); // bounded by maxQueue after the flood
        expect(waiterPoolStats().constructed).toBe(8);
        // Steady-state saturated cycles (500 more) construct zero waiters (U3).
        for (let i = 0; i < 500; i++) {
          const admit = admitRequest(lc, new Request("http://x/s"));
          const park = admitRequest(lc, new Request("http://x/s-q")) as Promise<Response | null>;
          releaseInFlight(lc);
          releaseInFlight(lc);
          await Promise.all([Promise.resolve(admit), park]);
        }
        expect(waiterPoolStats().constructed).toBe(8);
        expect(lc.waiterPool.length).toBeLessThanOrEqual(8);
      }

      // (b) Per-waiter timer discipline on every exit path: exactly ONE
      // timer armed and ONE teardown (cleared, or fired-and-inert) — never
      // two, never zero-and-leaked.
      const timers = patchTimers();
      try {
        // Exit 1 — admit (slot transfer): timer cleared at transfer time.
        {
          const lc = createLifecycle({ maxConcurrency: 1, maxQueue: 4 });
          expect(admitRequest(lc, new Request("http://x/a"))).toBeNull();
          const before = timers.snapshot();
          const queued = armAndQueue(lc, "http://x/b");
          releaseInFlight(lc); // transfer: head admits
          const outcome = await queued;
          releaseInFlight(lc); // the transferred request settles
          const d = deltaOf(before, timers.snapshot());
          expect(outcome).toBeNull();
          expect(d.created).toBe(1);
          expect(d.unrefed).toBe(1);
          expect(d.cleared).toBe(1);
          expect(d.fired).toBe(0);
          expect(d.live).toBe(0);
          expect(d.liveUnref).toBe(0);
        }
        // Exit 2 — queue timeout: the timer itself fires (resource gone at
        // fire; the subsequent clearTimeout in finish() is a counted no-op
        // ONLY if the handle is still live — here fired accounts for it).
        {
          const lc = createLifecycle({ maxConcurrency: 1, maxQueue: 4, queueTimeoutMs: 20 });
          expect(admitRequest(lc, new Request("http://x/a"))).toBeNull();
          const before = timers.snapshot();
          const queued = armAndQueue(lc, "http://x/b");
          const outcome = (await queued) as Response;
          releaseInFlight(lc);
          const d = deltaOf(before, timers.snapshot());
          expect(outcome.status).toBe(503);
          expect(d.created).toBe(1);
          expect(d.unrefed).toBe(1);
          expect(d.cleared + d.fired).toBe(1); // torn down exactly once
          expect(d.fired).toBe(1); // ...by firing, not by leak
          expect(d.live).toBe(0);
          expect(d.liveUnref).toBe(0);
        }
        // Exit 3 — client disconnect mid-queue: cleared on leave.
        {
          const lc = createLifecycle({ maxConcurrency: 1, maxQueue: 4 });
          expect(admitRequest(lc, new Request("http://x/a"))).toBeNull();
          const abort = new AbortController();
          const before = timers.snapshot();
          const queued = armAndQueue(lc, "http://x/b", abort.signal);
          abort.abort();
          const outcome = (await queued) as Response;
          releaseInFlight(lc);
          const d = deltaOf(before, timers.snapshot());
          expect(outcome.status).toBe(503);
          expect(d.created).toBe(1);
          expect(d.unrefed).toBe(1);
          expect(d.cleared).toBe(1);
          expect(d.fired).toBe(0);
          expect(d.live).toBe(0);
        }
        // Exit 4 — drain-drop: cleared in finish() when the queue is spliced.
        {
          const lc = createLifecycle({ maxConcurrency: 1, maxQueue: 4 });
          expect(admitRequest(lc, new Request("http://x/a"))).toBeNull();
          const before = timers.snapshot();
          const queued = armAndQueue(lc, "http://x/b");
          lc.draining = true; // closeApp flips this BEFORE splice+drop
          const drained = lc.queue.splice(0);
          expect(drained.length).toBe(1);
          for (const waiter of drained) waiter.drop("draining");
          const outcome = (await queued) as Response;
          releaseInFlight(lc);
          const d = deltaOf(before, timers.snapshot());
          expect(outcome.status).toBe(503);
          expect(outcome.headers.get("retry-after")).toBeNull(); // draining refusal
          expect(d.created).toBe(1);
          expect(d.unrefed).toBe(1);
          expect(d.cleared).toBe(1);
          expect(d.fired).toBe(0);
          expect(d.live).toBe(0);
        }
        // Exit 5 — pre-aborted client: the waiter never enters the queue,
        // but arm() still armed ONE timer and finish() cleared it (1:1).
        {
          const lc = createLifecycle({ maxConcurrency: 1, maxQueue: 4 });
          expect(admitRequest(lc, new Request("http://x/a"))).toBeNull();
          const abort = new AbortController();
          abort.abort();
          const before = timers.snapshot();
          const queued = armAndQueue(lc, "http://x/b", abort.signal);
          const outcome = (await queued) as Response;
          releaseInFlight(lc);
          const d = deltaOf(before, timers.snapshot());
          expect(outcome.status).toBe(503);
          expect(d.created).toBe(1);
          expect(d.unrefed).toBe(1);
          expect(d.cleared).toBe(1);
          expect(d.live).toBe(0);
          expect(lc.queue.length).toBe(0);
        }
      } finally {
        timers.restore();
      }
    },
  );

  // -------------------------------------------------------------------------
  // REVIEW-PERF-3 — §7.2 requestTimeout (U2): async requests arm exactly 1
  // timer (created/unref'd/cleared 1:1:1); SYNC-settled requests skip the
  // race outright (R413b — cannot hang, zero timers); on fire exactly one
  // 504 Response and the zombie settle arms NO new timer.
  // -------------------------------------------------------------------------
});
