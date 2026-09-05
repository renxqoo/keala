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

import { describe, expect, it, vi } from "vitest";

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
const liveTimeouts = (): number => {
  const info = process.getActiveResourcesInfo?.();
  return info === undefined ? 0 : info.filter((name) => name === "Timeout").length;
};

describe("agent R4.6 perf review (structural budget fences)", () => {
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

  it.skipIf(typeof Bun !== "undefined")(
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
        await (await parkedA).text();
        await (await parkedB).text();
        expect(app.inFlight).toBe(0);
        // The pool survived the flood untouched. Under retire-at-settle (the
        // R4.7 pooling contract: a settled snapshot-body context returns at
        // settle, not on consumption) every sequential serve must recycle the
        // SAME top-of-pool identity — the flood neither grew the pool (a
        // refusal depositing an entry would surface as a fresh identity) nor
        // drained it (an acquire would surface as a second live identity).
        const second = await app.handle(workReq);
        const third = await app.handle(workReq);
        const final = await app.handle(workReq);
        expect([second.status, third.status, final.status]).toEqual([200, 200, 200]);
        expect(contexts.length).toBe(4);
        expect(new Set(contexts).size).toBe(2); // A + exactly one recycled identity
        expect(contexts[1]).toBe(contexts[2]);
        expect(contexts[2]).toBe(contexts[3]);
      } finally {
        timers.restore();
        respPatch.restore();
        rsPatch.restore();
        acPatch.restore();
      }
    },
  );
});
