/**
 * Internal state carried by the single per-request context object.
 *
 * Every field is an own property created in a fixed order, so all contexts
 * share one hidden class. `null` sentinels mean "not yet materialized";
 * `ipValue` distinguishes unresolved (`null`) from resolved-empty (`""`).
 */

import type { HeaderMap, Runtime } from "../../types.ts";
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
  ipValue: string | null;
  allowedValue: Set<string> | null;
  /**
   * Path-parameter arrays published by the router (U2: raw match product, no
   * per-request Record). `names[i]` names `values[i]`; parallel and equal
   * length. Frozen empties when no route matched — a handler only ever runs
   * post-match, and the unmatched-middleware case reads `c.params(name)` →
   * undefined. Read through the `c.params(name)` method (lastIndexOf — the
   * LAST capture of a repeated name wins).
   */
  paramNames: ReadonlyArray<string>;
  paramValues: ReadonlyArray<string>;
  /** values-index offset for `names[0]` (the table-regex layer hands out the
   * regex exec array itself; see RouteMatch.offset). 0 on every other layer. */
  paramOffset: number;

  /**
   * The route pattern this request matched ("/users/:id", mount prefix
   * included); "" when no route matched (404/501 fallback chains). The
   * bounded-cardinality label for metrics and span names (R411 Fix 4).
   * A direct slot like `params`: assigned once by dispatch, never derived.
   */
  routePath: string;
  /** The matched route's registered name; undefined when unnamed or unmatched. */
  routeName: string | undefined;
  // response side
  querystringValue: string | null;
  hostValue: string | null;
  urlObjectValue: URL | null;
  statusValue: number;
  headersRecord: HeaderMap | null;
  /**
   * Bit-packed response flags — one field write instead of four.
   * (U3c: bits 1 = explicit status and 2 = explicit null body died with the
   * response setters.) 4 = multi-value header,
   * 256 = dev tracing: a matched route's own layers were reached
   * (DOGFOOD-R1 C4 — set by the chain marker, never on the prod hot path),
   * 512 = dev tracing enabled for this context (set at creation only when
   * app.env === "development" — DOGFOOD-R2 C2; compose reads it to gate the
   * stall bit, production pays one AND per level and never writes),
   * 1024 = dev tracing: a NON-terminal middleware level returned without
   * calling next() and without a response — the chain stalled (the request
   * will answer 404 unless something upstream produced a response).
   * 16384 = the request deadline fired (R4.6): late `c.signal` readers see
   * an aborted signal even after the error funnel reset the flags.
   *
   * The commit contract carries no rebuild flags: once `c._res` is set,
   * header writes go straight onto the committed Response's Headers and
   * body/status writes throw (docs/KEALA-NATIVE-API.md §3).
   */
  flags: number;
  // dual-mode commit slot (see core/compose.ts)
  _res: Response | undefined;
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
  /**
   * Serialized JSON text of an object bodyValue — memoized by whichever
   * consumer serializes first (etag() hashing, the finalizer, sugar). The
   * second serializer reuses it instead of re-running JSON.stringify on
   * multi-megabyte payloads (R4.10: etag() alone doubled JSON cost).
   */
  bodySerializedValue?: string;
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
