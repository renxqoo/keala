/**
 * Table-regex fast layer (R413 per-bucket; 0.7.4 whole-table) — the
 * multi-route generalization of the single-pattern fastMatch. Every
 * eligible dynamic pattern in the router compiles into ONE anchored
 * alternation regex; matching is a single exec plus named-group harvest
 * — no splitSegments array, no DFS frames, no ParamLink churn, and (the
 * 0.7.4 change) no first-segment slice, no buckets Map lookup, no
 * slash-count dispatch: staticMap → fastMatchers → THIS regex → trie.
 *
 * Alternation order encodes trie priority POSITIONALLY: every pattern
 * (exact and trailing-wildcard alike) sits in ONE triePrecedence-sorted
 * list. The trie tries the wildcard EDGE at a node after that node's
 * static/param edges — a wildcard deeper via a static descent therefore
 * outranks a param alternative at a shallower node, which a global
 * "exacts before wildcards" split cannot express. Leftmost-first
 * alternation semantics reproduce the trie's DFS choice because
 * `[^/]+` captures cannot span "/" — two alternatives can only co-match
 * across a rank divergence, which triePrecedence already orders; the
 * same-node rule (an exact terminal returns before that node's wildcard
 * empty-capture edge) is the tie-break for `X` vs `X/*`.
 *
 * Purity: patterns whose first segment is static share a bucket with
 * every other dynamic pattern spelling the same first segment — the
 * only shapes that can co-match. A bucket holding ANY ineligible
 * dynamic sibling (optional/constrained param, or a pattern the raw-
 * string comparison cannot represent — see fastComparable) must keep
 * its WHOLE vocabulary on the trie: the ineligible sibling can be the
 * trie's preferred answer (static-over-param rank, first-registered
 * variant), and the regex would otherwise answer with the next-best
 * eligible pattern — the wrong route. Multi-method duplicates of one
 * eligible path share one regexIndex entry and are pure (same pattern,
 * same preference).
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
  /** True when the final segment is the trailing wildcard — its capture
   *  needs the trailing-slash normalization in matchTableRegex. */
  wildLast: boolean;
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
 *
 * Same-node rule: `X` and `X/*` (identical ranks on every shared
 * position, the longer one's only extra being the trailing wildcard) can
 * co-match ONLY through the wildcard's empty capture on a trailing-slash
 * path — where the trie returns the exact terminal at that node BEFORE
 * the node's wildcard edge. The exact pattern must therefore precede its
 * own wildcard extension.
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
  // X before X/*: the exact terminal at a node returns before that node's
  // wildcard empty-capture edge (see the header's same-node rule).
  if (a.length !== b.length) {
    const longer = a.length > b.length ? a : b;
    if (
      longer.length === Math.min(a.length, b.length) + 1 &&
      (longer[longer.length - 1] as CompiledSegment).kind === "wildcard"
    ) {
      return a.length < b.length ? -1 : 1;
    }
  }
  const statics = staticCountOf(b) - staticCountOf(a);
  if (statics !== 0) return statics;
  return b.length - a.length;
};

/**
 * Compile the WHOLE router's eligible patterns into one TableRegex.
 * `impureFirst` carries the first segments of every bucket that holds an
 * ineligible dynamic pattern (maintained by bindDef): such buckets keep
 * their whole vocabulary on the trie — an ineligible sibling can be the
 * trie's preferred answer on a co-matching path, and the regex would
 * otherwise answer with the next-best eligible pattern (see the header's
 * purity rule). Buckets NOT in the set are pure: every dynamic pattern
 * under that first segment is in the alternation, so the trie's preferred
 * answer for any co-matching path is too.
 */
export const compileTableRegex = (
  patterns: ReadonlyMap<string, EligiblePattern>,
  /** First segments of impure buckets — their patterns stay on the trie. */
  impureFirst: ReadonlySet<string>,
): TableRegex | null => {
  const collected: { segments: readonly CompiledSegment[]; target: RouteTarget }[] = [];
  for (const entry of patterns.values()) {
    // Defense in depth: only patterns with ≥1 capture join the alternation
    // (isRegexEligible guarantees it; a zero-capture alternative would
    // collide with another route's group numbering).
    if (!entry.segments.some((segment) => segment.kind !== "static")) continue;
    const first = (entry.segments[0] as CompiledSegment).value as string;
    if (impureFirst.has(first)) continue;
    collected.push({ segments: entry.segments, target: entry.target });
  }
  if (collected.length === 0) return null;

  // ONE positionally-sorted list — see the header's ordering contract.
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
    const wildLast = (segments[segments.length - 1] as CompiledSegment).kind === "wildcard";
    if (!wildLast) {
      // Trie semantics: ONE trailing "/" is stripped before segmenting, so
      // an exact alternative answers its path with or without it. A second
      // trailing "/" never reaches this regex (matchTableRegex's guard).
      source += "/?";
    }
    sources.push(source);
    // Frozen at registration (see the fast matcher's names): the exec
    // array is handed out zero-copy, but the name array a handler sees via
    // `c.paramNames` must reject in-place writes (U2 adversarial review).
    routes.push({ target, names: Object.freeze(names), groupStart: groupCount + 1, wildLast });
    groupCount += names.length;
  }
  return { regex: new RegExp(`^(?:${sources.join("|")})$`), routes };
};

/**
 * Match a %-free path against the compiled table: ONE anchored exec, then
 * the defined-capture scan resolves the winning route. The scan visits
 * routes in emission order (trie precedence, positionally), so priority
 * falls out of which alternative set its groups — never out of the
 * engine's internal preference. Captures stay verbatim — the no-% gate
 * makes decodeSegment an identity by construction.
 *
 * Trailing-slash semantics mirror the trie exactly: exact alternatives
 * carry an optional trailing "/" (the trie segments the once-stripped
 * path), and a trailing-wildcard capture never includes a single final
 * "/" (the trie joins the STRIPPED segments) — normalized below. Paths
 * with TWO OR MORE trailing slashes carry an empty trailing segment the
 * regex cannot represent; they fall back to the trie, whose mid-path
 * wildcard entry owns the empty-rest rule (locked: "/w//" matches with
 * NO wildcard param).
 */
export const matchTableRegex = (
  table: TableRegex,
  path: string,
): {
  target: RouteTarget;
  names: ReadonlyArray<string>;
  values: ReadonlyArray<string>;
  offset: number;
} | null => {
  const length = path.length;
  const last = length > 0 ? path.charCodeAt(length - 1) : 0;
  if (last === 47 /* "/" */ && length > 1 && path.charCodeAt(length - 2) === 47) {
    // "//"-terminated: the once-stripped path still ends with "/" — its
    // final segment is EMPTY, which no `[^/]+`/`(.*)` capture can express
    // the trie's way. The trie is the semantic reference for these.
    return null;
  }
  const result = table.regex.exec(path);
  if (result === null) return null;
  const routes = table.routes;
  for (let i = 0; i < routes.length; i++) {
    const route = routes[i] as RegexRoute;
    if (result[route.groupStart] !== undefined) {
      if (route.wildLast && last === 47 && length > 1) {
        // A single trailing "/" is not part of the capture: the trie
        // segments the once-stripped path, so the wildcard's rest never
        // retains it ("/a/1/" → "1", not "1/"). The empty capture of the
        // trailing-slash gate ("/w/" → "") is preserved verbatim.
        const index = route.groupStart + route.names.length - 1;
        const capture = result[index] as string;
        if (capture.length > 1 && capture.endsWith("/")) {
          result[index] = capture.slice(0, -1);
        }
      }
      // Zero-copy: the exec array IS the values store; `offset` carries the
      // per-route group start (slicing a RegExp result array walks the
      // generic path — measured ~15ns/call, the single biggest U2 regression).
      return { target: route.target, names: route.names, values: result, offset: route.groupStart };
    }
  }
  return null; // unreachable: a matched alternative always sets its groups
};
