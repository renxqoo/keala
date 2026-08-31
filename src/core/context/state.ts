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
   * phrase), 128 = body written AFTER the commit (bodyValue wins the body).
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
