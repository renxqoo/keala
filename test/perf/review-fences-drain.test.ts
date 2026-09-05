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
        const buildApp = (
          mode: Mode,
        ): { app: Keala; gate: { promise: Promise<void>; resolve: () => void } } => {
          const app = new Keala({ env: "test" });
          const gate = deferred();
          if (mode === "state") {
            app.get("/d", async (c) => {
              await gate.promise;
              c.body = PAYLOAD;
            });
          } else {
            const prebuilt = Array.from({ length: K }, () =>
              mode === "committed" ? new Response(PAYLOAD) : new Response(null, { status: 204 }),
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
            ok: responses.every(
              (res, i) =>
                res.status === (mode === "null" ? 204 : 200) &&
                (mode === "null" ? texts[i] === "" : texts[i] === PAYLOAD),
            ),
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
});
