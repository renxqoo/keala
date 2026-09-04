/**
 * Internal state carried by the single per-request context object.
 *
 * Every field is an own property created in a fixed order, so all contexts
 * share one hidden class. `null` sentinels mean "not yet materialized";
 * `ipValue` distinguishes unresolved (`null`) from resolved-empty (`""`).
 */

import type { HeaderMap, ResponseBody, Runtime } from "../../types.ts";
import type { RequestSettings } from "./settings.ts";
import type { Application } from "../app.ts";
import type { RequestSource } from "../request-source.ts";

export interface ContextState {
  appValue: Application;
  rawRequest: RequestSource;
  appSettings: RequestSettings;
  runtimeValue: Runtime | undefined;
  // request side
  pathValue: string | null;
  urlValue: string | null;
  originalUrlValue: string | null;
  ipValue: string | null;
  allowedValue: Set<string> | null;
  /** Path parameters set by the router; null when unmatched. */
  params: Record<string, string> | null;
  // response side
  querystringValue: string | null;
  statusValue: number;
  messageValue: string;
  headersRecord: HeaderMap | null;
  bodyValue: ResponseBody;
  /**
   * Bit-packed response flags — one field write instead of four.
   * 1 = explicit status, 2 = explicit null body, 4 = multi-value header,
   * 8 = content-length touched, 16 = post-commit rewrite (a committed
   * Response must be rebuilt: status override, removal, or staged headers),
   * 32 = status written AFTER the commit (statusValue wins the rebuild),
   * 64 = message written AFTER the commit (messageValue wins the reason
   * phrase), 128 = body written AFTER the commit (bodyValue wins the body),
   * 256 = dev tracing: a matched route's own layers were reached
   * (DOGFOOD-R1 C4 — set by the chain marker, never on the prod hot path),
   * 512 = dev tracing enabled for this context (set at creation only when
   * app.env === "development" — DOGFOOD-R2 C2; compose reads it to gate the
   * stall bit, production pays one AND per level and never writes),
   * 1024 = dev tracing: a NON-terminal middleware level returned without
   * calling next() and without a response — the chain stalled (the request
   * will answer 404 unless something upstream produced a response).
   * 2048 = every header/removal currently mirrored in response state was
   * already applied to the committed Response in place. The finalizer may
   * return that Response verbatim unless a status/message/body rewrite also
   * exists. A later staged operation or a newer Response commit clears it.
   * 4096 = committed Response Headers were mutated successfully (mutable),
   * 8192 = their guard rejected mutation (immutable). Neither bit means the
   * concrete Response has not been probed. A newer commit clears both.
   * 16384 = the request deadline fired (R4.6): late `c.signal` readers see
   * an aborted signal even after the error funnel reset the flags.
   * The post-commit flags are the ONLY rebuild inputs — anything staged
   * before the commit was already superseded by the committed Response.
   */
  flags: number;
  /** Header names removed AFTER a Response committed (rule-4 rebuild input). */
  removedValue: string[] | null;
  // dual-mode commit slot (see core/compose.ts)
  _res: Response | undefined;
  /** Bun c.text() identity used only if a later committed-header write rebuilds it. */
  implicitTextResponseValue: Response | undefined;
  /**
   * The response built this request whose body is a known context-independent
   * snapshot (string/bytes/JSON text/Blob). Pooling retires it at once,
   * unwrapped, so Bun's serve-time string MIME inference and both adapters'
   * direct-write paths survive; the consumption-tracking wrapper stays for
   * stream-bodied and user-built Responses, whose producers may still be
   * reading this context. Identity-only: retireWithBody compares, never
   * probes `.body` (reading it would destroy Bun's inference).
   */
  directBodyResponseValue: Response | undefined;
  // lazy facades
  stateValue: Record<string, unknown> | null;
  cookiesValue: unknown;
  // bodyParser memoization and the validator output slot stay undefined on
  // the no-body hot path; they are own fields once touched and MUST be
  // cleared on recycle (initContext) — a pooled context leaking the
  // previous request's body across users is a CRITICAL disclosure.
  bodyCache?: unknown;
  validValue?: unknown;
  // R4.6 lifecycle cold slots: materialized only when cancellation or a
  // request deadline is actually in play. Undefined/false prototype
  // defaults keep the request hot path free of own-field writes.
  /** Lazy AbortController behind `c.signal` (disconnect ∨ deadline). */
  abortValue?: AbortController;
  /**
   * True once the deadline race answered 504: the zombie handler's late
   * settle must neither release capacity again nor retire the context
   * (the live handler still holds it — it goes to GC, never the pool).
   * A boolean SLOT, not a flag: the error funnel resets flags and must
   * not erase this verdict.
   */
  deadlineAnswered?: boolean;
}

/** Flag 256 — dev route tracing (see `flags`). Shared by the router's chain
 *  marker (writer) and dispatch's swallowed-route warning (reader). */
export const FLAG_ROUTE_REACHED = 256;

/** Flag 512 — dev chain tracing enabled (context creation, dev env only). */
export const FLAG_DEV_CHAIN = 512;

/** Flag 1024 — a non-terminal middleware level stalled the chain (void
 *  return, no next, no response). Written by compose, read by dispatch's
 *  stall warning (DOGFOOD-R2 C2). */
export const FLAG_CHAIN_STALLED = 1024;

/** Flag 2048 — mirrored header changes already applied to committed Response. */
export const FLAG_COMMITTED_HEADERS_APPLIED = 2048;

/** Flags 4096/8192 — three-state committed Headers guard capability. */
export const FLAG_COMMITTED_HEADERS_MUTABLE = 4096;
export const FLAG_COMMITTED_HEADERS_IMMUTABLE = 8192;
export const FLAG_COMMITTED_HEADERS_CAPABILITY =
  FLAG_COMMITTED_HEADERS_MUTABLE | FLAG_COMMITTED_HEADERS_IMMUTABLE;

/** Flag 16384 — the request deadline fired (see `flags`). */
export const FLAG_DEADLINE_FIRED = 16384;

/**
 * The abort reason `c.signal` carries when the request deadline wins the
 * race — a TimeoutError DOMException, distinguishable from client
 * disconnects (AbortError).
 */
export const DEADLINE_REASON: DOMException = new DOMException(
  "request deadline exceeded",
  "TimeoutError",
);
