/**
 * Internal state carried by the single per-request context object.
 *
 * Every field is an own property created in a fixed order, so all contexts
 * share one hidden class. `null` sentinels mean "not yet materialized";
 * `ipValue` distinguishes unresolved (`null`) from resolved-empty (`""`).
 */

import type { QueryMap } from "../../utils/query.ts";
import type { HeaderMap, ResponseBody, Runtime } from "../../types.ts";
import type { RequestSettings } from "./settings.ts";
import type { Application } from "../app.ts";

export interface ContextState {
  appValue: Application;
  rawRequest: Request;
  appSettings: RequestSettings;
  runtimeValue: Runtime | undefined;
  // request side
  pathValue: string | null;
  urlValue: string | null;
  originalUrlValue: string | null;
  queryValue: QueryMap | null;
  ipValue: string | null;
  allowedValue: Set<string> | null;
  /** Path parameters set by the router; null when unmatched. */
  params: Record<string, string> | null;
  // response side
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
   * The post-commit flags are the ONLY rebuild inputs — anything staged
   * before the commit was already superseded by the committed Response.
   */
  flags: number;
  /** Header names removed AFTER a Response committed (rule-4 rebuild input). */
  removedValue: string[] | null;
  // dual-mode commit slot (see core/compose.ts)
  _res: Response | undefined;
  // lazy facades
  stateValue: Record<string, unknown> | null;
  cookiesValue: unknown;
  // bodyParser memoization and the validator output slot stay undefined on
  // the no-body hot path; they are own fields once touched and MUST be
  // cleared on recycle (initContext) — a pooled context leaking the
  // previous request's body across users is a CRITICAL disclosure.
  bodyCache?: unknown;
  validValue?: unknown;
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
