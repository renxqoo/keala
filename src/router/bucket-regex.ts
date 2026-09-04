/**
 * Bucket-regex fast layer (R413) — the multi-route generalization of the
 * single-pattern fastMatch. A first-segment bucket whose dynamic patterns
 * would disable the fast matcher (several routes sharing the radix, or a
 * static tail after a param like `/map/:x/events`) gets ALL its eligible
 * patterns compiled into ONE anchored alternation regex; matching is a
 * single exec plus named-group harvest — no splitSegments array, no DFS
 * frames, no ParamLink churn.
 *
 * Eligibility is deliberately narrower than the trie's full language:
 * first segment static; every segment a plain literal or a REQUIRED,
 * unconstrained param (`:name` — no `?`, no `:id(\d+)`); no wildcards.
 * Everything else (escaped paths, optionals, constraints, wildcards,
 * mid-pattern subtleties) keeps flowing through the trie, which remains
 * the semantic reference — see the differential test that pins fast-layer
 * results to matchPattern's for the eligible set.
 */

import type { CompiledSegment } from "./pattern.ts";
import type { RouteTarget } from "./trie.ts";

/** One eligible pattern's compiled footprint inside the bucket regex. */
interface RegexRoute {
  target: RouteTarget;
  /** Param names in path order; group i lives at groupStart + i. */
  names: readonly string[];
  /** 1-based capture index of this route's first param group. */
  groupStart: number;
}

/** All eligible patterns sharing one segment count, as one alternation. */
interface CountGroup {
  regex: RegExp;
  routes: readonly RegexRoute[];
}

/**
 * A compiled bucket, sliced by SEGMENT COUNT: counting slashes picks the
 * group before any regex runs (a miss for a count with no patterns never
 * executes a regex at all), and each group's alternation stays tiny — a
 * 3-pattern bucket becomes a 1-alt regex for 2-segment paths and a 2-alt
 * regex for 3-segment ones instead of one 3-way alternation paid by every
 * path.
 */
export interface RegexBucket {
  byCount: ReadonlyMap<number, CountGroup>;
}

/** The regexIndex entry maintained by bindDef for every eligible def. */
export interface EligiblePattern {
  segments: readonly CompiledSegment[];
  target: RouteTarget;
}

/** Static literals that carry regex metacharacters must be escaped. */
const escapeLiteral = (value: string): string => value.replace(/[$()*+.?[\\\]^{|}]/g, "\\$&");

/** True when the pattern fits the fast layer (see file header). */
export const isRegexEligible = (segments: readonly CompiledSegment[]): boolean => {
  const first = segments[0];
  if (first === undefined || first.kind !== "static") return false;
  let params = 0;
  for (let i = 1; i < segments.length; i++) {
    const segment = segments[i] as CompiledSegment;
    if (segment.kind === "static") continue;
    // Plain params only: wildcards (matched the field check by accident —
    // optional:false, pattern:null — and compiled into a single-segment
    // capture) and constrained/optional params stay on the trie.
    if (segment.kind !== "param" || segment.optional || segment.pattern !== null) return false;
    params++;
  }
  // At least one param: a param-less pattern is answered by the staticMap,
  // and a zero-capture alternative would also break the route scan (its
  // groupStart points into the NEXT route's groups).
  return params > 0;
};

/**
 * Trie DFS order, encoded as a sort: at the first differing position a
 * static segment outranks a param (the walk tries static children first).
 * Co-ranked patterns never co-match except through a static/param
 * divergence (params cannot span "/"), so a PERF secondary key is safe:
 * more static literals first — a trailing literal fails fast where a bare
 * param alternative would backtrack into `[^/]+` before the anchor rejects
 * it. Array#sort is stable, keeping registration order as the final tie.
 */
const staticCountOf = (segments: readonly CompiledSegment[]): number => {
  let n = 0;
  for (const segment of segments) if (segment.kind === "static") n++;
  return n;
};

const triePrecedence = (a: readonly CompiledSegment[], b: readonly CompiledSegment[]): number => {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    const sa = a[i] as CompiledSegment;
    const sb = b[i] as CompiledSegment;
    if (sa.kind !== sb.kind) return sa.kind === "static" ? -1 : 1;
  }
  const statics = staticCountOf(b) - staticCountOf(a);
  if (statics !== 0) return statics;
  return b.length - a.length;
};

/** Compile one bucket's eligible patterns into a RegexBucket. */
export const compileRegexBucket = (
  patterns: ReadonlyMap<string, EligiblePattern>,
  bucketFirst: string,
): RegexBucket | null => {
  const byCount = new Map<
    number,
    { segments: readonly CompiledSegment[]; target: RouteTarget }[]
  >();
  let any = false;
  for (const entry of patterns.values()) {
    const first = entry.segments[0] as CompiledSegment;
    if ((first.value as string) !== bucketFirst) continue;
    // Defense in depth: only patterns with ≥1 capture join the alternation
    // (isRegexEligible guarantees it; a zero-capture alternative would
    // collide with another route's group numbering).
    if (!entry.segments.some((segment) => segment.kind !== "static")) continue;
    any = true;
    const list = byCount.get(entry.segments.length) ?? [];
    byCount.set(entry.segments.length, list);
    list.push({ segments: entry.segments, target: entry.target });
  }
  if (!any) return null;

  const groups = new Map<number, CountGroup>();
  for (const [count, collected] of byCount) {
    collected.sort((x, y) => triePrecedence(x.segments, y.segments));
    const sources: string[] = [];
    const routes: RegexRoute[] = [];
    let groupCount = 0;
    for (const { segments, target } of collected) {
      let source = `/${escapeLiteral((segments[0] as CompiledSegment).value as string)}`;
      const names: string[] = [];
      for (let i = 1; i < segments.length; i++) {
        const segment = segments[i] as CompiledSegment;
        if (segment.kind === "static") {
          source += `/${escapeLiteral(segment.value)}`;
          continue;
        }
        source += "/([^/]+)";
        names.push(segment.value);
      }
      sources.push(source);
      routes.push({ target, names, groupStart: groupCount + 1 });
      groupCount += names.length;
    }
    groups.set(count, { regex: new RegExp(`^(?:${sources.join("|")})$`), routes });
  }
  return { byCount: groups };
};

/**
 * Match a %-free path against a compiled bucket: slash-count dispatch picks
 * the group, one small regex exec runs, and the defined-capture scan finds
 * the route. Captures stay verbatim — the no-% gate makes decodeSegment an
 * identity by construction.
 */
export const matchBucketRegex = (
  bucket: RegexBucket,
  path: string,
): { target: RouteTarget; params: Record<string, string> } | null => {
  let slashes = 0;
  for (let at = path.indexOf("/"); at !== -1; at = path.indexOf("/", at + 1)) slashes++;
  const group = bucket.byCount.get(slashes);
  if (group === undefined) return null;
  const captured = group.regex.exec(path);
  if (captured === null) return null;
  const routes = group.routes;
  for (let i = 0; i < routes.length; i++) {
    const route = routes[i] as RegexRoute;
    if (captured[route.groupStart] !== undefined) {
      const params: Record<string, string> = Object.create(null);
      const names = route.names;
      for (let n = 0; n < names.length; n++) {
        params[names[n] as string] = captured[route.groupStart + n] as string;
      }
      return { target: route.target, params };
    }
  }
  return null; // unreachable: a matched alternative always sets its groups
};
