/**
 * Table-regex fast layer (R413 per-bucket; 0.7.4 whole-table) — the
 * multi-route generalization of the single-pattern fastMatch. Every
 * eligible dynamic pattern in the router compiles into ONE anchored
 * alternation regex; matching is a single exec plus named-group harvest
 * — no splitSegments array, no DFS frames, no ParamLink churn, and (the
 * 0.7.4 change) no first-segment slice, no buckets Map lookup, no
 * slash-count dispatch: staticMap → fastMatchers → THIS regex → trie.
 *
 * Alternation order encodes trie priority exactly: exact patterns sorted
 * by triePrecedence first, trailing wildcards last (the trie tries
 * wildcards after every static/param alternative). Leftmost-first
 * alternation semantics reproduce the trie's DFS choice because
 * `[^/]+` captures cannot span "/" — two alternatives can only co-match
 * across a rank divergence, which triePrecedence already orders.
 *
 * Eligibility is deliberately narrower than the trie's full language:
 * first segment static; every segment a plain literal or a REQUIRED,
 * unconstrained param (`:name` — no `?`, no `:id(\d+)`); wildcards only
 * as the final segment. Everything else (escaped paths, optionals,
 * constraints, mid-pattern subtleties) keeps flowing through the trie,
 * which remains the semantic reference — see the differential tests
 * that pin fast-layer results to matchPattern's for the eligible set.
 */

import type { CompiledSegment } from "./pattern.ts";
import type { RouteTarget } from "./trie.ts";

/** One eligible pattern's compiled footprint inside the table regex. */
interface RegexRoute {
  target: RouteTarget;
  /** Param names in path order; group i lives at groupStart + i. */
  names: readonly string[];
  /** 1-based capture index of this route's first param group. */
  groupStart: number;
}

/** The whole router's eligible patterns as one anchored alternation. */
export interface TableRegex {
  regex: RegExp;
  routes: readonly RegexRoute[];
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
 * Compile the WHOLE router's eligible patterns into one TableRegex.
 * `dynamicCountsByFirst` carries each first segment's TOTAL dynamic-pattern
 * count (buckets' bookkeeping): a trailing-wildcard pattern joins the
 * alternation only when every dynamic pattern sharing its first segment is
 * eligible — otherwise the wildcard (which the trie tries LAST) could
 * shadow an uncompiled optional/constrained sibling on a co-matching path.
 * Multi-method duplicates of one path share a regexIndex entry, so such
 * buckets read as impure — conservative, never wrong.
 */
export const compileTableRegex = (
  patterns: ReadonlyMap<string, EligiblePattern>,
  /** Buckets' dynamic-pattern counts, keyed by first segment (purity rule). */
  dynamicCountsByFirst: ReadonlyMap<string, { count: number }>,
): TableRegex | null => {
  const exact: { segments: readonly CompiledSegment[]; target: RouteTarget }[] = [];
  const wilds: { segments: readonly CompiledSegment[]; target: RouteTarget }[] = [];
  /** Eligible patterns per first segment (for the wildcard purity rule). */
  const eligibleByFirst = new Map<string, number>();
  for (const entry of patterns.values()) {
    // Defense in depth: only patterns with ≥1 capture join the alternation
    // (isRegexEligible guarantees it; a zero-capture alternative would
    // collide with another route's group numbering).
    if (!entry.segments.some((segment) => segment.kind !== "static")) continue;
    const first = (entry.segments[0] as CompiledSegment).value as string;
    eligibleByFirst.set(first, (eligibleByFirst.get(first) ?? 0) + 1);
    if ((entry.segments[entry.segments.length - 1] as CompiledSegment).kind === "wildcard") {
      wilds.push({ segments: entry.segments, target: entry.target });
    } else {
      exact.push({ segments: entry.segments, target: entry.target });
    }
  }
  if (exact.length === 0 && wilds.length === 0) return null;

  // Trie DFS order for the exact patterns; wildcards always trail (the
  // trie tries them after every static/param alternative).
  exact.sort((x, y) => triePrecedence(x.segments, y.segments));
  wilds.sort((x, y) => triePrecedence(x.segments, y.segments));
  const keptWilds = wilds.filter(({ segments }) => {
    const first = (segments[0] as CompiledSegment).value as string;
    return eligibleByFirst.get(first) === dynamicCountsByFirst.get(first)?.count;
  });

  const sources: string[] = [];
  const routes: RegexRoute[] = [];
  let groupCount = 0;
  const emit = (collected: { segments: readonly CompiledSegment[]; target: RouteTarget }[]) => {
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
  };
  emit(exact);
  emit(keptWilds);
  return { regex: new RegExp(`^(?:${sources.join("|")})$`), routes };
};

/**
 * Match a %-free path against the compiled table: ONE anchored exec, then
 * the defined-capture scan resolves the winning route. The scan visits
 * routes in emission order (exact by trie precedence, wildcards last), so
 * priority falls out of which alternative set its groups — never out of
 * the engine's internal preference. Captures stay verbatim — the no-%
 * gate makes decodeSegment an identity by construction.
 */
export const matchTableRegex = (
  table: TableRegex,
  path: string,
): { target: RouteTarget; params: Record<string, string> } | null => {
  // Trie semantics: ONE trailing "/" is stripped before segmenting — the
  // empty-capture case ("/static/" → wildcard:"") misses here on purpose
  // and falls back to the trie, whose trailing-slash gate owns it.
  const target =
    path.length > 1 && path.charCodeAt(path.length - 1) === 47 /* "/" */ ? path.slice(0, -1) : path;
  const result = table.regex.exec(target);
  if (result === null) return null;
  const routes = table.routes;
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
