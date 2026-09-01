/**
 * Conditional-request primitives — the RFC 9110 freshness judgment and the
 * stat-based weak ETag format shared by serveStatic and the etag middleware
 * (and, since DOGFOOD-R1 C2, by any consumer building file-backed tiers —
 * previously these semantics lived inline and ecosystems re-implemented
 * them, drifting on details like the If-Modified-Since 1s tolerance).
 */

/**
 * Weak validator for stat-backed representations: `W/"<size-hex>-<mtime-hex>"`.
 * Weak because mtime granularity makes byte-identical rebuilds indistinguishable.
 */
export const weakEtag = (size: number, mtimeMs: number): string =>
  `W/"${size.toString(16)}-${mtimeMs.toString(16)}"`;

/**
 * RFC 9110 §13.1.2/§13.1.3: does a candidate ETag appear in an If-None-Match
 * list? `*` matches any representation; the `W/` prefix is ignored on BOTH
 * sides (weak comparison — a 304 may collapse validator-strength differences).
 */
export const etagMatches = (etag: string, header: string): boolean => {
  const bare = etag.startsWith("W/") ? etag.slice(2) : etag;
  for (const candidate of header.split(",")) {
    let value = candidate.trim();
    if (value === "*") return true;
    if (value.startsWith("W/")) value = value.slice(2);
    if (value === bare) return true;
  }
  return false;
};

export interface FreshnessInput {
  /** The current representation's ETag (weak or strong). */
  etag: string;
  /** Current modification time, ms since the epoch. */
  mtimeMs: number;
  /** Raw `If-None-Match` header value; "" when absent. */
  ifNoneMatch: string;
  /** Raw `If-Modified-Since` header value; "" when absent. */
  ifModifiedSince: string;
}

/**
 * The freshness judge: is the client's cached representation still current?
 *
 * Precedence per RFC 9110 §13.2.2: `If-None-Match` decides whenever present
 * (a mismatch falls through to a full 200 — never an empty one);
 * `If-Modified-Since` is consulted only without it, with a 999ms tolerance
 * because HTTP dates carry 1-second granularity (an unchanged file restatted
 * within the same second must not re-send). An unparseable date is simply
 * stale (NaN comparisons are false).
 */
export const isNotModified = (input: FreshnessInput): boolean => {
  if (input.ifNoneMatch.length > 0) {
    return etagMatches(input.etag, input.ifNoneMatch);
  }
  if (input.ifModifiedSince.length > 0) {
    return Date.parse(input.ifModifiedSince) >= input.mtimeMs - 999;
  }
  return false;
};
