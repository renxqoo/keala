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
 *
 * Trailing-wildcard patterns (`/static/*`) live in a separate FALLBACK
 * group: they match any suffix length, so they cannot key by count, and
 * the trie only tries them after every static/param alternative — the
 * fallback runs only when the count group misses.
 */
export interface RegexBucket {
  byCount: ReadonlyMap<number, CountGroup>;
  wildcard: CountGroup | null;
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
  let captures = 0;
  for (let i = 1; i < segments.length; i++) {
    const segment = segments[i] as CompiledSegment;
    if (segment.kind === "static") continue;
    // A wildcard qualifies ONLY as the final segment (the trie enforces the
    // same at registration); it compiles to the bucket's FALLBACK group,
    // tried after every exact-count alternative — the trie's "wildcards
    // are the lowest-priority match" order.
    if (segment.kind === "wildcard") {
      if (i !== segments.length - 1) return false;
      captures++;
      continue;
    }
    // Plain params only: constrained/optional params stay on the trie.
    if (segment.optional || segment.pattern !== null) return false;
    captures++;
  }
  // At least one capture: a capture-less pattern is answered by the
  // staticMap, and a zero-capture alternative would also break the route
  // scan (its groupStart points into the NEXT route's groups).
  return captures > 0;
};

/** Trie DFS pop order: static children first, then params, wildcard last. */
const RANK: Readonly<Record<string, number>> = { static: 0, param: 1, wildcard: 2 };

/**
 * Trie DFS order, encoded as a sort over the RANK map. Co-ranked patterns
 * never co-match except through a rank divergence (params cannot span
 * "/"), so a PERF secondary key is safe: more static literals first — a
 * trailing literal fails fast where a bare param alternative would
 * backtrack into `[^/]+` before the anchor rejects it. Array#sort is
 * stable, keeping registration order as the final tie.
 */
const staticCountOf = (segments: readonly CompiledSegment[]): number => {
  let n = 0;
  for (const segment of segments) if (segment.kind === "static") n++;
  return n;
};

const triePrecedence = (a: readonly CompiledSegment[], b: readonly CompiledSegment[]): number => {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    const ra = RANK[(a[i] as CompiledSegment).kind] as number;
    const rb = RANK[(b[i] as CompiledSegment).kind] as number;
    if (ra !== rb) return ra - rb;
  }
  const statics = staticCountOf(b) - staticCountOf(a);
  if (statics !== 0) return statics;
  return b.length - a.length;
};

/**
 * Compile one bucket's eligible patterns into a RegexBucket.
 * `bucketCount` is the bucket's TOTAL dynamic-pattern count: the wildcard
 * FALLBACK is only sound in a PURE bucket (every dynamic pattern compiled
 * here) — otherwise a count-group miss might still be a trie hit for an
 * uncompiled optional/constrained pattern, and the fallback would shadow
 * it (the trie tries wildcards LAST).
 */
export const compileRegexBucket = (
  patterns: ReadonlyMap<string, EligiblePattern>,
  bucketFirst: string,
  bucketCount: number,
): RegexBucket | null => {
  const byCount = new Map<
    number,
    { segments: readonly CompiledSegment[]; target: RouteTarget }[]
  >();
  const wilds: { segments: readonly CompiledSegment[]; target: RouteTarget }[] = [];
  let any = false;
  for (const entry of patterns.values()) {
    const first = entry.segments[0] as CompiledSegment;
    if ((first.value as string) !== bucketFirst) continue;
    // Defense in depth: only patterns with ≥1 capture join the alternation
    // (isRegexEligible guarantees it; a zero-capture alternative would
    // collide with another route's group numbering).
    if (!entry.segments.some((segment) => segment.kind !== "static")) continue;
    any = true;
    if ((entry.segments[entry.segments.length - 1] as CompiledSegment).kind === "wildcard") {
      wilds.push({ segments: entry.segments, target: entry.target });
      continue;
    }
    const list = byCount.get(entry.segments.length) ?? [];
    byCount.set(entry.segments.length, list);
    list.push({ segments: entry.segments, target: entry.target });
  }
  if (!any) return null;

  const compileGroup = (
    collected: { segments: readonly CompiledSegment[]; target: RouteTarget }[],
  ): CountGroup => {
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
        // The trailing wildcard captures the raw suffix (multi-segment);
        // a plain param captures one segment.
        source += segment.kind === "wildcard" ? "/(.*)" : "/([^/]+)";
        names.push(segment.value);
      }
      sources.push(source);
      routes.push({ target, names, groupStart: groupCount + 1 });
      groupCount += names.length;
    }
    return { regex: new RegExp(`^(?:${sources.join("|")})$`), routes };
  };

  const groups = new Map<number, CountGroup>();
  for (const [count, collected] of byCount) groups.set(count, compileGroup(collected));
  let eligible = wilds.length;
  for (const list of byCount.values()) eligible += list.length;
  const pure = eligible === bucketCount;
  return {
    byCount: groups,
    wildcard: pure && wilds.length > 0 ? compileGroup(wilds) : null,
  };
};

/**
 * Match a %-free path against a compiled bucket: slash-count dispatch picks
 * the group, one small regex exec runs, and the defined-capture scan finds
 * the route; only when every exact-count alternative misses does the
 * wildcard fallback run (the trie's lowest-priority order). Captures stay
 * verbatim — the no-% gate makes decodeSegment an identity by construction.
 */
export const matchBucketRegex = (
  bucket: RegexBucket,
  path: string,
): { target: RouteTarget; params: Record<string, string> } | null => {
  // Trie semantics: ONE trailing "/" is stripped before segmenting — the
  // empty-capture case ("/static/" → wildcard:"") misses here on purpose
  // and falls back to the trie, whose trailing-slash gate owns it.
  const target =
    path.length > 1 && path.charCodeAt(path.length - 1) === 47 /* "/" */ ? path.slice(0, -1) : path;
  let slashes = 0;
  for (let at = target.indexOf("/"); at !== -1; at = target.indexOf("/", at + 1)) slashes++;
  const group = bucket.byCount.get(slashes);
  let winner: CountGroup | undefined = group;
  let result = group !== undefined ? group.regex.exec(target) : null;
  if (result === null && bucket.wildcard !== null) {
    winner = bucket.wildcard;
    result = bucket.wildcard.regex.exec(target);
  }
  if (result === null || winner === undefined) return null;
  const routes = winner.routes;
  for (let i = 0; i < routes.length; i++) {
    const route = routes[i] as RegexRoute;
    if (result[route.groupStart] !== undefined) {
      const params: Record<string, string> = Object.create(null);
      const names = route.names;
      for (let n = 0; n < names.length; n++) {
        params[names[n] as string] = result[route.groupStart + n] as string;
      }
      return { target: route.target, params };
    }
  }
  return null; // unreachable: a matched alternative always sets its groups
};
