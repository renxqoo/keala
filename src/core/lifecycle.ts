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

import type { CloseStatus, OverloadOptions } from "../types.ts";

/** Why a request was refused at the admission gate (pre-context, pre-funnel). */
export type OverloadReason = "concurrency" | "queue" | "draining";

/** Normalized, validated overload configuration (see normalizeOverload). */
export interface NormalizedOverload {
  maxConcurrency: number;
  maxQueue: number;
  queueTimeoutMs: number;
  retryAfterSeconds: number;
  handler: ((request: Request, reason: OverloadReason) => Response) | undefined;
}

/**
 * One queued waiter: `admit` transfers a freed slot (the releasing request
 * already decremented), `drop` leaves the queue rejected.
 */
export interface QueueWaiter {
  admit(): void;
  drop(reason: OverloadReason): void;
}

export interface LifecycleState {
  overload: NormalizedOverload | null;
  draining: boolean;
  /** Admitted-and-unsettled requests, plus body-holds accrued during drain. */
  inFlight: number;
  queue: QueueWaiter[];
  closeWaiters: (() => void)[];
  closePromise: Promise<CloseStatus> | null;
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
  overload: overload === undefined ? null : normalizeOverload(overload),
  draining: false,
  inFlight: 0,
  queue: [],
  closeWaiters: [],
  closePromise: null,
  escalate: null,
});

const positiveInteger = (value: unknown, name: string): number => {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new TypeError(`overload.${name} requires a positive integer`);
  }
  return value as number;
};

export const normalizeOverload = (options: OverloadOptions): NormalizedOverload => {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("overload requires an options object");
  }
  const maxConcurrency =
    options.maxConcurrency === undefined
      ? Number.POSITIVE_INFINITY
      : options.maxConcurrency === Number.POSITIVE_INFINITY
        ? Number.POSITIVE_INFINITY
        : positiveInteger(options.maxConcurrency, "maxConcurrency");
  const maxQueue =
    options.maxQueue === undefined ? 0 : positiveInteger(options.maxQueue, "maxQueue");
  const queueTimeoutMs =
    options.queueTimeoutMs === undefined
      ? 10_000
      : positiveInteger(options.queueTimeoutMs, "queueTimeoutMs");
  const retryAfter = options.retryAfterSeconds;
  if (retryAfter !== undefined && (!Number.isInteger(retryAfter) || retryAfter < 0)) {
    // 0 is the documented "omit the header" value — non-negative integer.
    throw new TypeError("overload.retryAfterSeconds requires a non-negative integer");
  }
  const retryAfterSeconds = retryAfter ?? 1;
  const handler = options.handler;
  if (handler !== undefined && typeof handler !== "function") {
    throw new TypeError("overload.handler requires a function");
  }
  if (maxQueue > 0 && maxConcurrency === Number.POSITIVE_INFINITY) {
    throw new TypeError("overload.maxQueue requires a finite overload.maxConcurrency");
  }
  return { maxConcurrency, maxQueue, queueTimeoutMs, retryAfterSeconds, handler };
};

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
