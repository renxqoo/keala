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

import { Keala } from "../../src/core/app.ts";

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

const deferred = <T = void>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

describe("agent R4.6 perf review (structural budget fences)", () => {
  it(
    "REVIEW-PERF-3: deadline (§7.2 U2) — sync settle skips the race (0 timers, R413b); async settle arms 1 create/1 unref/1 clear; fire path yields exactly one 504 and a zero-timer zombie settle",
    { timeout: 60_000 },
    async () => {
      const timers = patchTimers();
      try {
        // (a) SYNC requests on a deadline-configured app (immediate settle):
        // R413b skips the race entirely — a synchronously-settled response
        // cannot hang, so arming a timer just to clear it one microtask
        // later is pure churn. Zero timers created per sync request.
        {
          const app = new Keala({ env: "test", requestTimeout: 30_000 });
          app.get("/s", (c) => {
            return c.text("sync");
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
          expect(d.created).toBe(0);
          expect(d.unrefed).toBe(0);
          expect(d.cleared).toBe(0);
          expect(d.fired).toBe(0);
          expect(d.live).toBe(0);
          expect(d.liveUnref).toBe(0);
        }
        // (b) ASYNC requests settling before the deadline: same 1:1:1 shape.
        {
          const app = new Keala({ env: "test", requestTimeout: 30_000 });
          app.get("/a", async (c) => {
            await Promise.resolve(); // settle in a microtask, well before the deadline
            return c.text("async");
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
    "REVIEW-PERF-4: drain (§7.2) — null-body drain settles with ZERO wraps; Response count exact for bodied drain",
    { timeout: 60_000 },
    async () => {
      // The bodied-drain one-wrap rule and its 50µs timing fence live in
      // PERF-6 (hotpath-fences-extra). Unique here: the null-body drain
      // (zero wraps — nothing to hold) and the wrapper RESPONSE object count.
      const rsPatch = patchConstructor("ReadableStream");
      const respPatch = patchConstructor("Response");
      try {
        const K = 4;
        const PAYLOAD = `review-drain-payload-${"y".repeat(48)}`;
        const nullApp = new Keala({ env: "test" });
        const nullGate = deferred();
        const prebuiltNull = Array.from({ length: K }, () => new Response(null, { status: 204 }));
        let issuedNull = 0;
        nullApp.get("/d", () => nullGate.promise.then(() => prebuiltNull[issuedNull++]!));
        const nullHandles: Promise<Response>[] = [];
        for (let i = 0; i < K; i++) nullHandles.push(nullApp.handle(new Request("http://x/d")));
        const nullClosing = nullApp.close({ drain: 5_000 });
        const nrs0 = rsPatch.count();
        const nresp0 = respPatch.count();
        nullGate.resolve();
        const nullResponses = await Promise.all(nullHandles);
        for (const res of nullResponses) await res.text();
        expect(nullResponses.every((res) => res.status === 204)).toBe(true);
        expect(rsPatch.count() - nrs0).toBe(0); // null bodies hold nothing
        expect(respPatch.count() - nresp0).toBe(0);
        await nullClosing;

        const app = new Keala({ env: "test" });
        const gate = deferred();
        const prebuilt = Array.from({ length: K }, () => new Response(PAYLOAD));
        let issued = 0;
        app.get("/d", () => gate.promise.then(() => prebuilt[issued++]!));
        const handles: Promise<Response>[] = [];
        for (let i = 0; i < K; i++) handles.push(app.handle(new Request("http://x/d")));
        const closing = app.close({ drain: 5_000 });
        const resp0 = respPatch.count();
        gate.resolve();
        const responses = await Promise.all(handles);
        const texts: string[] = [];
        for (const res of responses) texts.push(await res.text());
        expect(responses.every((res, i) => res.status === 200 && texts[i] === PAYLOAD)).toBe(true);
        // EXACTLY one wrapper Response per bodied drain settle (the holdBody
        // wrap; the pre-builts predate the counting window).
        expect(respPatch.count() - resp0).toBe(K);
        await closing;
      } finally {
        rsPatch.restore();
        respPatch.restore();
      }
    },
  );

  // -------------------------------------------------------------------------
  // REVIEW-PERF-5 — global timer discipline (§7.1 zero-timer unconfigured,
  // §7.2 drain row): after a mixed workload (plain / overload-saturated with
  // queue + drain-drop / deadline settle + fire) plus COMPLETED close()
  // calls, zero keala-created timers remain live; drain:Infinity arms none.
  // -------------------------------------------------------------------------
});
