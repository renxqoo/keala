/**
 * agent-r44 bug hunt: R4.4 lifecycle / overload / deadline machinery.
 *
 * One test per defect hypothesis (FINDING-N). Each comment states: the
 * defect, the contract line it violates (docs/HOTPATH-R4-4-MIGRATION-
 * LIFECYCLE.md), and the failing observable. A FAILING test = confirmed
 * defect (kept red); a PASSING test = hypothesis disproved, kept as a
 * VERIFIED-OK regression lock.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { Keala } from "../src/core/app.ts";
import { startNodeServer, type NodeServerHandle } from "../src/adapters/node.ts";
import { startBunServer, type ServeImplementation } from "../src/index.ts";
import { installSignalBridge } from "../src/core/lifecycle.ts";
import type { Context } from "../src/core/context/context.ts";

const deferred = <T = void>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const wait = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

const liveServers: NodeServerHandle[] = [];
afterEach(() => {
  for (const server of liveServers.splice(0)) server.stop(true);
});

/** Bun-shaped serve mock (same technique as test/r4-lifecycle-adapters.test.ts). */
const fakeImpl: ServeImplementation = (options) => ({
  port: (options["port"] as number) ?? 0,
  hostname: "localhost",
  stop: () => {},
  fetch: async () => new Response("fake"),
  reload: () => {},
});
const fakeServe = (): { impl: ServeImplementation } => ({ impl: fakeImpl });

describe("agent-r44 bug hunt: drain body-hold counter accounting", () => {
  it(
    "FINDING-1: cancelling a drain-held body while a pull is pending double-releases the in-flight slot",
    { timeout: 8000 },
    async () => {
      // DEFECT: holdBody (src/core/lifecycle.ts) releases the in-flight slot
      // from BOTH the wrapper's cancel() handler AND the still-pending pull's
      // catch arm. When the consumer cancels while a pull is awaiting
      // reader.read(), cancel() runs releaseInFlight (#1); the inner reader's
      // cancellation then resolves the pending read with {done:true}, the pull
      // resumes, controller.close() throws on the already-cancelled wrapper
      // stream, and the catch arm runs releaseInFlight (#2). pool.ts learned
      // this lesson (retireWithBody has a `retired` once-guard); holdBody has
      // no guard at all.
      // CONTRACT: §2.2 rule 4/§2.5 — the in-flight counter is admitted-minus-
      // settled; `app.inFlight` must never go negative, and a 0-crossing is
      // the drain-completion signal. The Node adapter triggers exactly this
      // shape whenever a client disconnects mid-body during a drain
      // (pipeline() cancels the web stream with a pull in flight).
      // OBSERVABLE: app.inFlight === -1 after the cancelled hold settles
      // (expected 0) — the ops/LB metric is corrupted and, on a still-open
      // app, capacity arithmetic over-admits afterwards.
      // STATUS: CONFIRMED-RED — observed app.inFlight === -1 (repro stable).
      const app = new Keala({ env: "test" });
      const gate = deferred();
      const never = deferred();
      let sent = false;
      const encoder = new TextEncoder();
      app.get("/held", () =>
        gate.promise.then(
          () =>
            new Response(
              new ReadableStream<Uint8Array>({
                async pull(controller) {
                  if (!sent) {
                    sent = true;
                    controller.enqueue(encoder.encode("first"));
                    return;
                  }
                  await never.promise; // second pull stays pending forever
                  controller.close();
                },
              }),
            ),
        ),
      );

      const inflight = app.handle(new Request("http://x/held"));
      expect(app.inFlight).toBe(1);
      const closed = app.close({ drain: 3000 });
      gate.resolve(); // the handler settles DURING drain -> body-hold engaged
      const response = await inflight;
      expect(app.inFlight).toBe(1); // held until the consumer finishes

      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value!)).toBe("first");
      const second = reader.read(); // starts holdBody pull #2 (pending read)
      await wait(10); // let pull #2 actually park on the inner reader.read()
      await reader.cancel(); // consumer walks away mid-pull
      await second; // resolves {done:true} once the inner reader is cancelled
      await wait(25); // let the resumed pull's catch arm run
      expect(app.inFlight).toBe(0); // PREDICTED ACTUAL: -1 (double release)
      await expect(closed).resolves.toEqual({ timedOut: false, inFlight: 0 });
    },
  );
});

describe("agent-r44 bug hunt: signal bridge force semantics", () => {
  it(
    "FINDING-2: a second SIGTERM never force-closes — close() idempotency swallows {drain: 0}",
    { timeout: 8000 },
    async () => {
      // DEFECT: installSignalBridge (src/core/lifecycle.ts) answers the second
      // signal with app.close({drain: 0}), but closeApp's FIRST line returns
      // the already-created closePromise, so the force option is dead code.
      // Nothing ever calls handle.stop(true) on the second signal.
      // CONTRACT: §2.2 rule 9 — "首个 SIGTERM/SIGINT → app.close()（默认
      // drain）；第二个 → close({drain:0}) 强停". With a stuck in-flight
      // request the process should die promptly on the second signal, not
      // after the full 30s default window (K8s then SIGKILLs it, losing the
      // clean-exit code path entirely).
      // OBSERVABLE: after two signals with a parked request, close() is still
      // pending 200ms later instead of having resolved {timedOut:true}.
      // STATUS: CONFIRMED-RED — observed "still-draining" after 200ms.
      const registered: Array<[string, () => void]> = [];
      // REVIEW-BUG-1 fix: the bridge registers PERMANENT process.on
      // listeners (a once-listener consumed itself and let a repeated
      // same-name signal fall to the OS default disposition).
      const once = vi.spyOn(process, "on").mockImplementation(((
        event: string | symbol,
        handler: () => void,
      ) => {
        if (typeof event === "string") registered.push([event, handler]);
        return process;
      }) as unknown as typeof process.on);
      try {
        const app = new Keala({ env: "test" });
        const gate = deferred();
        app.get("/stuck", async (c) => {
          await gate.promise;
          c.body = "late";
        });
        void app.handle(new Request("http://x/stuck")); // in-flight for the drain
        installSignalBridge(app);
        const entry = registered.find(([event]) => event === "SIGTERM");
        expect(entry).toBeDefined();
        const handler = entry![1]!;
        handler(); // first signal: close() with the DEFAULT 30s drain
        handler(); // second signal: contract says force ({drain: 0})
        const outcome = await Promise.race([
          app.close().then((status) => `resolved:${status.timedOut}`),
          wait(200).then(() => "still-draining"),
        ]);
        expect(outcome).toBe("resolved:true"); // PREDICTED ACTUAL: still-draining
        gate.resolve(); // cleanup either way
        await wait(10);
      } finally {
        once.mockRestore();
      }
    },
  );
});

describe("agent-r44 bug hunt: drain: Infinity handling in adapters", () => {
  it(
    "FINDING-3: close({drain: Infinity}) force-closes a Node server after ~1ms (setTimeout clamps Infinity to 1)",
    { timeout: 8000 },
    async () => {
      // DEFECT: closeApp guards Infinity only on the embedded (no-server)
      // path. With a server handle it forwards drain verbatim to
      // stopGraceful, and src/adapters/node.ts arms
      // setTimeout(() => finish(true), grace.drain) — Node clamps an
      // out-of-range (Infinity) delay to 1ms, so the "wait forever" drain
      // force-closes all connections ~1ms in and reports {timedOut:true}.
      // CONTRACT: §2.2 rule 2 — "`drain: Infinity` 允许（等到清空或外部
      // SIGKILL）"; rule 5 — the resolve value must tell the truth.
      // OBSERVABLE: close() resolves (timedOut:true) within 150ms while the
      // in-flight request is still parked; per contract it must stay pending.
      // STATUS: CONFIRMED-RED — resolved {timedOut:true} ~1ms in, connection killed.
      const app = new Keala({ env: "test" });
      const gate = deferred();
      app.get("/stuck", async (c) => {
        await gate.promise;
        c.body = "late";
      });
      const server = await startNodeServer(app, { port: 0, hostname: "127.0.0.1" }).ready();
      liveServers.push(server);
      const inflight = fetch(`http://127.0.0.1:${server.port}/stuck`).catch(() => null);
      await wait(30); // the request parks on the gate
      expect(app.inFlight).toBe(1);
      const closed = app.close({ drain: Number.POSITIVE_INFINITY });
      const outcome = await Promise.race([
        closed.then((status) => `resolved:${status.timedOut}`),
        wait(150).then(() => "still-pending"),
      ]);
      expect(outcome).toBe("still-pending"); // PREDICTED ACTUAL: resolved:true
      if (outcome === "still-pending") {
        gate.resolve();
        await closed;
      }
      await inflight;
    },
  );

  it(
    "FINDING-4: the Bun adapter's stopGraceful clamps drain: Infinity to a 1ms force-close",
    { timeout: 8000 },
    async () => {
      // DEFECT: src/adapters/bun.ts stopGraceful arms
      // setTimeout(() => finish(true), grace.drain) with no Infinity guard —
      // the same clamp-to-1ms bug as FINDING-3, on the Bun path.
      // CONTRACT: §2.2 rule 2 — Infinity means "wait for the counter or an
      // external SIGKILL", never an internal force.
      // OBSERVABLE: stopGraceful resolves {timedOut:true} within 150ms while
      // onSettled never fired and stop() was called twice (undefined, true).
      // STATUS: CONFIRMED-RED — resolved {timedOut:true} within the 150ms race.
      const app = new Keala({ env: "test" });
      const { impl } = fakeServe();
      const handle = startBunServer(app, { port: 0 }, undefined, impl);
      const closing = handle.stopGraceful!({
        drain: Number.POSITIVE_INFINITY,
        onSettled: () => false, // app work never completes
      });
      const outcome = await Promise.race([
        closing.then((status) => `resolved:${status.timedOut}`),
        wait(150).then(() => "still-pending"),
      ]);
      expect(outcome).toBe("still-pending"); // PREDICTED ACTUAL: resolved:true
    },
  );
});

describe("agent-r44 bug hunt: stopGraceful timer lifecycle", () => {
  it(
    "FINDING-5: Bun stopGraceful leaks its drain timer on the already-settled path (process lingers the full window)",
    { timeout: 8000 },
    async () => {
      // DEFECT: in src/adapters/bun.ts the finish(false) for the
      // already-settled case runs BEFORE `timer = setTimeout(...)` is
      // assigned, so the timer created right after can never be cleared
      // (finish is done-guarded). A clean shutdown of an idle server keeps a
      // drain-window timer (default 30s via app.close()) alive in the event
      // loop for its full duration.
      // CONTRACT: §2.2 rule 9 — "drain 计时器持有事件循环，清空后进程自然退
      // 出" — after everything settles the loop must EMPTY; a lingering timer
      // delays natural exit by the whole drain window.
      // OBSERVABLE: with fake timers, one pending timer remains after
      // stopGraceful has already resolved {timedOut:false}.
      // STATUS: CONFIRMED-RED — vi.getTimerCount() === 1 after resolution.
      const app = new Keala({ env: "test" });
      const { impl } = fakeServe();
      vi.useFakeTimers();
      try {
        const handle = startBunServer(app, { port: 0 }, undefined, impl);
        expect(vi.getTimerCount()).toBe(0);
        await expect(
          handle.stopGraceful!({ drain: 60_000, onSettled: () => true }),
        ).resolves.toEqual({ timedOut: false });
        expect(vi.getTimerCount()).toBe(0); // PREDICTED ACTUAL: 1 (leaked timer)
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it(
    "FINDING-6: Node stopGraceful leaks its drain timer on the already-settled path",
    { timeout: 8000 },
    async () => {
      // DEFECT: same shape as FINDING-5 in src/adapters/node.ts — trySettle()
      // can call finish(false) before `timer = setTimeout(...)` is assigned
      // (app counter already 0, wire already 0), leaving an uncleared timer
      // that holds the event loop for the whole drain window after a clean
      // shutdown of an idle server.
      // CONTRACT: §2.2 rule 9 (natural exit once drained).
      // OBSERVABLE: one pending fake timer after stopGraceful resolved.
      // STATUS: CONFIRMED-RED — vi.getTimerCount() === 1 after resolution.
      const app = new Keala({ env: "test" });
      app.get("/x", (c) => {
        c.body = "x";
      });
      const server = await startNodeServer(app, { port: 0, hostname: "127.0.0.1" }).ready();
      liveServers.push(server);
      vi.useFakeTimers();
      try {
        expect(vi.getTimerCount()).toBe(0);
        await expect(
          server.stopGraceful({ drain: 60_000, onSettled: () => true }),
        ).resolves.toEqual({ timedOut: false });
        expect(vi.getTimerCount()).toBe(0); // PREDICTED ACTUAL: 1 (leaked timer)
      } finally {
        vi.useRealTimers();
      }
    },
  );
});

describe("agent-r44 bug hunt: pooling x deadline interaction", () => {
  it(
    "FINDING-7: a pooling app recycles the zombie's context once it settles with a null body (doc: never recycle)",
    { timeout: 8000 },
    async () => {
      // DEFECT: §2.4 rule 3 / §2.5 invariant say the 504-path Context is
      // never recycled ("宁可泄漏到 GC 也不冒险复用被僵尸引用的 Context"),
      // but nothing enforces it: the zombie's own settleHandle still runs
      // retireWithBody (src/core/dispatch.ts), and when its late response is
      // null-bodied (e.g. a 204) the context is released straight back into
      // the pool. The next request then runs on the very object a still-live
      // zombie handler may hold.
      // CONTRACT: §2.5 — "期限 504 路径的 Context 不回收（罕见路径…）".
      // OBSERVABLE: the context object serving the request AFTER the zombie
      // settled is the zombie's own context (identity equality).
      // STATUS: CONFIRMED-RED — seen[1] === zombie (object identity reuse).
      const app = new Keala({ env: "test", pooling: true, requestTimeout: 40 });
      const gate = deferred();
      let zombie: Context | undefined;
      app.get("/z", async (c) => {
        zombie = c;
        await gate.promise;
        c.status = 204; // settles late with a NULL body -> immediate retire
      });
      const seen: Context[] = [];
      app.get("/who", (c) => {
        seen.push(c);
        c.body = "ok";
      });

      const answered = await app.handle(new Request("http://x/z"));
      expect(answered.status).toBe(504); // deadline won; slot freed
      const first = await app.handle(new Request("http://x/who"));
      await first.text(); // /who context #1 recycled into the pool
      gate.resolve(); // the zombie settles now
      await wait(15); // its 204 retires straight into the pool (null body)
      const second = await app.handle(new Request("http://x/who"));
      await second.text();
      expect(seen).toHaveLength(2);
      expect(zombie).toBeDefined();
      expect(seen[1]).not.toBe(zombie); // PREDICTED ACTUAL: same object
    },
  );
});

describe("agent-r44 bug hunt: queue waiter edge cases (VERIFIED-OK locks)", () => {
  it(
    "FINDING-8: a timed-out waiter leaves the queue — the freed slot serves a fresh request, counter stable",
    { timeout: 8000 },
    async () => {
      // HYPOTHESIS: the queue-timeout leave() path fails to splice the dead
      // waiter, so a later slot transfer "admits" a request the client already
      // saw a 503 for (double admission / counter drift).
      // CONTRACT: §2.3 rule 3/4 — leaving is an exit from the queue; the
      // settled-guard + indexOf splice must keep one-outcome semantics.
      // STATUS: VERIFIED-OK (green) — the settled-guard + splice hold.
      const app = new Keala({
        env: "test",
        overload: { maxConcurrency: 1, maxQueue: 1, queueTimeoutMs: 40 },
      });
      const gate = deferred();
      app.get("/w", async (c) => {
        await gate.promise;
        c.body = "done";
      });
      const first = app.handle(new Request("http://x/w"));
      const queued = app.handle(new Request("http://x/w"));
      const timedOut = await queued;
      expect(timedOut.status).toBe(503); // waiter timed out and LEFT
      gate.resolve();
      const next = await app.handle(new Request("http://x/w")); // queue must be empty
      expect(next.status).toBe(200);
      expect(await next.text()).toBe("done");
      expect(await (await first).text()).toBe("done");
      expect(app.inFlight).toBe(0);
    },
  );

  it(
    "FINDING-9: client abort racing slot release — the disconnected waiter leaves exactly once",
    { timeout: 8000 },
    async () => {
      // HYPOTHESIS: abort() and releaseInFlight()->refillFromQueue() can
      // interleave so a disconnecting waiter is both admitted and rejected.
      // CONTRACT: §2.3 rule 3 — 排队期间客户端断开 → 出队 + 503；槽位移交时
      // 计数不抖动.
      // RESULT: VERIFIED-OK if green (leave() splices before the transfer
      // can pick the waiter). STATUS: VERIFIED-OK (green).
      const app = new Keala({
        env: "test",
        overload: { maxConcurrency: 1, maxQueue: 2 },
      });
      const gate = deferred();
      app.get("/w", async (c) => {
        await gate.promise;
        c.body = "done";
      });
      const first = app.handle(new Request("http://x/w"));
      const abort = new AbortController();
      const queued = app.handle(new Request("http://x/w", { signal: abort.signal }));
      await wait(5); // parked in the queue
      abort.abort(); // disconnect fires synchronously: leave() -> splice + 503
      gate.resolve(); // same tick: the slot frees and refills
      const left = await queued;
      expect(left.status).toBe(503); // exactly one outcome: it left
      expect(await (await first).text()).toBe("done");
      expect(app.inFlight).toBe(0);
      expect(app.inFlight).toBeGreaterThanOrEqual(0);
    },
  );
});

describe("agent-r44 bug hunt: deadline x drain interaction (VERIFIED-OK lock)", () => {
  it(
    "FINDING-10: a 504 answered during drain frees the slot — close completes without waiting for the zombie",
    { timeout: 8000 },
    async () => {
      // HYPOTHESIS: the deadline race releases capacity only on the
      // non-draining path, so a drained app with requestTimeout would wait
      // for the parked zombie until the drain window expired.
      // CONTRACT: §2.4 rule 3 — 期限到点释放并发槽；僵尸不占容量.
      // RESULT: VERIFIED-OK if green (release() runs on the deadline path
      // regardless of draining). STATUS: VERIFIED-OK (green).
      const app = new Keala({ env: "test", requestTimeout: 40 });
      const gate = deferred();
      app.get("/stuck", async (c) => {
        await gate.promise;
        c.body = "late";
      });
      const inflight = app.handle(new Request("http://x/stuck"));
      const closed = app.close({ drain: 4000 });
      const outcome = await Promise.race([
        closed.then(() => "resolved"),
        wait(1000).then(() => "pending"),
      ]);
      expect(outcome).toBe("resolved"); // 504 at t=40ms released the slot
      gate.resolve(); // zombie settles whenever it wants
      const answered = await inflight;
      expect(answered.status).toBe(504); // the client keeps the 504
    },
  );
});

describe("agent-r44 bug hunt: pooling recycle x abort state (VERIFIED-OK lock)", () => {
  it(
    "FINDING-11: a late raw-signal abort after recycle never leaks into the next request's c.signal",
    { timeout: 8000 },
    async () => {
      // HYPOTHESIS: the raw-abort listener a materialized c.signal attaches
      // survives the pool recycle and aborts the NEXT request's composed
      // signal (cross-request cancellation leak).
      // CONTRACT: §2.4 rule 5 / §2.5 — c.signal is per-request; state.ts
      // documents abortValue as "Cleared on recycle".
      // RESULT: VERIFIED-OK if green (resetContext nulls abortValue; the old
      // listener only ever reaches the old controller). STATUS: VERIFIED-OK (green).
      const app = new Keala({ env: "test", pooling: true });
      const abort = new AbortController();
      let sigA: AbortSignal | undefined;
      app.get("/a", (c) => {
        sigA = c.signal;
        c.body = "a";
      });
      const ra = await app.handle(new Request("http://x/a", { signal: abort.signal }));
      await ra.text(); // context recycled into the pool
      abort.abort(new Error("client left after the fact")); // stale raw signal fires
      let sigB: AbortSignal | undefined;
      app.get("/b", (c) => {
        sigB = c.signal;
        c.body = "b";
      });
      const rb = await app.handle(new Request("http://x/b"));
      await rb.text();
      expect(sigA?.aborted).toBe(true); // the old signal did fire
      expect(sigB?.aborted).toBe(false); // the recycled context's new one is clean
    },
  );
});
