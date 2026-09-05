/**
 * R4.4 contract-coherence review — docs/HOTPATH-R4-4-MIGRATION-LIFECYCLE.md
 * vs implementation (src/core/lifecycle.ts, app.ts, dispatch.ts, adapters).
 *
 * One hypothesis per test (CT-n). Each block comment cites the doc rule and
 * states EXPECTED (per the doc) vs ACTUAL (per code reading); the assertions
 * encode the EXPECTED side, so a failing test = a confirmed contract gap.
 *
 * Findings summary (see review report for the full table):
 * - CT-1  RED  §2.1/§2.2 r9  second signal never force-closes (idempotent
 *         close swallows drain:0).
 * - CT-4  RED  §2.5/§8.2 #6  pooling: a 504-path zombie settling with a
 *         NULL-body response recycles its context.
 * - CT-5  RED  §2.2 r9       closeApp fallback drain timer is unref'd (doc:
 *         "holds the event loop") and not cleared on completion.
 * - CT-6  RED  §2.2 r9       adapter stopGraceful arms the drain timer AFTER
 *         the already-settled finish() — never cleared, ref'd.
 * - CT-9  RED  §2.2 r2/r3    close({drain: 0}) with zero in-flight never
 *         stops the listener.
 * - CT-8  GAP  §4 snippet 1  /healthz "draining" branch unreachable (gate
 *         refuses new probes first — behavior matches §2.2 r1, doc example
 *         implies otherwise).
 */

import { afterAll, describe, expect, it, vi } from "vitest";
import { Keala } from "../../src/core/app.ts";
import { installSignalBridge } from "../../src/core/lifecycle.ts";
import { startBunServer, type ServeImplementation } from "../../src/adapters/bun.ts";
import { startNodeServer, type NodeServerHandle } from "../../src/adapters/node.ts";
import { streamText } from "../../src/helpers/streams.ts";
import type { Context } from "../../src/core/context/context.ts";

const deferred = <T = void>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const wait = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

const liveServers: NodeServerHandle[] = [];
afterAll(() => {
  for (const server of liveServers) server.stop(true);
});

/** Tracks timers created while installed: delay, unref() and clearTimeout(). */
const armTracker = (): { ofDelay: (ms: number) => TrackedTimer[]; restore: () => void } => {
  const entries: TrackedTimer[] = [];
  const byWrapper = new Map<object, { entry: TrackedTimer; realId: unknown }>();
  const realSetTimeout = globalThis.setTimeout.bind(globalThis);
  const realClearTimeout = globalThis.clearTimeout.bind(globalThis);
  const stubSetTimeout = ((
    handler: (...args: unknown[]) => void,
    timeout?: number,
    ...rest: unknown[]
  ) => {
    const entry: TrackedTimer = { delay: timeout ?? 0, unrefed: false, cleared: false };
    entries.push(entry);
    const realId = realSetTimeout(handler as () => void, timeout, ...(rest as []));
    const wrapper: object = {
      unref: () => {
        entry.unrefed = true;
        (realId as { unref?: () => void }).unref?.();
      },
      ref: () => {
        (realId as { ref?: () => void }).ref?.();
      },
    };
    byWrapper.set(wrapper, { entry, realId });
    return wrapper;
  }) as unknown as typeof setTimeout;
  const stubClearTimeout = ((id: unknown) => {
    const hit = byWrapper.get(id as object);
    if (hit !== undefined) {
      hit.entry.cleared = true;
      realClearTimeout(hit.realId as Parameters<typeof clearTimeout>[0]);
      return;
    }
    realClearTimeout(id as Parameters<typeof clearTimeout>[0]);
  }) as unknown as typeof clearTimeout;
  vi.stubGlobal("setTimeout", stubSetTimeout);
  vi.stubGlobal("clearTimeout", stubClearTimeout);
  return {
    ofDelay: (ms: number) => entries.filter((entry) => entry.delay === ms),
    restore: () => {
      // Kill every still-armed tracked timer so the test never lingers.
      for (const { realId } of byWrapper.values()) {
        realClearTimeout(realId as Parameters<typeof clearTimeout>[0]);
      }
      vi.unstubAllGlobals();
    },
  };
};

interface TrackedTimer {
  delay: number;
  unrefed: boolean;
  cleared: boolean;
}

/** Bun-shaped serve mock (same pattern as r4-lifecycle-adapters.test.ts). */
const fakeServe = (): {
  impl: ServeImplementation;
  stopCalls: () => Array<boolean | undefined>;
} => {
  const stops: Array<boolean | undefined> = [];
  const impl: ServeImplementation = (options) => ({
    port: (options["port"] as number) ?? 0,
    hostname: "localhost",
    stop: (closeActive?: boolean) => {
      stops.push(closeActive);
    },
    fetch: async () => new Response("fake"),
    reload: () => {},
  });
  return { impl, stopCalls: () => stops };
};

describe("R4.4 contract coherence (agent-r44)", () => {
  it("CT-1 §2.2 r9/§2.1: a second signal must force-close an in-flight drain", async () => {
    // Doc: "首个 SIGTERM/SIGINT → app.close()(默认 drain);第二个 →
    // close({drain: 0}) 强停" — the second signal resolves the pending close
    // immediately (force). ACTUAL (lifecycle.ts installSignalBridge →
    // closeApp): app.close({drain: 0}) hits the idempotency early-return and
    // hands back the ORIGINAL 30s-drain promise — drain:0 is silently
    // swallowed, the second signal is a no-op.
    const registered: Array<[string, () => void]> = [];
    // REVIEW-BUG-1 fix: the bridge registers PERMANENT process.on listeners.
    const once = vi.spyOn(process, "on").mockImplementation(((
      event: string | symbol,
      handler: () => void,
    ) => {
      if (typeof event === "string" && typeof handler === "function") {
        registered.push([event, handler]);
      }
      return process;
    }) as unknown as typeof process.on);
    const gate = deferred();
    try {
      const app = new Keala({ env: "test" });
      app.get("/stuck", () => gate.promise.then(() => undefined));
      void app.handle(new Request("http://x/stuck")); // in-flight work under drain
      installSignalBridge(app);
      expect(registered.map(([event]) => event).toSorted()).toEqual(["SIGINT", "SIGTERM"]);
      const handler = registered[0]![1];
      handler(); // first SIGTERM → app.close() with the default 30s drain
      expect(app.isDraining()).toBe(true);
      const closing = app.close(); // the very promise the bridge holds
      handler(); // second SIGTERM → close({drain: 0}) per the bridge
      const outcome = await Promise.race([
        closing.then(() => "resolved"),
        wait(40).then(() => "still-pending"),
      ]);
      expect(outcome).toBe("resolved"); // EXPECTED: force-stopped at once. ACTUAL: pending 30s.
    } finally {
      once.mockRestore();
      gate.resolve(); // let the stranded drain finish in the background
    }
  });

  it("CT-2 §2.3 r5 vs §2.2 r4: capacity releases at SETTLE while a body streams (the documented asymmetry)", async () => {
    // Doc §2.3 r5: "并发口径 = 已准入未结算(settlement 边界)…body 流送不占并发槽".
    // The queued request must be admitted the moment the first request
    // SETTLES — its still-streaming body holds no overload slot.
    const app = new Keala({ env: "test", overload: { maxConcurrency: 1, maxQueue: 1 } });
    const secondAdmitted = deferred();
    app.get("/s", (c) =>
      streamText(c, async (w) => {
        for (let i = 0; i < 6; i++) {
          await wait(15);
          w.write(`c${i};`);
        }
      }),
    );
    app.get("/park", async () => {
      secondAdmitted.resolve();
      await wait(5);
    });
    const streaming = app.handle(new Request("http://x/s")); // admitted
    const parked = app.handle(new Request("http://x/park")); // queued (settle is a microtask away)
    await secondAdmitted.promise; // slot transferred at the first SETTLE
    // Only the second request occupies capacity — the streaming body does not.
    expect(app.inFlight).toBe(1);
    const streamed = await streaming;
    expect(streamed.status).toBe(200);
    expect(await streamed.text()).toContain("c5;");
    const parkedRes = await parked;
    expect(parkedRes.status).toBe(404); // void handler, state-style — fine
    expect(app.inFlight).toBe(0);
  });

  it("CT-3 §2.4 r1/r3 + §2.3 r5: a 504 frees the slot while its zombie still runs; no double release", async () => {
    // Doc §1: "期限到点释放并发槽(响应已回给客户端),僵尸 handler 不占容量".
    // The queued request must be admitted at 504 time; the zombie's late
    // settle must not decrement the counter again (§2.5 invariant).
    const app = new Keala({
      env: "test",
      requestTimeout: 60,
      overload: { maxConcurrency: 1, maxQueue: 1 },
    });
    const gate = deferred();
    let started = 0;
    app.get("/work", async (c) => {
      started++;
      if (started === 1)
        await gate.promise; // the zombie-to-be parks
      else c.body = `done-${started}`;
    });
    const first = app.handle(new Request("http://x/work")); // admitted, parks
    const second = app.handle(new Request("http://x/work")); // queued
    const third = await app.handle(new Request("http://x/work")); // queue full → 503
    expect(third.status).toBe(503);
    const dead = await first; // deadline fires → 504, slot freed
    expect(dead.status).toBe(504);
    const served = await second; // admitted from the queue at 504 time
    expect(await served.text()).toBe("done-2");
    expect(app.inFlight).toBe(0);
    gate.resolve(); // the zombie settles now — must be contained
    await wait(10);
    expect(app.inFlight).toBe(0); // no double release (once-closure guard)
  });

  it("CT-4 §2.5/§8.2 #6: a 504-path context must never be recycled — even for a null-body zombie", async () => {
    // Doc §2.5: "期限 504 路径的 Context 不回收(宁可泄漏到 GC 也不冒险复用
    // 被僵尸引用的 Context)". ACTUAL (app.#serve → settleHandle pooling
    // branch): the zombie's late settle runs `.then(retire)` →
    // retireWithBody(pool, c, value) — for a NULL-body response retire()
    // fires immediately and pool.release(c) recycles the context. Only
    // BODIED zombies dodge recycling (their wrapper is never consumed).
    // Control: pooling machinery is active on this app shape.
    const controlApp = new Keala({ env: "test", pooling: true });
    let controlCtx: Context | undefined;
    controlApp.get("/n", (c) => {
      controlCtx = c;
      return new Response(null);
    });
    await controlApp.handle(new Request("http://x/n"));
    let controlThrew = false;
    try {
      controlCtx!.body = "late";
    } catch {
      controlThrew = true;
    }
    expect(controlThrew).toBe(true); // retired on the normal path — the pool works

    // Hypothesis: the 504-path zombie with a null-body settle recycles too.
    const app = new Keala({ env: "test", pooling: true, requestTimeout: 40 });
    const gate = deferred();
    let zombieCtx: Context | undefined;
    app.get("/z", async (c) => {
      zombieCtx = c;
      await gate.promise;
      return new Response(null); // null body → retireWithBody retires at once
    });
    const dead = await app.handle(new Request("http://x/z"));
    expect(dead.status).toBe(504);
    gate.resolve(); // zombie settles → .then(retire) → retireWithBody
    await wait(10);
    let recycleThrew: Error | undefined;
    try {
      zombieCtx!.body = "late-write";
    } catch (error) {
      recycleThrew = error as Error;
    }
    expect(recycleThrew).toBeUndefined(); // EXPECTED: never recycled. ACTUAL: "context retired".
  });

  it("CT-5 §2.2 r9: the fallback drain timer must hold the loop (not unref) and be cleared on completion", async () => {
    // Doc §2.2 r9: "drain 计时器持有事件循环,清空后进程自然退出". ACTUAL
    // (closeApp fallback path): `const timer = setTimeout(...); timer.unref?.()`
    // — unref'd (does NOT hold the loop) and finish() never clearTimeouts it,
    // unlike both adapters' stopGraceful which do clear on completion.
    const app = new Keala({ env: "test" }); // no server → embedded fallback path
    const gate = deferred();
    app.get("/park", async (c) => {
      await gate.promise;
      c.body = "done";
    });
    const inflight = app.handle(new Request("http://x/park"));
    expect(app.inFlight).toBe(1);
    const tracker = armTracker();
    try {
      const closed = app.close({ drain: 137 });
      gate.resolve();
      const res = await inflight;
      await res.text(); // consume the drain body-hold so close can complete
      await expect(closed).resolves.toEqual({ timedOut: false, inFlight: 0 });
      const timers = tracker.ofDelay(137);
      expect(timers).toHaveLength(1);
      expect(timers[0]!.cleared).toBe(true); // EXPECTED: cleared. ACTUAL: left armed.
      expect(timers[0]!.unrefed).toBe(false); // EXPECTED per doc: holds the loop. ACTUAL: unref'd.
    } finally {
      tracker.restore();
    }
  });

  it("CT-6 §2.2 r9: stopGraceful's already-settled path must not leave the drain timer armed (Bun adapter)", async () => {
    // Doc §2.2 r9: once everything settles the loop empties naturally — an
    // armed, ref'd drain timer surviving a COMPLETED close holds the process
    // for the whole drain window (default 30s) after a clean shutdown.
    // ACTUAL (bun.ts stopGraceful): `if (onSettled(() => finish(false)))
    // finish(false); timer = setTimeout(...)` — on the already-settled path
    // finish() runs BEFORE the timer is created, so its clearTimeout never
    // happens; the timer stays armed and ref'd.
    const app = new Keala({ env: "test" });
    const { impl } = fakeServe();
    const handle = startBunServer(app, { port: 0 }, undefined, impl);

    // Control: the settle-LATER path clears its timer (finish after creation).
    const controlTracker = armTracker();
    let settle: (() => void) | undefined;
    const controlDone = handle.stopGraceful!({
      drain: 137,
      onSettled: (callback) => {
        settle = callback;
        return false;
      },
    });
    settle!();
    await expect(controlDone).resolves.toEqual({ timedOut: false });
    const controlTimers = controlTracker.ofDelay(137);
    expect(controlTimers).toHaveLength(1);
    expect(controlTimers[0]!.cleared).toBe(true); // GREEN control — cleared here
    controlTracker.restore();

    // Hypothesis: already-settled path arms the timer AFTER finish().
    const leakTracker = armTracker();
    const done = handle.stopGraceful!({ drain: 137, onSettled: () => true });
    await expect(done).resolves.toEqual({ timedOut: false });
    const timers = leakTracker.ofDelay(137);
    expect(timers).toHaveLength(1);
    expect(timers[0]!.cleared).toBe(true); // EXPECTED: cleared. ACTUAL: armed for 137ms.
    expect(timers[0]!.unrefed).toBe(false); // ref'd: the armed timer holds the event loop.
    leakTracker.restore();
  });

  it("CT-6b §2.2 r9: same already-settled timer leak through app.close() on the Node adapter", async () => {
    // node.ts stopGraceful mirrors bun.ts: trySettle()/finish(false) run
    // before `timer = setTimeout(...)`, so an idle close() resolves at once
    // but leaves the drain timer armed for the full window.
    const app = new Keala({ env: "test" });
    app.get("/x", (c) => {
      c.body = "x";
    });
    const server = await startNodeServer(app, { port: 0, hostname: "127.0.0.1" }).ready();
    liveServers.push(server);
    const tracker = armTracker();
    try {
      const closed = app.close({ drain: 137 }); // zero in-flight → already-settled path
      await expect(closed).resolves.toEqual({ timedOut: false, inFlight: 0 });
      const timers = tracker.ofDelay(137);
      expect(timers).toHaveLength(1);
      expect(timers[0]!.cleared).toBe(true); // EXPECTED: cleared. ACTUAL: armed.
    } finally {
      tracker.restore();
    }
  });
});
