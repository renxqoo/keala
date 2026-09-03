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

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { Keala } from "../src/core/app.ts";
import { startNodeServer, type NodeServerHandle } from "../src/adapters/node.ts";
import { startBunServer, type ServeImplementation } from "../src/index.ts";
import { admitRequest, waiterPoolStats } from "../src/core/lifecycle-admission.ts";
import { closeApp, createLifecycle, releaseInFlight } from "../src/core/lifecycle.ts";
import { attachServer, serverOf } from "../src/core/server-slot.ts";
import type { StoppableHandle } from "../src/core/lifecycle.ts";
import { streamText } from "../src/helpers/streams.ts";

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
          c.body = `done:${c.params?.["id"]}`;
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
          c.body = "done";
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
        c.body = `id=${c.params?.["id"]}`;
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
        c.body = `id=${c.params?.["id"]}`;
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
          c.body = "a";
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
          await gates[Number(c.params?.["id"])]!.promise;
          c.body = `done:${c.params?.["id"]}`;
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
        c.body = "ok";
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

describe("R4.6 review hunt: Node adapter wire truth", () => {
  it(
    "REVIEW-BUG-8: client abort mid-drain — wire clears early, close completes on the app counter",
    { timeout: 8000 },
    async () => {
      // HYPOTHESIS: the client walks away while stopGraceful waits: the wire
      // counter hits zero through res 'close' (an "unproductive" wake — the app
      // slot is still held by the parked handler). When the handler later
      // settles, the app-side onSettled must still fire finish(false); a lost
      // callback would wedge close onto the drain timer ({timedOut:true}).
      const app = new Keala({ env: "test" });
      const gate = deferred();
      app.get("/stuck", async (c) => {
        await gate.promise;
        c.body = "late";
      });
      const server = await startNodeServer(app, { port: 0, hostname: "127.0.0.1" }).ready();
      liveServers.push(server);
      const abort = new AbortController();
      const gone = fetch(`http://127.0.0.1:${server.port}/stuck`, { signal: abort.signal }).catch(
        () => undefined,
      );
      await wait(60); // handler parked: wire 1, app 1
      expect(app.inFlight).toBe(1);
      const closed = app.close({ drain: 4000 });
      await wait(60);
      abort.abort(); // wire dies; wake finds appSettled=false and returns
      await wait(120);
      let resolved = false;
      void closed.then(() => {
        resolved = true;
      });
      expect(resolved).toBe(false); // still waiting on the app slot — correct
      gate.resolve(); // handler settles; response writes to the dead socket
      await expect(closed).resolves.toEqual({ timedOut: false, inFlight: 0 });
      void gone;
    },
  );

  it(
    "REVIEW-BUG-9: a late keep-alive request during drain wedges close onto the drain timer — {timedOut:true} and a force-close although app and wire both reached zero",
    { timeout: 12000 },
    async () => {
      // DEFECT: node.ts stopGraceful/onWire wire-waiter discipline. The waiters
      // array is spliced ONLY when wireInFlight reaches 0 — even when that wake
      // is unproductive (appSettled still false, node.ts:270-272 trySettle
      // returns without finishing). A keep-alive client racing the draining
      // `connection: close` (browsers and LBs do exactly this) then delivers a
      // late request on a surviving socket: its request event increments
      // wireInFlight AFTER the wake, and its finish decrements back to 0 with
      // `wireWaiters.length === 0` (node.ts:307) — nothing re-runs trySettle.
      // If the app counter settles inside that window (appSettled's own
      // trySettle sees wire >= 1), BOTH completion conditions become true at
      // different times and close rides the full drain timer: bogus
      // {timedOut:true}, closeAllConnections(), despite all work completed.
      // CONTRACT: DESIGN §2.2 r4/r5 — close resolves after drain completes;
      // §2.3 CloseStatus resolve lands "drain 完成或强停之后", not a full window
      // late with a force that kills finished sockets.
      // OBSERVABLE: everything is settled (app.inFlight === 0, the late 503
      // fully flushed on the wire), yet close resolves {timedOut:true,
      // inFlight:0} only after the entire drain window elapses.
      // STATUS: CONFIRMED-RED — reproduced with real sockets (drain 4000
      // resolved at ~4080ms with timedOut:true while inFlight hit 0 at ~280ms).
      const gate = deferred();
      // The gate is configured so the late post-drain arrival is refused
      // through rejectResponse; its handler resolves the stuck gate from
      // INSIDE the refusal, landing the app settle in the exact window where
      // the late 503 is mid-write.
      const app = new Keala({
        env: "test",
        overload: {
          maxConcurrency: 4,
          handler: () => {
            gate.resolve(); // app slot frees DURING the late refusal's write
            return undefined as unknown as Response; // fall back to the built-in 503
          },
        },
      });
      app.get("/stuck", async (c) => {
        await gate.promise;
        c.body = "late";
      });
      app.get("/stream", (c) => {
        // ~80ms stream; its headers flush BEFORE close, so the response goes
        // out keep-alive — socket Y survives the idle sweep, finishes during
        // drain, and lingers idle-unswept, able to receive the late request.
        return streamText(c, async (w) => {
          for (let i = 0; i < 4; i++) {
            await wait(20);
            w.write(`s${i};`);
          }
        });
      });

      const server = await startNodeServer(app, { port: 0, hostname: "127.0.0.1" }).ready();
      liveServers.push(server);
      const port = server.port;

      // Socket X: the parked request that keeps appSettled false across the
      // wire's zero-crossing.
      const x = net.connect({ host: "127.0.0.1", port });
      x.on("error", () => undefined);
      x.write("GET /stuck HTTP/1.1\r\nHost: x\r\n\r\n");
      await wait(40);

      // Socket Y: a keep-alive response that finishes DURING drain.
      const y = net.connect({ host: "127.0.0.1", port });
      let ydata = "";
      y.on("error", () => undefined);
      y.on("data", (chunk: Buffer) => {
        ydata += chunk.toString("utf8");
      });
      y.write("GET /stream HTTP/1.1\r\nHost: x\r\n\r\n");
      await wait(30);

      const started = Date.now();
      const closed = app.close({ drain: 4000 }); // sweep spares X and Y (both busy)
      await wait(90); // Y's stream completes; X still holds the wire count
      x.destroy(); // the wire's zero-crossing wakes trySettle — unproductive
      // (the stuck request keeps appSettled false) and the waiters array is
      // left EMPTY.
      await wait(150); // Y now sits idle-unswept: a racing client reuses it

      y.write("GET /after HTTP/1.1\r\nHost: x\r\n\r\n"); // the late arrival
      await wait(60); // refused (503), the refusal resolves the stuck gate:
      // the app counter settles while the 503 is mid-write
      expect(app.inFlight).toBe(0); // everything the close waits for is done
      expect(ydata).toContain("Service Unavailable"); // ...and flushed on the wire

      const status = await closed;
      const elapsed = Date.now() - started;
      // HEALTHY: trySettle re-runs (or the finish re-wakes) — close resolves
      // promptly with {timedOut:false}. PREDICTED ACTUAL (defect): resolves
      // only at the drain timer: {timedOut:true, inFlight:0} after ~4000ms.
      expect(status).toEqual({ timedOut: false, inFlight: 0 });
      expect(elapsed).toBeLessThan(2500); // a wedge rides the whole window
      y.destroy();
      x.destroy();
    },
  );

  it(
    "REVIEW-BUG-10: a malformed request-target (InvalidRequestTarget) does not wedge stopGraceful (no wire leak)",
    { timeout: 8000 },
    async () => {
      // HYPOTHESIS: `new NodeRequestSource` throws before the app gate runs;
      // if the 400 fail() path missed the wire accounting (no 'finish'/'close'
      // decrement), stopGraceful would wait out its drain window.
      const app = new Keala({ env: "test" });
      app.get("/ok", (c) => {
        c.body = "ok";
      });
      const server = await startNodeServer(app, { port: 0, hostname: "127.0.0.1" }).ready();
      liveServers.push(server);
      const socket = net.connect({ host: "127.0.0.1", port: server.port });
      const received = new Promise<string>((resolve) => {
        socket.once("data", (chunk: Buffer) => resolve(chunk.toString("utf8")));
      });
      socket.on("error", () => undefined);
      // "foo" is neither origin-form nor absolute-form -> constructor throws.
      socket.write("GET foo HTTP/1.1\r\nHost: x\r\n\r\n");
      const reply = await received;
      expect(reply).toContain("400");
      const started = Date.now();
      const closed = app.close({ drain: 4000 });
      const status = await closed;
      expect(status).toEqual({ timedOut: false, inFlight: 0 }); // a leaked wire slot would time out
      expect(Date.now() - started).toBeLessThan(1500);
      socket.destroy();
    },
  );
});

describe("R4.6 review hunt: closeApp against hostile adapters", () => {
  it(
    "REVIEW-BUG-11: escalation while stopGraceful is pending forces once; a rejecting stopGraceful cannot hang close; repeat close after completion is inert",
    { timeout: 8000 },
    async () => {
      // (a) Escalation: never-settling stopGraceful + a second close with
      // drain 0 must run the registered force routine and resolve
      // {timedOut:true} without waiting the drain window.
      {
        const app = new Keala({ env: "test" });
        const gate = deferred();
        app.get("/stuck", () => gate.promise.then(() => undefined));
        void app.handle(new Request("http://x/stuck")); // inFlight 1
        let forced = 0;
        let stopTrue = 0;
        const handle: StoppableHandle = {
          stop(closeActive) {
            if (closeActive) stopTrue++;
          },
          stopGraceful(grace) {
            grace.registerForce?.(() => {
              forced++;
            });
            return new Promise<{ timedOut: boolean }>(() => {}); // never settles
          },
        };
        attachServer(app, handle);
        const closed = app.close({ drain: 5000 });
        const escalated = app.close({ drain: 0 }); // second SIGTERM shape
        expect(escalated).toBe(closed); // idempotent promise identity
        await expect(closed).resolves.toEqual({ timedOut: true, inFlight: 1 });
        expect(forced).toBe(1); // the adapter's force routine ran exactly once
        expect(stopTrue).toBe(1); // closeApp's finish(true) forced the handle
        gate.resolve();
        // A THIRD close with drain 0 AFTER completion: closeApp's finish is
        // done-guarded (its own stop(true) never re-fires), but lc.escalate is
        // never cleared — the ADAPTER-registered force routine re-invokes.
        // Both shipped adapters guard their own finish, so this is only
        // observable through a custom StoppableHandle (as here: forced -> 2).
        // STATUS: CONFIRMED-RED (low severity, contract hygiene) — registerForce
        // fires with no close running; GracefulStopOptions.registerForce
        // documents "invoked when an operator escalates a RUNNING close".
        const third = app.close({ drain: 0 });
        expect(third).toBe(closed);
        await third;
        expect(stopTrue).toBe(1); // closeApp's own force: exactly once
        expect(forced).toBe(1); // PREDICTED ACTUAL: 2 — registerForce fires with no close running
        expect(serverOf(app)).toBe(handle);
      }
      // (b) A rejecting stopGraceful: loud, then force — never a hung/rejected
      // close().
      {
        const app = new Keala({ env: "test" });
        const gate = deferred();
        app.get("/stuck", () => gate.promise.then(() => undefined));
        void app.handle(new Request("http://x/stuck"));
        const handle: StoppableHandle = {
          stop: () => {},
          stopGraceful: () => Promise.reject(new Error("adapter bug")),
        };
        attachServer(app, handle);
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const closed = app.close({ drain: 5000 });
        await expect(closed).resolves.toEqual({ timedOut: true, inFlight: 1 });
        errorSpy.mockRestore();
        gate.resolve();
      }
    },
  );

  it(
    "REVIEW-BUG-12: drain:0 as the FIRST close rejects a non-empty queue exactly once each",
    { timeout: 8000 },
    async () => {
      const app = new Keala({
        env: "test",
        overload: { maxConcurrency: 1, maxQueue: 3 },
      });
      const gate = deferred();
      app.get("/work", async (c) => {
        await gate.promise;
        c.body = "done";
      });
      const first = app.handle(new Request("http://x/work"));
      const queued = [
        app.handle(new Request("http://x/work")),
        app.handle(new Request("http://x/work")),
        app.handle(new Request("http://x/work")),
      ];
      const status = await app.close({ drain: 0 }); // immediate force with a queued waiter
      expect(status).toEqual({ timedOut: true, inFlight: 1 });
      const settled = await Promise.all(queued);
      for (const response of settled) expect(response.status).toBe(503); // dropped, not served
      gate.resolve();
      const firstRes = await first;
      expect(firstRes.status).toBe(200); // in-flight work still completes
      await firstRes.text(); // settle during drain -> hold until consumed
      await wait(10);
      expect(app.inFlight).toBe(0); // no double release for the parked request
    },
  );
});

describe("R4.6 review hunt: WS upgrade settlement (§2.2 r5)", () => {
  it(
    "REVIEW-BUG-13: an upgrade settles at the 101 — no lingering concurrency slot, no drain hold, queue admission intact",
    { timeout: 8000 },
    async () => {
      // HYPOTHESIS: the upgrade response (`new Response(null)`) must release
      // its admission slot at settle time; a bodied/never-settling shape would
      // hold capacity forever (and during drain, hold the close open).
      const upgrades: Array<{ wsKey?: string }> = [];
      const runtime = {
        server: {
          upgrade: (_req: Request, opts: { data?: unknown }): boolean => {
            upgrades.push(opts.data as { wsKey?: string });
            return true;
          },
        },
      };
      const app = new Keala({
        env: "test",
        overload: { maxConcurrency: 1, maxQueue: 2 },
      });
      app.ws("/socket", {
        open: () => undefined,
        message: () => undefined,
        close: () => undefined,
      });
      const upgradeRequest = () =>
        app.handle(new Request("http://x/socket", { headers: { upgrade: "websocket" } }), runtime);

      // Straight through: admitted, upgraded, released at once.
      const response = await upgradeRequest();
      expect(response.status).toBe(200); // the stand-in Response (spec forbids 101 bodies)
      expect(upgrades).toHaveLength(1);
      expect(app.inFlight).toBe(0); // released at the upgrade, not leaked

      // Queued behind a parked HTTP request, then admitted by slot transfer.
      upgrades.length = 0;
      const gate = deferred();
      app.get("/park", async (c) => {
        await gate.promise;
        c.body = "parked";
      });
      const parked = app.handle(new Request("http://x/park"));
      await wait(5);
      const queuedUpgrade = upgradeRequest(); // saturates -> queue
      expect(app.inFlight).toBe(1);
      gate.resolve();
      const queuedUpgradeResponse = await queuedUpgrade;
      expect(queuedUpgradeResponse.status).toBe(200); // the stand-in Response
      expect(upgrades).toHaveLength(1); // the transfer admitted it, the 101 settled it
      expect(app.inFlight).toBe(0);
      await parked;
    },
  );
});

describe("R4.6 review hunt: FLAG_DEADLINE_FIRED re-arm through a mapper takeover", () => {
  it(
    "REVIEW-BUG-14: reading c.signal after a mapper-restyled 504 still yields an aborted signal",
    { timeout: 8000 },
    async () => {
      // HYPOTHESIS: the funnel's mapper-takeover path skips the built-in
      // reset, but a mapper that DOES hit builtinErrorResponse resets
      // c.flags = 0 — the deadline bit must be re-armed AFTER errorResponse
      // returns, or a late c.signal reader sees a live signal.
      const app = new Keala({ env: "test", requestTimeout: 30 });
      app.onError((error) => new Response(`mapped:${error.status}`, { status: error.status }));
      const gate = deferred();
      let sawAborted = false;
      app.get("/late-read", async (c) => {
        await gate.promise;
        sawAborted = c.signal.aborted; // materializes AFTER the deadline
      });
      const response = await app.handle(new Request("http://x/late-read"));
      expect(response.status).toBe(504);
      expect(await response.text()).toBe("mapped:504");
      gate.resolve();
      await wait(10);
      expect(sawAborted).toBe(true); // PREDICTED ACTUAL if the flag died in the funnel: false
    },
  );
});

describe("R4.6 review hunt: Bun adapter escalation through the real close path", () => {
  it(
    "REVIEW-BUG-15: escalating a pending stopGraceful via a second close({drain:0}) forces the Bun server (stop(undefined) then stop(true))",
    { timeout: 8000 },
    async () => {
      const app = new Keala({ env: "test" });
      const { impl, stopCalls } = fakeServe();
      const handle = startBunServer(app, { port: 0 }, undefined, impl);
      const gate = deferred();
      app.get("/stuck", () => gate.promise.then(() => undefined));
      void app.handle(new Request("http://x/stuck")); // inFlight 1
      expect(stopCalls()).toEqual([]);

      const closed = app.close({ drain: 5000 }); // stopGraceful begins, waits on the counter
      expect(stopCalls()).toEqual([undefined]); // stopped accepting, no force
      const escalated = app.close({ drain: 0 });
      expect(escalated).toBe(closed);
      await expect(closed).resolves.toEqual({ timedOut: true, inFlight: 1 });
      // stop(undefined) = stopGraceful's accepting stop; then the escalation's
      // TWO force stops: the adapter's own force (registerForce) and closeApp's
      // finish(true) forcing the handle. Both are legitimate.
      expect(stopCalls()).toEqual([undefined, true, true]);
      gate.resolve();
      expect(serverOf(app)).toBe(handle);
    },
  );
});
