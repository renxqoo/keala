/**
 * R4.6 request deadline (U2): race a configured deadline against settlement.
 *
 * On deadline: abort `c.signal` (TimeoutError), free the capacity slot
 * immediately (the client is answered; the zombie handler no longer holds
 * capacity), answer 504 through the error funnel — the mapper can restyle
 * it — and contain the zombie's eventual settlement: the once-guard lives
 * on the context (`deadlineAnswered` boolean slot + the race object), not
 * in per-request release closures (r4-4's settleOnce/releaseOnce pair).
 */

import type { Application } from "./app.ts";
import type { Context } from "./context/context.ts";
import { DEADLINE_REASON, FLAG_DEADLINE_FIRED } from "./context/state.ts";
import { createError } from "../http/errors.ts";
import { errorResponse } from "./error-response.ts";
import type { LifecycleState } from "./lifecycle.ts";
import { releaseInFlight } from "./lifecycle.ts";

/** Settle-never-rejects containment: the race ignores an "impossible"
 * rejection instead of letting it escape toward the client. */
const ignore = (): void => undefined;

export const raceDeadline = (
  app: Application,
  lc: LifecycleState,
  c: Context,
  settled: Response | Promise<Response>,
  timeoutMs: number,
): Promise<Response> => {
  // withResolvers: the race promise without an executor closure (U2).
  const { promise, resolve } = Promise.withResolvers<Response>();
  // The once state object (U2): `done` ends the race for both sides; the
  // settle side only resolves, the deadline side answers 504 and frees the
  // slot. Context slots carry the zombie verdict (`deadlineAnswered` —
  // survive the funnel's flag reset) for the late settle.
  const once = {
    done: false,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
  };
  const settledPromise: Promise<Response> =
    settled instanceof Promise ? settled : Promise.resolve(settled);
  settledPromise.then((value: Response) => {
    if (once.done) {
      // PERF-7: the deadline already answered — the zombie's late Response
      // is dropped, but its body must not be dropped UNCONSUMED: an
      // untouched stream pins its buffers until GC (Node/undici keep the
      // whole receive window resident). Cancel cheaply and move on.
      void value.body?.cancel().catch(ignore);
      return;
    }
    once.done = true;
    if (once.timer !== undefined) clearTimeout(once.timer);
    resolve(value);
  }, ignore);
  once.timer = setTimeout(() => {
    if (once.done) return;
    once.done = true;
    c.flags |= FLAG_DEADLINE_FIRED;
    // The zombie's late settle must not release capacity again nor retire
    // the context into the pool (settleNativeHandle reads this slot).
    c.deadlineAnswered = true;
    if (c.abortValue !== undefined) c.abortValue.abort(DEADLINE_REASON);
    releaseInFlight(lc); // capacity frees now — the zombie no longer holds a slot
    const response = errorResponse(
      app,
      c,
      createError(504, "request deadline exceeded", { expose: true }),
    );
    // The funnel's context reset clears flags — re-arm the deadline bit so
    // `c.signal` still materializes aborted for late readers.
    c.flags |= FLAG_DEADLINE_FIRED;
    resolve(response);
  }, timeoutMs);
  once.timer.unref?.();
  return promise;
};
