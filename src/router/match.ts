/**
 * The request-side matcher (R413 layout, 0.7.4 whole-table): staticMap →
 * slice fast-matchers → ONE whole-table compiled regex → trie. Extracted
 * from router.ts for the file-size budget; router.ts re-exports
 * `matchRoute` as the public face.
 */

import { decodeSegment } from "./pattern.ts";
import { matchPattern } from "./trie.ts";
import type { RouteTarget } from "./trie.ts";
import { compileTableRegex, matchTableRegex, type TableRegex } from "./bucket-regex.ts";
import type { RouteMatch, RouterState } from "./router.ts";

/** A fast matcher for a bucket with exactly one simple-shape pattern. */
export interface FastMatcher {
  /** The pattern's full static head ("/v1/users") skipped before captures. */
  prefix: string;
  names: readonly string[];
  target: RouteTarget;
}

/**
 * Canonical static-route key (exported for router.ts's static indexing): decode each RAW segment independently (an
 * escaped `%2F` never becomes a separator — the trie contract), then
 * re-escape "%" and "/" inside the decoded value. The re-escaping keeps the
 * key injective, so two paths land on the same key EXACTLY when their
 * decoded segments are equal — i.e. precisely when the trie's per-segment
 * static walk would reach the same node.
 */
export const canonicalKey = (path: string): string =>
  path
    .split("/")
    .map((segment) => decodeSegment(segment).replace(/%/g, "%25").replace(/\//g, "%2F"))
    .join("/");
/** Try the fast matcher for a bucket; provably equivalent to the trie walk. */
const fastMatch = (fast: FastMatcher | null, path: string): RouteMatch | null => {
  if (fast === null) return null;
  const prefix = fast.prefix;
  // The static head must match exactly AND on a segment boundary — otherwise
  // fall through to the trie (which resolves the rest of the shapes).
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  if (rest.charCodeAt(0) !== 47 /* "/" */) return null;
  const names = fast.names;
  // Single-param specialization: exactly one capture means the remainder is
  // one non-empty, slash-free segment — no split allocation needed.
  if (names.length === 1) {
    if (rest.length <= 1) return null;
    const value = rest.slice(1);
    if (value.indexOf("/") !== -1) return null;
    // matchRoute only enters a fast matcher after proving the whole path has
    // no "%". The trie owns escaped-path decoding; scanning this capture a
    // second time would be redundant fixed work on every plain param route.
    return { target: fast.target, names, values: [value], offset: 0 };
  }
  if (rest.length <= 1) return null;
  const parts = rest.slice(1).split("/");
  if (parts.length !== names.length) return null;
  for (let i = 0; i < parts.length; i++) {
    if ((parts[i] as string).length === 0) return null;
  }
  // The split array IS the values array — zero per-request construction.
  return { target: fast.target, names, values: parts, offset: 0 };
};

/**
 * The whole-router fast index, memoized against the mutation epoch: the
 * per-bucket slice fast-matchers (a bucket keeps one exactly while it holds
 * a single simple-shape dynamic) plus the ONE compiled table regex covering
 * every eligible pattern. A late registration bumps the epoch and the next
 * touch rebuilds from regexIndex/buckets.
 *
 * The matcher list is CAPPED: beyond a handful of simple buckets a flat
 * startsWith scan costs more than the single table-regex exec that already
 * covers those patterns, so wide tables skip the slice path entirely.
 */
const FAST_MATCHER_CAP = 8;
const fastIndexOf = (state: RouterState): { matchers: FastMatcher[]; table: TableRegex | null } => {
  const cached = state.fastIndex;
  if (cached !== undefined && cached.mutations === state.mutations) return cached;
  const matchers: FastMatcher[] = [];
  if (state.buckets.size <= FAST_MATCHER_CAP) {
    for (const bucket of state.buckets.values()) {
      if (bucket.fast !== null) matchers.push(bucket.fast);
    }
  }
  const table = compileTableRegex(state.regexIndex, state.buckets);
  const fast = { mutations: state.mutations, matchers, table };
  state.fastIndex = fast;
  return fast;
};

export const matchRoute = (state: RouterState, path: string): RouteMatch | null => {
  // Static candidates mirror the trie exactly: raw, trailing-slash-stripped,
  // then the decoded variants of both (%2F stays one segment per decode).
  let target = state.staticMap.get(path);
  const stripped = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  if (target === undefined && stripped !== path) {
    target = state.staticMap.get(stripped);
  }
  const escaped = target === undefined && path.indexOf("%") !== -1;
  if (escaped) {
    const decoded = canonicalKey(path);
    target = state.staticMap.get(decoded);
    if (target === undefined && stripped !== path) {
      target = state.staticMap.get(canonicalKey(stripped));
    }
  }
  if (target !== undefined) return target.staticMatch as RouteMatch;
  if (!state.hasDynamic) return null;

  // The fast-matchers' prefixes and the table regex's literals/captures all
  // compare in the raw key space — escaped paths go straight to the trie
  // (whose static children do the decoded comparison canonically).
  if (!escaped) {
    const fast = fastIndexOf(state);
    const matchers = fast.matchers;
    for (let i = 0; i < matchers.length; i++) {
      const matched = fastMatch(matchers[i] as FastMatcher, path);
      if (matched !== null) return matched;
    }
    if (fast.table !== null) {
      const matched = matchTableRegex(fast.table, path);
      if (matched !== null) return matched;
    }
  }
  return matchPattern(state.trieRoot, path);
};
