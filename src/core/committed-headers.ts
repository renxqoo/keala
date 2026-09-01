/**
 * Safe in-place mutations for a committed Fetch Response.
 *
 * Local Responses expose mutable Headers in Bun and Node, while responses
 * produced by fetch/redirect/error may carry an immutable guard (notably in
 * Node). The first eligible mutation probes the concrete Response; a guard
 * failure is remembered on the request context and the caller stages the
 * same operation for the semantic rebuild path.
 */

import type { HeaderMap } from "../types.ts";
import { FLAG_COMMITTED_HEADERS_APPLIED } from "./context/state.ts";

export const COMMITTED_HEADERS_UNKNOWN = 0;
export const COMMITTED_HEADERS_MUTABLE = 1;
export const COMMITTED_HEADERS_IMMUTABLE = 2;

export type CommittedHeadersState =
  | typeof COMMITTED_HEADERS_UNKNOWN
  | typeof COMMITTED_HEADERS_MUTABLE
  | typeof COMMITTED_HEADERS_IMMUTABLE;

interface CommittedHeaderContext {
  _res: Response | undefined;
  flags: number;
  headersRecord: HeaderMap | null;
  committedHeadersState: CommittedHeadersState;
  /** A memoized cookies facade can mutate headersRecord without re-entering
   * the context getter, so direct writes must stop once it exists. */
  cookiesValue?: unknown;
}

/** Headers whose multi-value or body-description rules stay on the rebuild path. */
export const isDirectHeader = (name: string): boolean =>
  name !== "set-cookie" && name !== "content-type" && name !== "content-length";

const recordIsAppliedOrEmpty = (c: CommittedHeaderContext): boolean => {
  if (c.headersRecord === null || (c.flags & FLAG_COMMITTED_HEADERS_APPLIED) !== 0) return true;
  for (const _ in c.headersRecord) return false;
  return true;
};

const headersOf = (c: CommittedHeaderContext): Headers | null => {
  const applied = (c.flags & FLAG_COMMITTED_HEADERS_APPLIED) !== 0;
  const committed = c._res;
  if (
    committed === undefined ||
    // A disturbed/locked body cannot be sent by the adapter. Keep it on the
    // semantic rebuild path, whose construction failure is converted to the
    // framework's static 500 instead of leaking a successful empty response.
    committed.bodyUsed ||
    committed.body?.locked === true ||
    c.committedHeadersState === COMMITTED_HEADERS_IMMUTABLE ||
    (c.cookiesValue !== undefined && c.cookiesValue !== null) ||
    // A pending semantic removal/status/message/body rewrite means this
    // Response will be rebuilt anyway. More importantly, marking a later
    // direct header as APPLIED must never make that older work look applied.
    ((c.flags & 16) !== 0 && !applied) ||
    (c.flags & (32 | 64 | 128)) !== 0 ||
    !recordIsAppliedOrEmpty(c)
  ) {
    return null;
  }
  return committed.headers;
};

const SET = 0;
const APPEND = 1;
const DELETE = 2;

const apply = (
  c: CommittedHeaderContext,
  operation: typeof SET | typeof APPEND | typeof DELETE,
  name: string,
  value?: string,
): boolean => {
  const headers = headersOf(c);
  if (headers === null) return false;
  try {
    if (operation === SET) headers.set(name, value as string);
    else if (operation === APPEND) headers.append(name, value as string);
    else headers.delete(name);
  } catch (error) {
    // Fetch header guards reject mutation with TypeError. Validation happens
    // before this helper, so other failures are real faults and must remain
    // visible instead of being misclassified as an immutable Response.
    if (!(error instanceof TypeError)) throw error;
    c.committedHeadersState = COMMITTED_HEADERS_IMMUTABLE;
    return false;
  }
  c.committedHeadersState = COMMITTED_HEADERS_MUTABLE;
  c.flags |= FLAG_COMMITTED_HEADERS_APPLIED;
  return true;
};

export const trySetCommittedHeader = (
  c: CommittedHeaderContext,
  name: string,
  value: string,
): boolean => apply(c, SET, name, value);

export const tryAppendCommittedHeader = (
  c: CommittedHeaderContext,
  name: string,
  value: string,
): boolean => apply(c, APPEND, name, value);

export const tryDeleteCommittedHeader = (c: CommittedHeaderContext, name: string): boolean =>
  apply(c, DELETE, name);

/** Any staged operation makes all mirrored direct writes rebuild inputs. */
export const markCommittedHeadersStaged = (c: { flags: number }): void => {
  c.flags &= ~FLAG_COMMITTED_HEADERS_APPLIED;
};
