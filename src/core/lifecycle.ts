/**
 * R4.6 lifecycle: the in-flight counter base and its state machine.
 *
 * ONE counter serves three masters — overload admission (capacity), drain
 * completion (when may the process exit) and ops metrics (`app.inFlight`).
 * The counter is the unbundlable base: unconfigured apps pay two field
 * loads, one branch and one increment on admit, and a flag-guarded
 * decrement in the settle tail — measured against bench noise in
 * bench/lifecycle-overhead.ts.
 */

import type { Application } from "./app.ts";
import { serverOf } from "./server-slot.ts";
import type { CloseOptions, CloseStatus, OverloadOptions } from "../types.ts";
import { normalizeOverload } from "./lifecycle-admission.ts";
import type { LifecycleOverload, WaiterSlot } from "./lifecycle-admission.ts";

/** Why a request was refused at the admission gate (pre-context, pre-funnel). */
export type OverloadReason = "concurrency" | "queue" | "draining";

/**
 * One queued waiter: `admit` transfers a freed slot (the releasing request
 * already decremented), `drop` leaves the queue rejected.
 */
export interface QueueWaiter {
  admit(): void;
  drop(reason: OverloadReason): void;
}

export interface LifecycleState {
  overload: LifecycleOverload | null;
  draining: boolean;
  /** Admitted-and-unsettled requests, plus body-holds accrued during drain. */
  inFlight: number;
  queue: QueueWaiter[];
  /** Idle waiter slots (U3) — steady-state queue churn constructs nothing. */
  waiterPool: WaiterSlot[];
  closeWaiters: (() => void)[];
  closePromise: Promise<CloseStatus> | null;
  /**
   * app.onShutdown() handlers: run once, in registration order, after the
   * drain settles and before close() resolves (flush logs/metrics, close
   * pools). Failures are contained and logged — one bad hook must not
   * block the rest of the shutdown or hang close().
   */
  shutdownHandlers: Array<() => unknown>;
  shutdownRan: boolean;
  /**
   * Force the in-flight close (set by closeApp): a repeat close with
   * drain 0 escalates — adapter force routines run, then {timedOut:true}.
   */
  escalate: (() => void) | null;
}

/** Adapter contract for graceful stop (implemented by both adapters). */
export interface GracefulStopOptions {
  /** Milliseconds to wait for in-flight work; the core pre-validates (> 0). */
  drain: number;
  /**
   * Register a callback for "application counter reached zero". Returns true
   * when ALREADY settled (the callback will not fire).
   */
  onSettled(callback: () => void): boolean;
  /**
   * Register the adapter's force routine (clear its drain timer, kill
   * sockets, settle its promise): invoked when an operator escalates a
   * running close (second SIGTERM / repeat close with drain 0).
   */
  registerForce?(force: () => void): void;
}

/** Anything the core can ask a server handle to do during shutdown. */
export interface StoppableHandle {
  stop(closeActiveConnections?: boolean): void;
  stopGraceful?(options: GracefulStopOptions): Promise<{ timedOut: boolean }>;
}

export const createLifecycle = (overload: OverloadOptions | undefined): LifecycleState => ({
  shutdownHandlers: [],
  shutdownRan: false,
  overload: overload === undefined ? null : normalizeOverload(overload),
  draining: false,
  inFlight: 0,
  queue: [],
  waiterPool: [],
  closeWaiters: [],
  closePromise: null,
  escalate: null,
});

export const normalizeRequestTimeout = (value: unknown): number => {
  if (value === undefined || value === 0) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(
      "requestTimeout requires a non-negative finite number of milliseconds (0 disables)",
    );
  }
  return value;
};

/**
 * The in-flight release tail: decrement, hand the freed slot to the head of
 * the queue (slot transfer — the counter never dips below its floor), and
 * wake drain waiters when the app reaches zero. Guards are inlined field
 * loads; an unconfigured app never enters the inner calls.
 */
export const releaseInFlight = (lc: LifecycleState): void => {
  lc.inFlight--;
  if (lc.queue.length > 0) refillFromQueue(lc);
  if (lc.inFlight === 0 && lc.closeWaiters.length > 0) {
    const waiters = lc.closeWaiters.splice(0);
    for (const wake of waiters) wake();
  }
};

const refillFromQueue = (lc: LifecycleState): void => {
  const overload = lc.overload;
  if (overload === null) return;
  while (lc.queue.length > 0 && lc.inFlight < overload.maxConcurrency) {
    lc.queue.shift()?.admit();
  }
};

/**
 * Settle-time release (the stable per-app callback `app.#settle`): during
 * drain a bodied response holds its slot until the consumer finishes
 * (pull-based wrapper, zero buffering) — draining must not cut streams it
 * promised to let finish.
 */
export const settleRequest = (lc: LifecycleState, value: Response): Response => {
  if (lc.draining && value.body !== null) return holdBody(lc, value);
  releaseInFlight(lc);
  return value;
};

/**
 * Wrap a drain-time bodied response so its in-flight slot releases only
 * when the consumer finishes (done, errored or cancelled). One release per
 * hold: a consumer cancelling with a pull parked on a slow producer makes
 * the resumed pull throw into the catch — without the guard that path
 * would release a SECOND time (pool.ts mirrors the same discipline).
 */
const holdBody = (lc: LifecycleState, value: Response): Response => {
  // Evolving let: the reader type differs across the DOM/Bun stream libs —
  // inferring from the assignment keeps both happy (same as pool.ts).
  let reader;
  try {
    reader = value.body!.getReader();
  } catch {
    // Locked/unreadable: a reused Response — loud failure, and drain must
    // not wait on it forever.
    console.error(
      "\n  keala: response body was locked or unreadable during drain — a handler returned a reused Response\n",
    );
    releaseInFlight(lc);
    return value;
  }
  let released = false;
  const releaseHold = (): void => {
    if (released) return;
    released = true;
    releaseInFlight(lc);
  };
  return new Response(
    new ReadableStream({
      async pull(controller) {
        try {
          const { done, value: chunk } = await reader.read();
          if (done) {
            controller.close();
            releaseHold();
            return;
          }
          controller.enqueue(chunk);
        } catch (error) {
          releaseHold();
          controller.error(error);
        }
      },
      cancel(reason) {
        void reader.cancel(reason).catch(() => undefined);
        releaseHold();
      },
    }),
    { status: value.status, statusText: value.statusText, headers: value.headers },
  );
};

/** Register a drain-completion callback; true when already settled. */
export const subscribeSettled = (lc: LifecycleState, callback: () => void): boolean => {
  if (lc.inFlight === 0) return true;
  lc.closeWaiters.push(callback);
  return false;
};

/**
 * Run one handler under the shutdown cap (HA-4): a hook that never settles
 * must not hang close() forever. The timer resolves the wrapper with
 * undefined on expiry — the loop logs and moves to the NEXT handler — while
 * the handler's own (late) settlement is observed here so it can never
 * surface as an unhandled rejection.
 */
const awaitWithShutdownTimeout = (
  handler: () => unknown,
  timeoutMs: number,
  label: string,
): Promise<unknown> =>
  new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      console.error(
        `\n  keala: ${label} did not settle within ${timeoutMs}ms — continuing shutdown\n`,
      );
      resolve(undefined);
    }, timeoutMs);
    timer.unref?.();
    Promise.resolve(handler()).then(
      (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
      },
      (reason) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        // Assimilate the rejection into the wrapper so the caller's own
        // try/catch (the contained-failure log) still observes it.
        resolve(Promise.reject(reason));
      },
    );
  });

/** Run the registered shutdown handlers exactly once, contained. */
const runShutdownHandlers = (lc: LifecycleState, shutdownTimeoutMs: number): Promise<void> => {
  if (lc.shutdownRan) return Promise.resolve();
  lc.shutdownRan = true;
  const handlers = lc.shutdownHandlers.splice(0);
  if (handlers.length === 0) return Promise.resolve();
  // Registration ORDER, sequentially: a pool-closing hook must not race
  // the flush that logs the stats it produced. Each hook is capped at
  // `shutdownTimeoutMs` (0 = wait indefinitely, the pre-HA-4 contract).
  return (async (): Promise<void> => {
    for (let index = 0; index < handlers.length; index++) {
      const handler = handlers[index];
      if (handler === undefined) continue;
      try {
        if (shutdownTimeoutMs > 0) {
          await awaitWithShutdownTimeout(
            handler,
            shutdownTimeoutMs,
            `onShutdown handler #${index + 1}`,
          );
        } else {
          await handler();
        }
      } catch (reason) {
        console.error(
          `\n  keala: onShutdown handler #${index + 1} failed\n  `,
          reason instanceof Error ? (reason.stack ?? reason.message) : reason,
        );
      }
    }
  })();
};

/** Register an app.onShutdown() handler (validated at the app boundary). */
export const registerShutdownHandler = (lc: LifecycleState, handler: () => unknown): void => {
  lc.shutdownHandlers.push(handler);
};

const DEFAULT_DRAIN_MS = 30_000;

/**
 * HA-4: per-hook shutdown cap, in milliseconds (10s by default, 0 = wait
 * indefinitely). The public `CloseOptions.shutdownTimeout` field in types.ts
 * carries the type; the default lives here next to the drain default.
 */

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * Graceful close, application side: flip draining (the gate starts
 * refusing), reject queued waiters, then let the adapter own socket truth
 * (stopGraceful) or wait on the counter directly in embedded (server-less)
 * mode.
 */
export const closeApp = (
  lc: LifecycleState,
  handle: StoppableHandle | undefined,
  options: CloseOptions | undefined,
): Promise<CloseStatus> => {
  if (lc.closePromise !== null) {
    // Escalation (CT-1/FINDING-2/SEC-8b/HA-3): a repeat close with drain 0
    // while a close is running means FORCE — the signal bridge's second
    // SIGTERM must not be swallowed by idempotency. A COMPLETED close
    // escalates nothing (REVIEW-BUG-11: third-party force routines must
    // observe "running" only).
    if (options?.drain === 0) lc.escalate?.();
    return lc.closePromise;
  }
  const drain = options?.drain ?? DEFAULT_DRAIN_MS;
  if (drain !== Number.POSITIVE_INFINITY && (!Number.isFinite(drain) || drain < 0)) {
    throw new TypeError(
      "close() drain requires a non-negative number of milliseconds (or Infinity)",
    );
  }
  const shutdownTimeout = options?.shutdownTimeout ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  if (!Number.isFinite(shutdownTimeout) || shutdownTimeout < 0) {
    throw new TypeError(
      "close() shutdownTimeout requires a non-negative finite number of milliseconds (0 waits indefinitely)",
    );
  }
  lc.draining = true;
  const queued = lc.queue.splice(0);
  for (const waiter of queued) waiter.drop("draining");

  const promise = new Promise<CloseStatus>((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (timedOut: boolean): void => {
      if (done) return;
      done = true;
      // The close is over — later repeat closes must not re-fire adapter
      // force routines (REVIEW-BUG-11).
      lc.escalate = null;
      if (timer !== undefined) clearTimeout(timer);
      if (timedOut) handle?.stop(true);
      // onShutdown hooks run after the drain, before close() resolves.
      void runShutdownHandlers(lc, shutdownTimeout).then(() =>
        resolve({ timedOut, inFlight: lc.inFlight }),
      );
    };
    if (drain === 0) {
      // Immediate force (CT-9): the listener ALWAYS dies here — an idle
      // server must not keep answering 503s with the port still bound.
      handle?.stop(true);
      done = true;
      void runShutdownHandlers(lc, shutdownTimeout).then(() =>
        resolve({ timedOut: lc.inFlight > 0, inFlight: lc.inFlight }),
      );
      return;
    }
    if (handle?.stopGraceful !== undefined) {
      handle
        .stopGraceful({
          drain,
          onSettled: (callback) => subscribeSettled(lc, callback),
          registerForce: (force) => {
            lc.escalate = () => {
              force();
              finish(true);
            };
          },
        })
        .then(
          (status) => finish(status.timedOut),
          (error: unknown) => {
            // An adapter bug must not hang close() — loud, then force.
            console.error("\n  keala: stopGraceful rejected — forcing close\n", error);
            finish(true);
          },
        );
      return;
    }
    // Embedded mode (or an adapter without graceful support): best-effort
    // stop, then wait on the counter ourselves.
    try {
      handle?.stop();
    } catch {
      // stop() on an already-dead server is not worth failing close() over.
    }
    // A forced escalation here is just the drain timeout, immediately.
    lc.escalate = () => finish(true);
    if (subscribeSettled(lc, () => finish(false))) {
      finish(false);
      return;
    }
    // Ref'd on purpose (rule r9): the drain window must hold the event
    // loop so an empty process exits when the drain completes, not before.
    if (drain !== Number.POSITIVE_INFINITY) timer = setTimeout(() => finish(true), drain);
  });
  lc.closePromise = promise;
  return promise;
};

/**
 * SIGTERM/SIGINT bridge (`listen({ signals: true })`): first signal drains
 * with the default timeout, any later signal force-closes. The bridge never
 * exits the process itself — the drain timer holds the event loop, and once
 * everything settles the loop empties naturally.
 *
 * PERMANENT listeners (REVIEW-BUG-1/CT-43): `process.once` would consume
 * the handler on first delivery, so a repeated SAME-NAME signal (the k8s
 * SIGTERM→SIGTERM pattern) would fall through to the OS default disposition
 * and kill the process mid-drain. The `fired` flag carries the once-
 * semantics; the listener stays armed for the escalation lifetime.
 */
export const installSignalBridge = (app: Application): void => {
  let fired = false;
  const onSignal = (): void => {
    if (!fired) {
      fired = true;
      void app.close();
      return;
    }
    // Escalation. A RUNNING close force-closes through its escalate hook.
    // A COMPLETED close has none left — and its promise resolves without
    // touching the server again, so a process whose event loop is held by
    // user resources (DB pool keepalive, a late websocket) would ignore
    // every further stop signal and need SIGKILL (R4.10 repro: 3x SIGTERM
    // no-op). Hard-stop the server directly instead.
    void app.close({ drain: 0 }).then(() => serverOf(app)?.stop(true));
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
};
