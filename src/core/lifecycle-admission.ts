/**
 * R4.6 admission: the rejection style and the gate. Pre-context by design —
 * no Context, no error funnel, no mapper; refusing is an admission
 * decision, not an error. The queue and the pluggable strategy (U1) grow
 * here in lockstep with the waiter pool (U3).
 */

import type { OverloadReason } from "../types.ts";
import type { LifecycleState } from "./lifecycle.ts";
import type { RequestSource } from "./request-source.ts";
import { sourceRequest } from "./request-source.ts";

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
 * counter was incremented — callers own exactly one release), or a refusal
 * Response. The queued form (Promise settling with null after a slot
 * transfer) arrives with the queue strategy.
 */
export const admitRequest = (
  lc: LifecycleState,
  request: RequestSource,
): Response | null => {
  if (lc.draining) return rejectResponse(lc, request, "draining");
  const overload = lc.overload;
  if (overload === null || lc.inFlight < overload.maxConcurrency) {
    lc.inFlight++;
    return null;
  }
  return rejectResponse(lc, request, "concurrency");
};
