/* eslint-disable max-lines -- one audit file per the task mandate (6 budget fences; agent restricted to this single file) */
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

import { describe, expect, it, vi } from "vitest";

import { Keala } from "../src/core/app.ts";
import { createLifecycle, releaseInFlight } from "../src/core/lifecycle.ts";
import { admitRequest, waiterPoolStats } from "../src/core/lifecycle-admission.ts";
import type { LifecycleState } from "../src/core/lifecycle.ts";

const deferred = <T = void>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** Queue one waiter against a saturated lifecycle (unit-level gate helper). */
const armAndQueue = (
  lc: LifecycleState,
  url: string,
  signal?: AbortSignal,
): Promise<Response | null> =>
  admitRequest(lc, new Request(url, signal === undefined ? {} : { signal })) as Promise<
    Response | null
  >;

/** Count "Timeout" entries in the thread's live event-loop resources. */
const liveTimeouts = (): number => {
  const info = process.getActiveResourcesInfo?.();
  return info === undefined ? 0 : info.filter((name) => name === "Timeout").length;
};

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

describe("agent R4.6 perf review (structural budget fences)", () => {
  it(
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
  // REVIEW-PERF-3 — §7.2 requestTimeout (U2): exactly 1 timer created,
  // unref'd and cleared per configured request (sync settle included); on
  // fire exactly one 504 Response and the zombie settle arms NO new timer.
  // -------------------------------------------------------------------------

  it(
    "REVIEW-PERF-3: deadline (§7.2 U2) — 1 create/1 unref/1 clear per request incl. sync settle; fire path yields exactly one 504 and a zero-timer zombie settle",
    { timeout: 60_000 },
    async () => {
      const timers = patchTimers();
      try {
        // (a) SYNC requests on a deadline-configured app (immediate settle):
        // the race still arms exactly one unref'd timer and clears it in the
        // settle microtask — create:unref:clear = 1:1:1 per request.
        {
          const app = new Keala({ env: "test", requestTimeout: 30_000 });
          app.get("/s", (c) => {
            c.body = "sync";
          });
          const req = new Request("http://x/s");
          for (let i = 0; i < 100; i++) await app.handle(req); // warm-up
          const before = timers.snapshot();
          const N = 1_000;
          for (let i = 0; i < N; i++) await app.handle(req);
          await flushMicrotasks();
          const d = deltaOf(before, timers.snapshot());
          console.log(
            `REVIEW-PERF-3 sync: ${N} deadline-configured requests → created ${d.created}, ` +
              `unref'd ${d.unrefed}, cleared ${d.cleared}, fired ${d.fired}, live ${d.live}`,
          );
          expect(app.inFlight).toBe(0);
          expect(d.created).toBe(N);
          expect(d.unrefed).toBe(N);
          expect(d.cleared).toBe(N);
          expect(d.fired).toBe(0);
          expect(d.live).toBe(0);
          expect(d.liveUnref).toBe(0);
        }
        // (b) ASYNC requests settling before the deadline: same 1:1:1 shape.
        {
          const app = new Keala({ env: "test", requestTimeout: 30_000 });
          app.get("/a", async (c) => {
            await Promise.resolve(); // settle in a microtask, well before the deadline
            c.body = "async";
          });
          const req = new Request("http://x/a");
          for (let i = 0; i < 50; i++) await app.handle(req);
          const before = timers.snapshot();
          const N = 500;
          for (let i = 0; i < N; i++) await app.handle(req);
          await flushMicrotasks();
          const d = deltaOf(before, timers.snapshot());
          expect(d.created).toBe(N);
          expect(d.unrefed).toBe(N);
          expect(d.cleared).toBe(N);
          expect(d.live).toBe(0);
        }
        // (c) Fire path: exactly one 504 Response, one fired timer, and the
        // zombie's late settle arms NO new timer (the once-guard).
        const respPatch = patchConstructor("Response");
        try {
          const app = new Keala({ env: "test", requestTimeout: 25 });
          const gate = deferred();
          app.get("/stuck", () => gate.promise.then(() => undefined));
          const before = timers.snapshot();
          const resp0 = respPatch.count();
          const response = await app.handle(new Request("http://x/stuck"));
          const at504 = deltaOf(before, timers.snapshot());
          const responsesAt504 = respPatch.count() - resp0;
          expect(response.status).toBe(504);
          expect(await response.text()).toBe("request deadline exceeded");
          expect(app.inFlight).toBe(0); // capacity freed at 504 time
          expect(at504.created).toBe(1); // ONE deadline timer, no more
          expect(at504.unrefed).toBe(1);
          expect(at504.fired).toBe(1); // it won the race by firing
          expect(at504.live).toBe(0);
          expect(responsesAt504).toBe(1); // exactly one Response: the 504 itself
          // Zombie settle: the gate resolves long after the 504 — the
          // once-guard must contain it WITHOUT arming a new timer. (No
          // wait() helper here: its setTimeout would pollute the count —
          // microtask + macrotask turns are enough for the settle chain.)
          gate.resolve();
          await flushMicrotasks();
          await new Promise<void>((resolve) => setImmediate(resolve));
          await new Promise<void>((resolve) => setImmediate(resolve));
          const afterZombie = deltaOf(before, timers.snapshot());
          expect(afterZombie.created).toBe(at504.created); // zero new timers
          expect(afterZombie.live).toBe(0);
          expect(app.inFlight).toBe(0); // and no double release
        } finally {
          respPatch.restore();
        }
      } finally {
        timers.restore();
      }
    },
  );

  // -------------------------------------------------------------------------
  // REVIEW-PERF-4 — §7.2 drain: holdBody wraps a bodied response in EXACTLY
  // one extra ReadableStream+Response; zero wraps when not draining or when
  // the body is null.
  // -------------------------------------------------------------------------

  it(
    "REVIEW-PERF-4: drain (§7.2) — exactly one extra ReadableStream+Response per bodied drain settle, zero when not draining or body null",
    { timeout: 60_000 },
    async () => {
      const rsPatch = patchConstructor("ReadableStream");
      const respPatch = patchConstructor("Response");
      try {
        const K = 4;
        const PAYLOAD = `review-drain-payload-${"y".repeat(48)}`;
        type Mode = "committed" | "null" | "state";
        const buildApp = (mode: Mode): { app: Keala; gate: { promise: Promise<void>; resolve: () => void } } => {
          const app = new Keala({ env: "test" });
          const gate = deferred();
          if (mode === "state") {
            app.get("/d", async (c) => {
              await gate.promise;
              c.body = PAYLOAD;
            });
          } else {
            const prebuilt = Array.from(
              { length: K },
              () => (mode === "committed" ? new Response(PAYLOAD) : new Response(null, { status: 204 })),
            );
            let issued = 0;
            app.get("/d", () => gate.promise.then(() => prebuilt[issued++]!));
          }
          return { app, gate };
        };
        const round = async (
          mode: Mode,
          draining: boolean,
        ): Promise<{ streams: number; responses: number; status: unknown; ok: boolean }> => {
          const { app, gate } = buildApp(mode);
          const handles: Promise<Response>[] = [];
          for (let i = 0; i < K; i++) handles.push(app.handle(new Request("http://x/d")));
          const closing = draining ? app.close({ drain: 5_000 }) : null;
          const rs0 = rsPatch.count();
          const resp0 = respPatch.count();
          gate.resolve();
          const responses = await Promise.all(handles);
          const texts: string[] = [];
          for (const res of responses) texts.push(await res.text());
          return {
            streams: rsPatch.count() - rs0,
            responses: respPatch.count() - resp0,
            status: closing === null ? null : await closing,
            ok: responses.every((res, i) => res.status === (mode === "null" ? 204 : 200) && (mode === "null" ? texts[i] === "" : texts[i] === PAYLOAD)),
          };
        };
        // Control rounds (not draining) — also repeated so the state-mode
        // finalize baseline is measured under identical conditions.
        const committedControl = await round("committed", false);
        const stateControl = await round("state", false);
        const committedDrain = await round("committed", true);
        const nullDrain = await round("null", true);
        const stateDrain = await round("state", true);
        console.log(
          `REVIEW-PERF-4 (K=${K}): committed control ${committedControl.streams}RS/${committedControl.responses}R, ` +
            `drain ${committedDrain.streams}RS/${committedDrain.responses}R; null-body drain ${nullDrain.streams}RS/${nullDrain.responses}R; ` +
            `state control ${stateControl.streams}RS/${stateControl.responses}R, drain ${stateDrain.streams}RS/${stateDrain.responses}R`,
        );
        // Zero wraps when not draining (committed: not even finalize wraps).
        expect(committedControl.ok).toBe(true);
        expect(committedControl.streams).toBe(0);
        expect(committedControl.responses).toBe(0);
        // EXACTLY one extra ReadableStream + one wrapper Response per bodied
        // response while draining — the holdBody wrap is the ONLY wrap.
        expect(committedDrain.ok).toBe(true);
        expect(committedDrain.streams).toBe(K);
        expect(committedDrain.responses).toBe(K);
        expect(committedDrain.status).toEqual({ timedOut: false, inFlight: 0 });
        // Zero wraps for a null body even while draining.
        expect(nullDrain.ok).toBe(true);
        expect(nullDrain.streams).toBe(0);
        expect(nullDrain.responses).toBe(0);
        expect(nullDrain.status).toEqual({ timedOut: false, inFlight: 0 });
        // State-mode: drain cost = control + exactly one wrap per response.
        expect(stateControl.ok).toBe(true);
        expect(stateControl.responses).toBe(K); // finalize's own Response only
        expect(stateDrain.ok).toBe(true);
        expect(stateDrain.streams - stateControl.streams).toBe(K);
        expect(stateDrain.responses - stateControl.responses).toBe(K);
        expect(stateDrain.status).toEqual({ timedOut: false, inFlight: 0 });
      } finally {
        respPatch.restore();
        rsPatch.restore();
      }
    },
  );

  // -------------------------------------------------------------------------
  // REVIEW-PERF-5 — global timer discipline (§7.1 zero-timer unconfigured,
  // §7.2 drain row): after a mixed workload (plain / overload-saturated with
  // queue + drain-drop / deadline settle + fire) plus COMPLETED close()
  // calls, zero keala-created timers remain live; drain:Infinity arms none.
  // -------------------------------------------------------------------------

  it(
    "REVIEW-PERF-5: global timer discipline — zero live keala timers after a mixed workload plus completed close() (drain:Infinity arms none)",
    { timeout: 60_000 },
    async () => {
      const timers = patchTimers();
      try {
        const before = timers.snapshot();
        const timeoutsBefore = liveTimeouts();

        // Variant 1 — plain unconfigured app.
        const plain = new Keala({ env: "test" });
        plain.get("/p", (c) => {
          c.body = "p";
        });
        const plainReq = new Request("http://x/p");
        for (let i = 0; i < 300; i++) await plain.handle(plainReq);

        // Variant 2 — overload-saturated flood: 4 admitted, 64 queued (their
        // waiter timers), 132 fail-fast refusals; close() drain-DROPS the
        // queued waiters mid-arm, then the drain timer itself is cleared at
        // completion.
        const satGate = deferred();
        const sat = new Keala({ env: "test", overload: { maxConcurrency: 4, maxQueue: 64 } });
        sat.get("/s", async (c) => {
          await satGate.promise;
          c.body = "s";
        });
        const satReq = new Request("http://x/s");
        const flood: Promise<Response>[] = [];
        for (let i = 0; i < 200; i++) flood.push(sat.handle(satReq));
        const closingSat = sat.close({ drain: 500 }); // flips draining, splices the queue
        satGate.resolve();
        const satResults = await Promise.all(flood);
        for (const res of satResults) await res.text(); // drain holds release on body completion
        await closingSat;
        expect(satResults.filter((r) => r.status === 200)).toHaveLength(4);
        expect(satResults.filter((r) => r.status === 503)).toHaveLength(196);
        expect(sat.inFlight).toBe(0);

        // Variant 3 — deadline-configured: settles-before-deadline requests.
        const dl = new Keala({ env: "test", requestTimeout: 60_000 });
        dl.get("/d", (c) => {
          c.body = "d";
        });
        const dlReq = new Request("http://x/d");
        for (let i = 0; i < 300; i++) await dl.handle(dlReq);

        // Variant 4 — deadline FIRE (the timer wins; resource gone at fire).
        const fireGate = deferred();
        const fire = new Keala({ env: "test", requestTimeout: 20 });
        fire.get("/stuck", () => fireGate.promise.then(() => undefined));
        const fired = await fire.handle(new Request("http://x/stuck"));
        expect(fired.status).toBe(504);
        fireGate.resolve(); // zombie settle — arms nothing

        // Completed closes (idle apps arm no timer at all).
        await plain.close({ drain: 50 });
        await dl.close();
        await fire.close();

        // Close with in-flight work: the REF'd drain timer (rule r9) must be
        // created and then cleared when the counter reaches zero.
        {
          const app = new Keala({ env: "test" });
          const gate = deferred();
          app.get("/hold", async (c) => {
            await gate.promise;
            c.body = "h";
          });
          const held = app.handle(new Request("http://x/hold"));
          const closing = app.close({ drain: 300 });
          gate.resolve();
          expect(await (await held).text()).toBe("h");
          await expect(closing).resolves.toEqual({ timedOut: false, inFlight: 0 });
        }
        // drain: Infinity — the drain timer is NEVER armed (§7.2 drain row).
        {
          const app = new Keala({ env: "test" });
          const gate = deferred();
          app.get("/hold", async (c) => {
            await gate.promise;
            c.body = "h";
          });
          const held = app.handle(new Request("http://x/hold"));
          const t0 = timers.snapshot();
          const closing = app.close({ drain: Number.POSITIVE_INFINITY });
          gate.resolve();
          expect(await (await held).text()).toBe("h");
          await expect(closing).resolves.toEqual({ timedOut: false, inFlight: 0 });
          expect(timers.snapshot().created - t0.created).toBe(0); // zero timers for Infinity
        }

        await flushMicrotasks();
        const after = timers.snapshot();
        const d = deltaOf(before, after);
        console.log(
          `REVIEW-PERF-5 mixed workload: created ${d.created}, cleared ${d.cleared}, fired ${d.fired}, ` +
            `live +${d.live}, liveUnref +${d.liveUnref}, liveTimeouts delta ${liveTimeouts() - timeoutsBefore}`,
        );
        expect(d.live).toBe(0); // zero keala-created timers still armed
        expect(d.liveUnref).toBe(0); // zero unref'd stragglers
        expect(d.created - d.cleared - d.fired).toBe(0); // every timer torn down exactly once
        // Nothing NEW is holding the loop (a pre-existing foreign timer
        // expiring mid-test may push this negative — only growth is a leak).
        expect(liveTimeouts() - timeoutsBefore).toBeLessThanOrEqual(0);
      } finally {
        timers.restore();
      }
    },
  );

  // -------------------------------------------------------------------------
  // REVIEW-PERF-6 — §7.3 hot-path forbidden actions at the admission slot:
  // refusals create NO Context (a pooling app's pool is untouched), allocate
  // exactly ONE Response (the rejection itself), and perform no IO (zero
  // timers/AbortControllers/streams, error funnel never entered).
  // -------------------------------------------------------------------------

  it(
    "REVIEW-PERF-6: admission (§7.3) — 1000 refusals on a pooling app touch no Context/pool, allocate exactly the rejection Response, do no IO",
    { timeout: 60_000 },
    async () => {
      const acPatch = patchConstructor("AbortController");
      const rsPatch = patchConstructor("ReadableStream");
      const respPatch = patchConstructor("Response");
      const timers = patchTimers();
      const mapper = vi.fn();
      try {
        const app = new Keala({ env: "test", pooling: true, overload: { maxConcurrency: 2 } });
        app.onError(mapper);
        const contexts: unknown[] = [];
        app.get("/seed", (c) => {
          contexts.push(c);
          c.body = "seed"; // bodied: its context retires only on consumption
        });
        app.get("/w", async (c) => {
          contexts.push(c);
          c.body = "w"; // bodied: stays out of the pool until consumed
        });
        const parkGate = deferred();
        app.get("/park", () => parkGate.promise.then(() => undefined));
        const workReq = new Request("http://x/w");

        // Seeding the pool while SATURATED (every admitted request drains
        // the pool, so the seed must retire after the parks): serve a bodied
        // response (frees its slot at settle, context A retires later), park
        // both slots, then consume the body — A lands in the pool with the
        // gate saturated, right before the flood.
        const seeded = await app.handle(new Request("http://x/seed"));
        expect(app.inFlight).toBe(0);
        const parkedA = app.handle(new Request("http://x/park"));
        const parkedB = app.handle(new Request("http://x/park"));
        expect(app.inFlight).toBe(2);
        await seeded.text(); // → context A retires; pool = [A] under saturation
        expect(contexts.length).toBe(1);

        const refuseReq = new Request("http://x/r");
        const ac0 = acPatch.count();
        const rs0 = rsPatch.count();
        const resp0 = respPatch.count();
        const t0 = timers.snapshot();
        const N = 1_000;
        const refused: Response[] = [];
        for (let i = 0; i < N; i++) refused.push(await app.handle(refuseReq));
        const acDelta = acPatch.count() - ac0;
        const rsDelta = rsPatch.count() - rs0;
        const respDelta = respPatch.count() - resp0;
        const tDelta = deltaOf(t0, timers.snapshot());
        console.log(
          `REVIEW-PERF-6 ${N} refusals: Responses ${respDelta} (budget exactly ${N}), ` +
            `AbortControllers ${acDelta}, ReadableStreams ${rsDelta}, timers ${tDelta.created}`,
        );

        expect(refused.every((r) => r.status === 503)).toBe(true);
        expect(app.inFlight).toBe(2); // only the two parked requests — refusals hold no slot
        // §7.3: no Response allocation except the rejection itself. The N
        // ReadableStreams are the rejection Responses' OWN string bodies
        // (undici routes `new Response("...")` through the global
        // ReadableStream) — a constituent of the one allowed Response per
        // refusal, not an extra wrap: exactly 1 stream per 1 Response.
        expect(respDelta).toBe(N);
        expect(rsDelta).toBe(N);
        // §7.3: no Context creation → no pool interaction, no cancellation
        // machinery, and no timer/IO of any kind.
        expect(acDelta).toBe(0);
        expect(tDelta.created).toBe(0);
        expect(tDelta.live).toBe(0);
        // Pre-context: the error funnel never sees a refusal.
        expect(mapper).not.toHaveBeenCalled();

        parkGate.resolve();
        await (await parkedA).text(); // consume both 404 bodies → contexts B, C recycle
        await (await parkedB).text(); // → pool = [A, B, C] (A still on the bottom)
        expect(app.inFlight).toBe(0);
        // The pool survived the flood untouched. Two concurrent serves pop C
        // and B (acquire is synchronous at call time; their unconsumed bodies
        // keep them OUT of the pool) — so the next serve MUST reach A itself.
        // A's identity proves no refusal ever acquired (or deposited) an
        // entry while it sat pooled under saturation.
        const second = app.handle(workReq);
        const third = app.handle(workReq);
        expect((await second).status).toBe(200);
        expect((await third).status).toBe(200);
        expect(contexts.length).toBe(3);
        expect(contexts[1]).not.toBe(contexts[0]);
        expect(contexts[2]).not.toBe(contexts[0]);
        const final = await app.handle(workReq);
        expect(final.status).toBe(200);
        expect(contexts.length).toBe(4);
        expect(contexts[3]).toBe(contexts[0]); // context A came back intact
      } finally {
        timers.restore();
        respPatch.restore();
        rsPatch.restore();
        acPatch.restore();
      }
    },
  );
});
