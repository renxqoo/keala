/**
 * R4.6 admission: the rejection style, the gate, the pluggable strategy
 * (U1) and the pooled queue waiters (U3).
 *
 * Pre-context by design — no Context, no error funnel, no mapper; refusing
 * is an admission decision, not an error. The mechanism (counter, draining
 * rejection, slot-transfer refill) stays in the core; the strategy decides
 * only "what happens once the app is at capacity". The built-ins: failFast
 * (default) and queue (implicit when maxQueue > 0, byte-equal to r4-4).
 */

import type { AdmissionStrategy, OverloadOptions, OverloadReason } from "../types.ts";
import type { LifecycleState, QueueWaiter } from "./lifecycle.ts";
import { releaseInFlight } from "./lifecycle.ts";
import type { RequestSource } from "./request-source.ts";
import { sourceRequest, sourceSignal } from "./request-source.ts";

/**
 * The built-in admission rejection. Register `overload.handler` to restyle
 * it — a throwing handler must not take the gate down with it: loud first,
 * then the built-in 503.
 */
export const rejectResponse = (
  lc: LifecycleState,
  request: RequestSource,
  reason: OverloadReason,
): Response => {
  const overload = lc.overload;
  if (overload?.handler !== undefined) {
    try {
      // The handler contract speaks fetch Request shape; a native source is
      // materialized (rejections are the cold path — the allocation stands).
      const custom = overload.handler(sourceRequest(request), reason);
      if (custom instanceof Response) return custom;
    } catch (error) {
      console.error("\n  keala: overload handler threw — answering the built-in 503\n", error);
    }
  }
  const headers: Record<string, string> = {
    "content-type": "text/plain; charset=utf-8",
    connection: "close",
  };
  // Retry-After guides clients to a live peer; a draining server is going
  // away, so the header would be advice to wait for a door that closes.
  if (!lc.draining && overload !== null && overload.retryAfterSeconds > 0) {
    headers["retry-after"] = String(overload.retryAfterSeconds);
  }
  return new Response("Service Unavailable", { status: 503, headers });
};

/**
 * Admission at the request-source entry. Returns null when admitted (the
 * counter was incremented — callers own exactly one release), a Response
 * when refused now, or a Promise settling with null (admitted from the
 * queue — the counter was incremented by the slot transfer) or a Response
 * (refused while queued).
 */
export const admitRequest = (
  lc: LifecycleState,
  request: RequestSource,
): Response | Promise<Response | null> | null => {
  if (lc.draining) return rejectResponse(lc, request, "draining");
  const overload = lc.overload;
  if (overload === null || lc.inFlight < overload.maxConcurrency) {
    lc.inFlight++;
    return null;
  }
  // `admit` lets a strategy take its slot SYNCHRONOUSLY when it acquires
  // capacity — the built-in queue needs that: the slot transfer must land
  // before drain bookkeeping observes the counter. A null that never called
  // admit() is still admitted by the core (sync, or in the resolution
  // microtask — no request can interleave before the increment).
  let taken = false;
  const admit = (): void => {
    if (taken) return;
    taken = true;
    lc.inFlight++;
  };
  // Every REFUSAL exits through here (R4.10): a strategy may have called
  // admit() before deciding to refuse (or throwing, or returning garbage) —
  // the taken slot must return to the pool or it is gone forever: capacity
  // permanently shrinks by one and close() burns its whole drain window on
  // an idle app. releaseInFlight also refills the queue, which is correct —
  // the slot is genuinely free again.
  const refuse = (response: Response): Response => {
    if (!taken) return response;
    taken = false;
    releaseInFlight(lc);
    return response;
  };
  // Strategies speak the same fetch-Request contract as overload.handler —
  // a native source is materialized (saturation is the cold path). The RAW
  // source rides along as the last argument: eviction signals (the client's
  // disconnect) live there, and a materialized Request's own signal is
  // inert for native transports (REVIEW-SEC-15 — queue starvation).
  const fallback = (error: unknown): Response => {
    console.error("\n  keala: overload strategy misbehaved — answering the built-in 503\n", error);
    return rejectResponse(lc, request, "concurrency");
  };
  let decision: ReturnType<AdmissionStrategy["onSaturated"]>;
  try {
    decision = overload.strategy.onSaturated(lc, sourceRequest(request), admit, request);
  } catch (error) {
    // A throwing strategy must not escape app.handle (REVIEW-CT-34).
    return refuse(fallback(error));
  }
  if (decision === null) {
    if (!taken) admit();
    return null;
  }
  if (decision instanceof Response) return refuse(decision);
  if (typeof (decision as { then?: unknown }).then !== "function") {
    // Garbage returns (strings, numbers, objects) are strategy bugs, not
    // responses (REVIEW-SEC-3).
    return refuse(
      fallback(new TypeError("onSaturated returned a non-Response, non-null, non-thenable value")),
    );
  }
  return decision.then(
    (wake) => {
      if (wake === null) {
        // A slot held since before the drain flag flipped stays served
        // (admitted in-flight); an untaken admission into a draining app
        // is refused — the gate never admits new work during shutdown.
        if (taken) return null;
        if (lc.draining) return refuse(rejectResponse(lc, request, "draining"));
        // A slow async strategy resolving null after capacity refilled and
        // was re-taken by others must not oversubscribe (R4.10): the
        // admission contract caps inFlight at maxConcurrency, so the late
        // null is refused instead of pushed over the ceiling.
        if (lc.inFlight >= overload.maxConcurrency) {
          return refuse(rejectResponse(lc, request, "concurrency"));
        }
        admit();
        return null;
      }
      if (wake instanceof Response) return refuse(wake);
      // Undefined et al. from an async strategy is the same bug class as
      // garbage sync returns (REVIEW-SEC-4).
      return refuse(fallback(new TypeError("onSaturated resolved a non-Response, non-null value")));
    },
    (error: unknown) => {
      return refuse(fallback(error));
    },
  );
};

/** Built-in strategy (U1): refuse the moment the app is at capacity. */
export const failFastAdmission: AdmissionStrategy = {
  onSaturated: (lc, request) => rejectResponse(lc, request, "concurrency"),
};

/**
 * Built-in strategy (U1): FIFO queue up to maxQueue, then refuse. Slot
 * transfers in releaseInFlight's refill wake the head; waiters leave on
 * timeout, client disconnect, drain start, or a full-queue refusal.
 */
export const queueAdmission: AdmissionStrategy = {
  onSaturated: (lc, request, admit, source) => {
    const overload = lc.overload;
    if (overload === null || lc.queue.length >= overload.maxQueue) {
      return rejectResponse(lc, request, "concurrency");
    }
    // The waiter's transfer IS the strategy's admit: synchronous slot
    // acquisition at refill time, exactly when capacity frees. The waiter
    // subscribes to the RAW source's abort channel — the materialized
    // request's signal is inert for native transports, and a vanished
    // queued client must evict at once, not hold its slot to the timeout
    // (REVIEW-SEC-15).
    return enqueueRequest(lc, source, overload.queueTimeoutMs, admit);
  },
};

/** Waiter slots recycle through this cap; steady-state bursts build none. */
const WAITER_POOL_MAX = 64;

/** Construction counter for the steady-state zero-allocation perf lock. */
let waitersConstructed = 0;
export const waiterPoolStats = (): { constructed: number } => ({ constructed: waitersConstructed });

const enqueueRequest = (
  lc: LifecycleState,
  source: RequestSource,
  timeoutMs: number,
  transfer: () => void,
): Promise<Response | null> => {
  const waiter = lc.waiterPool.pop() ?? new WaiterSlot();
  // withResolvers: the promise pair without an executor closure.
  const { promise, resolve } = Promise.withResolvers<Response | null>();
  waiter.arm(lc, source, resolve, timeoutMs, transfer);
  if (!waiter.isSettled) lc.queue.push(waiter);
  return promise;
};

/**
 * One queued waiter (U3: pooled). `admit`/`drop` are invoked AFTER removal
 * from the queue (refill's shift, drain's splice); `leave` removes itself
 * (timeout, client disconnect). All continuations are slot-owned methods —
 * steady-state queue churn allocates only the promise and its timer.
 */
export class WaiterSlot implements QueueWaiter {
  private lc: LifecycleState | null = null;
  private request: RequestSource | null = null;
  private resolve: ((value: Response | null) => void) | null = null;
  private signal: AbortSignal | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private transfer: (() => void) | null = null;
  private settled = true;
  private readonly onTimeout = (): void => {
    this.leave("queue");
  };
  private readonly onAbort = (): void => {
    this.leave("queue");
  };

  get isSettled(): boolean {
    return this.settled;
  }

  arm(
    lc: LifecycleState,
    request: RequestSource,
    resolve: (value: Response | null) => void,
    timeoutMs: number,
    transfer: () => void,
  ): void {
    this.transfer = transfer;
    this.lc = lc;
    this.request = request;
    this.resolve = resolve;
    this.settled = false;
    if (timeoutMs > 0) {
      this.timer = setTimeout(this.onTimeout, timeoutMs);
      this.timer.unref?.();
    }
    const signal = sourceSignal(request);
    this.signal = signal;
    if (signal.aborted) {
      // The client is already gone — never enter the queue.
      this.finish(rejectResponse(lc, request, "queue"));
      return;
    }
    signal.addEventListener("abort", this.onAbort, { once: true });
  }

  admit(): void {
    // Slot transfer: the releasing request already decremented; this one
    // takes the freed slot (synchronously — drain bookkeeping must never
    // observe the counter dip). Only an armed (queued) waiter admits.
    if (this.settled) return;
    // Armed waiters always carry their transfer; an impossible gap would
    // still self-heal — the core's wrapper admits untaken nulls.
    this.transfer?.();
    this.finish(null);
  }

  drop(reason: OverloadReason): void {
    if (this.settled) return;
    this.finish(rejectResponse(this.lc as LifecycleState, this.request as RequestSource, reason));
  }

  /** Timeout / client disconnect: remove from the queue, then reject. */
  private leave(reason: OverloadReason): void {
    if (this.settled) return;
    const queue = this.lc?.queue;
    if (queue !== undefined) {
      const at = queue.indexOf(this);
      if (at >= 0) queue.splice(at, 1);
    }
    this.finish(rejectResponse(this.lc as LifecycleState, this.request as RequestSource, reason));
  }

  private finish(value: Response | null): void {
    if (this.settled) return;
    this.settled = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.signal?.removeEventListener("abort", this.onAbort);
    this.signal = null;
    const resolve = this.resolve;
    const lc = this.lc;
    this.resolve = null;
    this.lc = null;
    this.request = null;
    this.transfer = null;
    // Recycle into the owning lifecycle — steady-state churn constructs
    // nothing (the pool cannot outgrow a saturated burst).
    if (lc !== null && lc.waiterPool.length < WAITER_POOL_MAX) lc.waiterPool.push(this);
    resolve?.(value);
  }

  constructor() {
    waitersConstructed++;
  }
}

/** Normalized, validated overload configuration (the LifecycleState view). */
export interface LifecycleOverload {
  maxConcurrency: number;
  maxQueue: number;
  queueTimeoutMs: number;
  retryAfterSeconds: number;
  handler: ((request: Request, reason: OverloadReason) => Response) | undefined;
  strategy: AdmissionStrategy;
}

const positiveInteger = (value: unknown, name: string): number => {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new TypeError(`overload.${name} requires a positive integer`);
  }
  return value as number;
};

const OVERLOAD_KEYS = new Set([
  "maxConcurrency",
  "maxQueue",
  "queueTimeoutMs",
  "retryAfterSeconds",
  "handler",
  "strategy",
]);

export const normalizeOverload = (options: OverloadOptions): LifecycleOverload => {
  for (const key of Object.keys(options)) {
    if (!OVERLOAD_KEYS.has(key)) {
      // `maxConcurreny: 1` used to vanish silently — disarming capacity
      // protection entirely. Refuse loudly instead.
      throw new TypeError(`overload.${key} is not an overload option (typo?)`);
    }
  }
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
    options.maxQueue === undefined
      ? 0
      : options.maxQueue === 0
        ? 0 // 0 is the documented fail-fast default — explicit is legal
        : positiveInteger(options.maxQueue, "maxQueue");
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
  const strategy = options.strategy;
  if (strategy !== undefined && typeof strategy.onSaturated !== "function") {
    throw new TypeError("overload.strategy requires an onSaturated function");
  }
  return {
    maxConcurrency,
    maxQueue,
    queueTimeoutMs,
    retryAfterSeconds,
    handler,
    // Implicit selection stays byte-equal to r4-4; injection overrides.
    strategy: strategy ?? (maxQueue > 0 ? queueAdmission : failFastAdmission),
  };
};
