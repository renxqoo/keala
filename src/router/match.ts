/**
 * The request-side matcher (R413 layout): staticMap → whole-router fast
 * matcher → per-bucket fast matcher → per-bucket compiled regex → trie.
 * Extracted from router.ts for the file-size budget; router.ts re-exports
 * `matchRoute` as the public face.
 */

import { decodeSegment } from "./pattern.ts";
import { matchPattern } from "./trie.ts";
import type { RouteTarget } from "./trie.ts";
import { compileRegexBucket, matchBucketRegex, type RegexBucket } from "./bucket-regex.ts";
import type { Bucket, RouteMatch, RouterState } from "./router.ts";

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
    const params: Record<string, string> = Object.create(null);
    // matchRoute only enters a fast matcher after proving the whole path has
    // no "%". The trie owns escaped-path decoding; scanning this capture a
    // second time would be redundant fixed work on every plain param route.
    params[names[0] as string] = value;
    return { target: fast.target, params };
  }
  if (rest.length <= 1) return null;
  const parts = rest.slice(1).split("/");
  if (parts.length !== names.length) return null;
  const params: Record<string, string> = Object.create(null);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] as string;
    if (part.length === 0) return null;
    params[names[i] as string] = part;
  }
  return { target: fast.target, params };
};

/** Compiled bucket regex, memoized ON the bucket against the mutation epoch. */
const bucketRegexOf = (state: RouterState, bucket: Bucket): RegexBucket | null => {
  const cached = bucket.regex;
  if (cached !== undefined && cached.mutations === state.mutations) return cached.compiled;
  const compiled = compileRegexBucket(state.regexIndex, bucket.first);
  bucket.regex = { mutations: state.mutations, compiled };
  return compiled;
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

  // The fast matcher's prefix and the bucket regex's literals/captures all
  // compare in the raw key space — escaped paths go straight to the trie
  // (whose static children do the decoded comparison canonically).
  if (!escaped) {
    if (state.fastDynamic !== null) {
      const matched = fastMatch(state.fastDynamic, path);
      if (matched !== null) return matched;
    }

    // Bucket by first segment.
    const firstEnd = path.indexOf("/", 1);
    const first = firstEnd === -1 ? path.slice(1) : path.slice(1, firstEnd);
    if (first.length > 0) {
      const bucket = state.buckets.get(first);
      if (bucket !== undefined) {
        const fast = fastMatch(bucket.fast, path);
        if (fast !== null) return fast;
        // fast === null ⇔ the bucket holds either several dynamic patterns or
        // a single non-simple one — exactly when the compiled bucket regex
        // adds coverage beyond fastMatch.
        if (bucket.fast === null) {
          const compiled = bucketRegexOf(state, bucket);
          if (compiled !== null) {
            const matched = matchBucketRegex(compiled, path);
            if (matched !== null) return matched;
          }
        }
      }
    }
  }
  return matchPattern(state.trieRoot, path);
};
