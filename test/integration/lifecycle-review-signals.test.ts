/**
 * R4.6 BUG-HUNT review: state-machine races and accounting in the lifecycle
 * implementation (branch codex/r4-6-lifecycle-overload).
 *
 * One focused test per hypothesis (REVIEW-BUG-N). Each comment states the
 * hypothesis, the interleaving it attacks, and the failing observable. A
 * FAILING test = confirmed defect (kept red, clearly named); a PASSING test =
 * hypothesis disproved, kept as a VERIFIED-OK lock.
 *
 * Hunting ground: src/core/lifecycle.ts, lifecycle-admission.ts,
 * lifecycle-deadline.ts, dispatch.ts, app.ts [HANDLE_REQUEST_SOURCE]/#serve,
 * adapters/node.ts + node-source.ts, adapters/bun.ts.
 */

/* eslint-disable max-lines -- one review file per the task mandate (15 bug-hunt probes; the review agent is restricted to this single file) */

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Keala } from "../../src/core/app.ts";
import { type NodeServerHandle } from "../../src/adapters/node.ts";
import { admitRequest, waiterPoolStats } from "../../src/core/lifecycle-admission.ts";
import { closeApp, createLifecycle, releaseInFlight } from "../../src/core/lifecycle.ts";

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
afterAll(() => {
  for (const server of liveServers.splice(0)) server.stop(true);
});

/** Bun-shaped serve mock (same technique as test/r4-lifecycle-adapters.test.ts). */

describe("R4.6 review hunt: signal bridge under real signals", () => {
  // Node-host only: the real-signal child dance relies on node-host stdio
  // behaviors (verified failing under a Bun-hosted vitest on the lifecycle
  // branch itself); the bridge logic stays cross-runtime covered by the
  // in-process signal tests.
  it.skipIf(typeof Bun !== "undefined")(
    "REVIEW-BUG-1: a second SIGTERM never reaches the bridge — process.once consumed the listener, so the real process dies by default disposition instead of force-closing via close({drain:0})",
    { timeout: 20000 },
    async () => {
      // HYPOTHESIS: installSignalBridge (src/core/lifecycle.ts:288-289)
      // registers onSignal with process.once("SIGTERM")/process.once("SIGINT").
      // The `fired ? close({drain:0}) : close()` ternary exists precisely so a
      // REPEAT signal escalates a running close (DESIGN §2.1: "二次信号强停",
      // closeApp's own comment: "the signal bridge's second SIGTERM must not
      // be swallowed"). But process.once removes the listener after the first
      // delivery — a real second SIGTERM finds NO listener and Node falls
      // back to the default disposition: the process is killed by the signal
      // (exit code null / signal "SIGTERM"), never executing the escalation,
      // never resolving CloseStatus, never running the adapters' force path.
      // The existing FINDING-2 lock mocks process.once and invokes the same
      // captured handler twice — which cannot observe the consumption.
      // OBSERVABLE (real process): after SIGTERM + SIGTERM with one in-flight
      // parked request, the child exits by signal (code === null,
      // signal === "SIGTERM") instead of exiting cleanly (code === 0) after
      // the escalated close resolves.
      // STATUS: CONFIRMED-RED — observed { code: null, signal: "SIGTERM" }
      // (repro stable across runs).
      const childPath = fileURLToPath(
        new URL("./agent-r46-review-signal-child.ts", import.meta.url),
      );
      const child = spawn(
        process.execPath,
        ["--experimental-strip-types", "--no-warnings", childPath],
        { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
      );
      let out = "";
      let err = "";
      child.stdout.on("data", (chunk: Buffer) => {
        out += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        err += chunk.toString("utf8");
      });
      const portLine = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`child never reported a port: ${out} ${err}`)),
          8000,
        );
        const poll = setInterval(() => {
          const match = /PORT=(\d+)/.exec(out);
          if (match !== null) {
            clearTimeout(timer);
            clearInterval(poll);
            resolve(match[1]!);
          }
        }, 20);
      });
      const base = `http://127.0.0.1:${portLine}`;

      // Wait until the server answers, then park one in-flight request so the
      // first signal's 30s drain cannot complete before the second signal.
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          const probe = await fetch(`${base}/health`);
          if (probe.ok) break;
        } catch {
          // not listening yet
        }
        await wait(50);
      }
      const stuck = fetch(`${base}/stuck`).catch(() => undefined);
      await wait(250); // let the handler park (app.inFlight === 1 in the child)

      child.kill("SIGTERM"); // first: bridge drains with the default window
      await wait(400); // the drain is still running (stuck request)
      child.kill("SIGTERM"); // second: contract says force via close({drain: 0})

      const outcome = await new Promise<{ code: number | null; signal: string | null }>(
        (resolve) => {
          child.once("exit", (code, signal) => resolve({ code, signal }));
        },
      );
      void stuck;
      // Predicted ACTUAL (defect): { code: null, signal: "SIGTERM" } — the
      // default disposition killed the process; the escalation never ran.
      expect(outcome).toEqual({ code: 0, signal: null });
    },
  );
});

describe("R4.6 review hunt: counter accounting at the admission/settle seam", () => {
  it("REVIEW-BUG-2: close racing an in-flight slot transfer must not observe a counter dip (white box)", async () => {
    // HYPOTHESIS: releaseInFlight decrements then refills; if a closeApp
    // could observe the momentary 0 between them, close would resolve
    // {timedOut:false} while an admitted request still holds a slot (drain
    // completion signal corrupted). Slot transfer must be atomic.
    const lc = createLifecycle({ maxConcurrency: 1, maxQueue: 2 });
    lc.inFlight = 1; // request A admitted, running
    const waiter = admitRequest(lc, new Request("http://x/")); // B saturates -> queued
    expect(lc.inFlight).toBe(1);
    expect(lc.queue.length).toBe(1);

    releaseInFlight(lc); // A settles: decrement, then the slot transfers to B
    expect(lc.inFlight).toBe(1); // no dip: B holds the transferred slot
    expect(lc.queue.length).toBe(0);
    // The queued admission resolved null (admitted, not refused).
    const admitted = await Promise.race([waiter, wait(50).then(() => "still-pending")]);
    expect(admitted).toBeNull();

    // closeApp lands BETWEEN the transfer and B's #serve: B was admitted
    // before drain, so close must WAIT for its (never-coming) settle, not
    // resolve {timedOut:false} against a dipped counter.
    const closed = closeApp(lc, undefined, { drain: 40 });
    await expect(closed).resolves.toEqual({ timedOut: true, inFlight: 1 });
    expect(lc.inFlight).toBe(1); // the transferred slot is neither dropped nor double-counted
  });

  it(
    "REVIEW-BUG-3: queue timeout racing slot transfer yields exactly one outcome and clean accounting",
    { timeout: 8000 },
    async () => {
      // HYPOTHESIS: the waiter's timeout timer and refillFromQueue's
      // shift+admit race for the same WaiterSlot. A missing once-guard would
      // let BOTH run: the request gets its 503 AND the transfer increments the
      // counter (a phantom in-flight slot leaks forever).
      for (let offset = 12; offset <= 22; offset += 2) {
        const app = new Keala({
          env: "test",
          overload: { maxConcurrency: 1, maxQueue: 2, queueTimeoutMs: 25 },
        });
        const gate = deferred();
        app.get("/work/:id", async (c) => {
          await gate.promise;
          return c.text(`done:${c.params("id")}`);
        });
        const first = app.handle(new Request("http://x/work/a"));
        await wait(offset); // B parks in the queue, its 25ms timer now armed
        const queued = app.handle(new Request("http://x/work/b"));
        gate.resolve(); // A settles -> transfer races B's timer
        const settled = await queued; // exactly one response, never two fates
        expect([200, 503]).toContain(settled.status);
        if (settled.status === 200) expect(await settled.text()).toBe("done:b");
        await first;
        await wait(5);
        expect(app.inFlight).toBe(0); // a phantom transfer slot would leak this at 1
        // Queue and capacity stay healthy for the next arrival.
        const after = await app.handle(new Request("http://x/work/c"));
        expect(after.status).toBe(200);
      }
    },
  );

  it(
    "REVIEW-BUG-4: drain-clear racing queue timeout rejects each waiter exactly once",
    { timeout: 8000 },
    async () => {
      // HYPOTHESIS: closeApp's queue splice/drop and the waiter's own timeout
      // both settle the same slot; a re-entrancy hole would resolve the
      // admission promise twice (double 503) or drop a freed slot back into the
      // queue after drain-clear spliced it.
      for (let offset = 10; offset <= 20; offset += 3) {
        const app = new Keala({
          env: "test",
          overload: { maxConcurrency: 1, maxQueue: 2, queueTimeoutMs: 20 },
        });
        const gate = deferred();
        app.get("/work", async (c) => {
          await gate.promise;
          return c.text("done");
        });
        const first = app.handle(new Request("http://x/work"));
        const queued = app.handle(new Request("http://x/work"));
        await wait(offset);
        const closed = app.close({ drain: 2000 }); // drain-clear races the timer
        const settled = await queued;
        expect(settled.status).toBe(503); // "queue" or "draining" — exactly one 503
        gate.resolve();
        expect(await (await first).text()).toBe("done");
        await expect(closed).resolves.toEqual({ timedOut: false, inFlight: 0 });
        expect(app.inFlight).toBe(0);
      }
    },
  );

  it(
    "REVIEW-BUG-5: waiter pool churn with mid-queue aborts and timeouts never misattributes a response",
    { timeout: 10000 },
    async () => {
      // HYPOTHESIS: a recycled WaiterSlot reuses the slot object while a stale
      // timer/listener/resolve still references it (U3 pooling). A stale
      // resolve would settle the WRONG request's admission promise: a served
      // body mismatched to its id, a duplicate response, or a leaked slot.
      const app = new Keala({
        env: "test",
        overload: { maxConcurrency: 2, maxQueue: 24, queueTimeoutMs: 5000 },
      });
      app.get("/w/:id", async (c) => {
        await wait(2);
        return c.text(`id=${c.params("id")}`);
      });
      const controllers = new Map<number, AbortController>();
      const handles: Array<Promise<Response>> = [];
      for (let i = 0; i < 30; i++) {
        const controller = new AbortController();
        controllers.set(i, controller);
        handles.push(app.handle(new Request(`http://x/w/${i}`, { signal: controller.signal })));
      }
      await wait(5); // most are queued; abort a spread of them mid-queue
      for (const i of [0, 3, 6, 9, 12, 15, 18, 21, 24, 27]) controllers.get(i)!.abort();
      const results = await Promise.all(handles);
      expect(results).toHaveLength(30);
      let served = 0;
      for (let i = 0; i < 30; i++) {
        const response = results[i]!;
        if (response.status === 200) {
          served++;
          expect(await response.text()).toBe(`id=${i}`); // identity: no stale-resolve swap
        } else {
          expect(response.status).toBe(503);
        }
      }
      expect(served).toBeGreaterThan(10); // the aborts freed queue slots, the rest ran
      expect(app.inFlight).toBe(0);

      // Second wave with a SHORT timeout so waiters leave via the timer while
      // the pool is churning through recycled slots.
      const app2 = new Keala({
        env: "test",
        overload: { maxConcurrency: 1, maxQueue: 24, queueTimeoutMs: 15 },
      });
      app2.get("/w/:id", async (c) => {
        await wait(6);
        return c.text(`id=${c.params("id")}`);
      });
      const wave = Array.from({ length: 30 }, (_, i) =>
        app2.handle(new Request(`http://x/w/${i}`)).then(async (r) => ({
          status: r.status,
          body: r.status === 200 ? await r.text() : "",
        })),
      );
      const settled = await Promise.all(wave);
      for (let i = 0; i < 30; i++) {
        const entry = settled[i]!;
        if (entry.status === 200) expect(entry.body).toBe(`id=${i}`);
        else expect(entry.status).toBe(503);
      }
      expect(app2.inFlight).toBe(0);
      expect(waiterPoolStats().constructed).toBeLessThan(200); // pool actually recycles
    },
  );
});

describe("R4.6 review hunt: strategy × drain interleavings (U1)", () => {
  it(
    "REVIEW-BUG-6: an untaken null landing after drain is refused; a slot taken before drain stays served",
    { timeout: 8000 },
    async () => {
      // (a) The strategy's promise resolves null AFTER closeApp flipped
      // draining and the admission never took a slot: the gate must refuse
      // (never admit new work during shutdown), and the counter must not move.
      {
        const decision = deferred<null>();
        const app = new Keala({
          env: "test",
          overload: {
            maxConcurrency: 1,
            strategy: {
              onSaturated: (_state, _request) => decision.promise,
            },
          },
        });
        const gate = deferred();
        app.get("/work", async (c) => {
          await gate.promise;
          return c.text("a");
        });
        const first = app.handle(new Request("http://x/work"));
        await wait(5);
        const second = app.handle(new Request("http://x/work")); // decision pending
        const closed = app.close({ drain: 2000 });
        decision.resolve(null); // lands while draining
        const refused = await second;
        expect(refused.status).toBe(503); // draining refusal, pre-context
        expect(app.inFlight).toBe(1); // only the original request holds a slot
        gate.resolve();
        const firstRes = await first;
        expect(firstRes.status).toBe(200);
        await firstRes.text(); // bodied response during drain: hold until consumed
        await expect(closed).resolves.toEqual({ timedOut: false, inFlight: 0 });
      }
      // (b) The strategy took its slot SYNCHRONOUSLY before the drain flag
      // flipped, then resolves null during shutdown: the slot transfer already
      // happened, the request stays served, and drain waits for its settle.
      {
        const decision = deferred<null>();
        const app = new Keala({
          env: "test",
          overload: {
            maxConcurrency: 1,
            strategy: {
              onSaturated: (_state, _request, admit) => {
                admit(); // synchronous slot acquisition (DESIGN §4 protocol)
                return decision.promise;
              },
            },
          },
        });
        const gates = [deferred(), deferred()];
        app.get("/work/:id", async (c) => {
          await gates[Number(c.params("id"))]!.promise;
          return c.text(`done:${c.params("id")}`);
        });
        const first = app.handle(new Request("http://x/work/0"));
        await wait(5);
        const second = app.handle(new Request("http://x/work/1")); // slot taken, decision pending
        expect(app.inFlight).toBe(2);
        const closed = app.close({ drain: 2000 });
        decision.resolve(null); // draining now — but the slot predates it
        gates[1]!.resolve(); // let the slot-transferred request run to completion
        const served = await second;
        expect(served.status).toBe(200);
        expect(await served.text()).toBe("done:1");
        gates[0]!.resolve();
        const firstRes = await first;
        expect(firstRes.status).toBe(200);
        await firstRes.text(); // release the drain hold on the bodied response
        await expect(closed).resolves.toEqual({ timedOut: false, inFlight: 0 });
      }
    },
  );
});

describe("R4.6 review hunt: deadline zombie × drain hold × pooling", () => {
  it(
    "REVIEW-BUG-7: a pooling deadline zombie settling during drain neither double-releases nor retires into the pool",
    { timeout: 8000 },
    async () => {
      // HYPOTHESIS: deadline wins (releaseInFlight + deadlineAnswered), then
      // the zombie settles a BODIED response while draining. If the
      // deadlineAnswered guard were checked before the funnel reset it (or the
      // zombie slipped through holdBody), the settle would release a second
      // time (inFlight -> -1) or retire a zombie context into the pool.
      const app = new Keala({ env: "test", pooling: true, requestTimeout: 40 });
      const gate = deferred();
      app.get("/z", () =>
        gate.promise.then(
          () => new Response("late-body", { headers: { "content-type": "text/plain" } }),
        ),
      );
      app.get("/ok", (c) => {
        return c.text("ok");
      });
      // A clean request first so the pool has recycled at least one context.
      expect(await (await app.handle(new Request("http://x/ok"))).text()).toBe("ok");

      const inflight = app.handle(new Request("http://x/z")); // parks
      expect(app.inFlight).toBe(1);
      const closed = app.close({ drain: 3000 });
      const response = await inflight; // 504 at the deadline
      expect(response.status).toBe(504);
      expect(app.inFlight).toBe(0); // freed by the deadline, not held by drain

      // close must complete WITHOUT waiting for the zombie's body/gate: there
      // is no hold — the 504 path released the slot at answer time.
      await expect(closed).resolves.toEqual({ timedOut: false, inFlight: 0 });

      gate.resolve(); // zombie settles a bodied response mid/post-drain
      await wait(30);
      expect(app.inFlight).toBe(0); // PREDICTED ACTUAL if unguarded: -1 (double release)
    },
  );
});
