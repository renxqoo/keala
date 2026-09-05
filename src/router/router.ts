/**
 * Hybrid router: exact static Map + per-bucket compiled fast matchers, with
 * the trie as the source of truth for every dynamic pattern.
 *
 * Matching order per request:
 *   1. staticMap — O(1) exact hit (plus the trailing-slash retry)
 *   2. slice fast-matchers — every bucket holding exactly ONE dynamic
 *      pattern of "simple shape" (static head + plain params), where the
 *      matcher is provably equivalent to the trie walk
 *   3. table regex (R413 bucket-regex, 0.7.4 whole-table) — every eligible
 *      pattern in the router compiled into ONE anchored alternation, one
 *      regex exec per request, no bucket lookup / slash-count dispatch
 *   4. trie — handles every other shape (optionals, custom patterns,
 *      wildcards, param-first routes, escaped paths); its O(segments)
 *      walk is what keeps 1000-route tables fast where regex scans collapse.
 *
 * Registration is incremental and validates eagerly (conflicting parameter
 * names throw at `register`, not at request time). Chains are recomposed via
 * `rebuildChains` whenever the app-level middleware stack changes.
 */

import type { Handler } from "../core/compose.ts";
import type { Context } from "../core/context/context.ts";
import {
  EMPTY_MIDDLEWARE_STACK,
  middlewareForRoute,
  type MiddlewareStack,
} from "../core/middleware-stack.ts";
import type { CompiledSegment, PatternIR } from "./pattern.ts";
import {
  compilePattern,
  decodeSegment,
  normalizePath,
  paramNamesOf,
  patternsOverlap,
} from "./pattern.ts";
import { canonicalKey, type FastMatcher } from "./match.ts";
import { chainOf, paramChainFor, staticHeadOf } from "./chains.ts";
import { isRegexEligible, type EligiblePattern, type TableRegex } from "./bucket-regex.ts";
import {
  createNode,
  createTarget,
  insertPattern,
  matchPattern,
  type RouteTarget,
  type TrieNode,
} from "./trie.ts";

export type RouteHandler = Handler<Context>;

/** All built-in chains share this signature (composed or direct). */
export type { Chain } from "./chains.ts";

export interface RouteDef {
  method: string; // uppercase, or "ALL"
  /** Full path including router prefix. */
  path: string;
  handlers: RouteHandler[];
  name?: string;
  /** Sub-router `use()` middleware merged by `mount()`; runs AFTER the
   *  parent's global middleware and BEFORE param middleware (the koa
   *  order: use > param > handler). */
  prefixMiddleware?: readonly RouteHandler[];
  /** Set by app.ws(): the wsRoutes key this def's upgrade handler closes
   * over (mount() re-keys ws registrations under its prefix). */
  wsKey?: string;
}

const KNOWN_METHOD_LIST = [
  "HEAD",
  "OPTIONS",
  "GET",
  "PUT",
  "PATCH",
  "POST",
  "DELETE",
  "TRACE",
  "CONNECT",
] as const;

export const KNOWN_METHODS = new Set<string>(KNOWN_METHOD_LIST);
/** koa-router's methods order — Allow headers follow this sequence. */
export const ALLOW_ORDER = KNOWN_METHOD_LIST;

const ALL = "ALL";
export const EMPTY_PARAMS: Record<string, string> = Object.freeze(Object.create(null));
/** Match-product sentinels for param-free matches (static routes). */
export const NO_PARAM_NAMES: ReadonlyArray<string> = Object.freeze([]);
export const NO_PARAM_VALUES: ReadonlyArray<string> = Object.freeze([]);

/**
 * The "I need the whole map" adapter over a match product (U2): rebuild a
 * null-proto Record from the raw arrays. Forward overwrite keeps the LATEST
 * capture of a repeated name — the same rule `c.params(name)` reads with.
 * Used by the sink mirror boundary (SunkHandler contract) and available to
 * code that enumerates params (logging, tracing).
 */
export const paramsRecord = (
  names: ReadonlyArray<string>,
  values: ReadonlyArray<string>,
  offset = 0,
): Record<string, string> => {
  const record: Record<string, string> = Object.create(null);
  for (let i = 0; i < names.length; i++) record[names[i] as string] = values[i + offset] as string;
  return record;
};

export interface Bucket {
  /** The first-segment key this bucket is indexed under. */
  first: string;
  fast: FastMatcher | null;
  /** Dynamic patterns in this bucket (always present in the trie as well);
   * feeds the table regex's wildcard purity rule. */
  count: number;
}

export interface RouterState {
  defs: RouteDef[];
  named: Map<string, RouteDef>;
  paramMiddlewares: Map<string, RouteHandler>;
  staticMap: Map<string, RouteTarget>;
  buckets: Map<string, Bucket>;
  /**
   * R413 fast layer (0.7.4 whole-table), memoized against `mutations`:
   * the slice fast-matchers plus the ONE compiled table regex. Lazy —
   * the first dynamic miss after a mutation epoch rebuilds it.
   */
  fastIndex?: { mutations: number; matchers: FastMatcher[]; table: TableRegex | null };
  trieRoot: TrieNode;
  hasDynamic: boolean;
  prefix: string;
  /**
   * R413 fast layer: eligible patterns by path (maintained by bindDef) and
   * the per-bucket compiled regexes memoized against `mutations`, which
   * every bind/reset bumps — a late registration retires the epoch and the
   * next touch of a bucket recompiles from regexIndex.
   */
  regexIndex: Map<string, EligiblePattern>;
  mutations: number;
  /** Paths sunk into the native routing table — later JS registrations
   * overlapping them throw (the native table would silently shadow them). */
  sunkPaths: Set<string>;
  /**
   * Dev-only route tracing (DOGFOOD-R1 C4): embed the reached-marker into
   * composed chains so dispatch can warn when global middleware swallows a
   * matched route. Set by the owning app from its env; false everywhere
   * else — production chains compile bit-for-bit as before.
   */
  devTrace: boolean;
}

export const createRouterState = (prefix = ""): RouterState => ({
  defs: [],
  named: new Map(),
  paramMiddlewares: new Map(),
  staticMap: new Map(),
  buckets: new Map(),
  trieRoot: createNode(),
  hasDynamic: false,
  prefix: normalizePrefix(prefix),
  regexIndex: new Map(),
  mutations: 0,
  sunkPaths: new Set(),
  devTrace: false,
});

export const normalizePrefix = (prefix: string): string => {
  if (prefix.length === 0 || prefix === "/") return "";
  return prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
};

/**
 * Index one compiled pattern. The trie insert validates conflicts eagerly;
 * bucket bookkeeping mirrors it. A bucket keeps its fast matcher only while
 * it holds exactly one simple-shape dynamic pattern.
 *
 * Returns the pattern's terminal TARGETS (one per terminal NODE, deduped):
 * patterns that share a terminal (an optional `:x?` consumes the same
 * variant node a required `:x` terminated) append layers to the SHARED
 * target — both run for the shared shape — while the optional's SKIP
 * terminal keeps its own target, so a required pattern's layer can never
 * run for a path that skips the param.
 */
const indexPattern = (state: RouterState, ir: PatternIR, fullPath: string): RouteTarget[] => {
  if (ir.isStatic) {
    // Key by the CANONICAL path — decoded per segment exactly like the
    // trie's static children, with "%" and "/" re-escaped inside decoded
    // values so the flat key can never conflate "%2F" with a real separator
    // (patterns like "/foo%20bar" and "/foo bar" still share one route).
    const key = fullPath.indexOf("%") !== -1 ? canonicalKey(fullPath) : fullPath;
    let target = state.staticMap.get(key);
    if (target === undefined) {
      target = createTarget();
      target.staticMatch = Object.freeze({
        target,
        names: NO_PARAM_NAMES,
        values: NO_PARAM_VALUES,
        offset: 0,
      });
      state.staticMap.set(key, target);
    }
    return [target];
  }
  const terminals = insertPattern(state.trieRoot, ir.segments);
  const targets: RouteTarget[] = [];
  for (const terminal of terminals) {
    const target = (terminal.target ??= createTarget());
    if (!targets.includes(target)) targets.push(target);
  }
  state.hasDynamic = true;
  const first = ir.segments[0] as CompiledSegment;
  if (first.kind !== "static") return targets;
  let bucket = state.buckets.get(first.value);
  if (bucket === undefined) {
    bucket = { first: first.value, fast: null, count: 0 };
    state.buckets.set(first.value, bucket);
  }
  bucket.count++;
  bucket.fast =
    bucket.count === 1 && ir.isSimple
      ? {
          // Full static head ("/v1/users"), not just the first segment — the
          // matcher must skip every leading static before captures begin.
          prefix: staticHeadOf(ir.segments),
          // Frozen at registration: this array is handed to every request's
          // `c.paramNames` — a handler's in-place write must throw, not
          // permanently corrupt the route (U2 adversarial review).
          names: Object.freeze(paramNamesOf(ir.segments)),
          target: targets[0] as RouteTarget,
        }
      : null;
  return targets;
};

/** Index + compose the chain for ONE definition (incremental registration). */
const bindDef = (state: RouterState, def: RouteDef, middleware: MiddlewareStack): void => {
  const ir = compilePattern(def.path);
  const targets = indexPattern(state, ir, def.path);
  // R413: remember eligible patterns for the bucket-regex fast layer. An
  // eligible pattern owns exactly one terminal target (terminal sharing only
  // happens through optional variants, which eligibility excludes).
  state.mutations++;
  if (isRegexEligible(ir.segments)) {
    state.regexIndex.set(def.path, { segments: ir.segments, target: targets[0] as RouteTarget });
  }
  const appMiddleware = middlewareForRoute(middleware, def.path);
  // Koa order along the chain: the sub-router's use() middleware (if this
  // def came through mount()) runs BEFORE param middleware, the handler last.
  const handlers = [
    ...(def.prefixMiddleware ?? []),
    ...paramChainFor(state, ir.segments),
    ...def.handlers,
  ];
  // Every terminal target of the pattern receives the layers. Duplicates of
  // the same path append (@koa/router runs every matching layer) and the
  // chain is recomposed over the full layer list — the global middleware is
  // embedded exactly once no matter how many layers accumulated.
  for (const target of targets) {
    const previous = target.layers.get(def.method) as RouteHandler[] | undefined;
    const layers = previous === undefined ? handlers : [...previous, ...handlers];
    target.layers.set(def.method, layers);
    target.methods.set(def.method, chainOf(layers, appMiddleware, state.devTrace));
    target.allowed.add(def.method);
    if (def.method === ALL) target.allowed.add("*");
    if (def.method === "GET") target.allowed.add("HEAD");
    if (def.name !== undefined) target.name = def.name;
    // The matched-pattern fact behind c.routePath (R411 Fix 4): one string
    // REFERENCE per bind — the normalized fullPath already exists.
    target.pattern = def.path;
  }
};

const resetIndex = (state: RouterState): void => {
  state.staticMap = new Map();
  state.buckets = new Map();
  state.fastIndex = undefined;
  state.trieRoot = createNode();
  state.hasDynamic = false;
  state.regexIndex = new Map();
  state.mutations++;
};

/** Full re-index + recompose (middleware stack or param middleware changed). */
export const rebuildChains = (state: RouterState, middleware: MiddlewareStack): void => {
  resetIndex(state);
  for (const def of state.defs) bindDef(state, def, middleware);
};

/**
 * Dev-only shadow audit (review BUG-5): a staticMap entry owns its whole
 * path for EVERY method — `matchRoute` returns the static target before the
 * trie is ever consulted — so when a static route and a dynamic pattern
 * cover the same path, every method the static side does not serve answers
 * 405 even though the dynamic route has a handler. koa-router's
 * registration order would have served those requests; here the static
 * table always wins. The precedence stays — the silent 200→405 flip gets a
 * development warning instead, for both registration orders. A same-method
 * overlap is ordinary static-over-dynamic precedence and stays silent.
 */
const shadowWarned = new WeakMap<RouterState, Set<string>>();

const warnShadowOnce = (state: RouterState, key: string, message: string): void => {
  let seen = shadowWarned.get(state);
  if (seen === undefined) {
    seen = new Set();
    shadowWarned.set(state, seen);
  }
  // Keyed with the missing-method list: a registration that WIDENS the gap
  // (a new method on the dynamic side) warns again; a re-run with the same
  // gap stays silent.
  if (seen.has(key)) return;
  seen.add(key);
  console.warn(message);
};

/** Methods a def serves at match time: GET answers HEAD too, ALL answers every method ("*"). */
const methodsOf = (method: string): string[] =>
  method === "ALL" ? ["*"] : method === "GET" ? [method, "HEAD"] : [method];

const shadowLabel = (missing: string[]): string =>
  missing.includes("*") ? "every other method" : missing.map((m) => `${m} requests`).join(", ");

const warnShadowGaps = (state: RouterState, def: RouteDef): void => {
  if (state.staticMap.size === 0 || !state.hasDynamic) return;
  const ir = compilePattern(def.path);
  if (ir.isStatic) {
    // Which dynamic pattern covers THIS concrete path? The trie is the
    // authority (static defs never enter it).
    const dynamic = matchPattern(state.trieRoot, def.path);
    if (dynamic === null) return;
    const key = def.path.indexOf("%") !== -1 ? canonicalKey(def.path) : def.path;
    const allowed = state.staticMap.get(key)?.allowed;
    if (allowed === undefined) return;
    const missing: string[] = [];
    const dynAllowed = dynamic.target.allowed;
    if (dynAllowed.has("*") && !allowed.has("*")) missing.push("*");
    for (const m of dynAllowed) {
      if (m === "*" || m === "ALL") continue;
      if (!allowed.has(m) && !allowed.has("*")) missing.push(m);
    }
    if (missing.length === 0) return;
    warnShadowOnce(
      state,
      `${key}|${dynamic.target.pattern}|${missing.join(",")}`,
      `keala(dev): ${def.method} ${def.path} registers a static path that dynamic ${dynamic.target.pattern} also matches — the static entry owns the path for every method, so ${shadowLabel(missing)} will answer 405 instead of reaching the dynamic handler. Register those methods on the static path too, or keep the paths distinct.`,
    );
    return;
  }
  // Dynamic def: would THIS pattern cover any existing static path? A probe
  // trie holding only the new pattern answers exactly that — the full trie
  // could match the concrete path through any sibling pattern.
  const probe = createNode();
  for (const terminal of insertPattern(probe, ir.segments)) terminal.target ??= createTarget();
  for (const target of state.staticMap.values()) {
    if (matchPattern(probe, target.pattern) === null) continue;
    const missing: string[] = [];
    for (const m of methodsOf(def.method)) {
      if (!target.allowed.has(m) && !target.allowed.has("*")) missing.push(m);
    }
    if (missing.length === 0) continue;
    warnShadowOnce(
      state,
      `${target.pattern}|${def.path}|${missing.join(",")}`,
      `keala(dev): ${def.method} ${def.path} also matches the static route ${target.pattern} — the static entry owns that path for every method, so ${shadowLabel(missing)} will answer 405 instead of reaching this handler. Register those methods on the static path too, or keep the paths distinct.`,
    );
  }
};

/** Register one definition; returns it (callers may tag it, e.g. wsKey). */
export const registerDef = (
  state: RouterState,
  method: string,
  path: string,
  handlers: RouteHandler[],
  name?: string,
  middleware: MiddlewareStack = EMPTY_MIDDLEWARE_STACK,
  prefixMiddleware?: readonly RouteHandler[],
): RouteDef => {
  const upper = method.toUpperCase();
  if (!KNOWN_METHODS.has(upper) && upper !== ALL) {
    throw new TypeError(`Unknown HTTP method: ${JSON.stringify(method)}`);
  }
  if (handlers.length === 0) {
    throw new TypeError("Route registration requires at least one handler");
  }
  for (const handler of handlers) {
    if (typeof handler !== "function") {
      throw new TypeError("Route handlers must be functions");
    }
  }
  const joined = `${state.prefix}${normalizePrefix(path)}`;
  const def: RouteDef = {
    method: upper,
    path: normalizePath(joined.length === 0 ? "/" : joined),
    handlers,
    name,
    ...(prefixMiddleware !== undefined && prefixMiddleware.length > 0
      ? { prefixMiddleware }
      : null),
  };
  if (state.sunkPaths.size > 0) {
    for (const sunk of state.sunkPaths) {
      // Pattern-aware union: a dynamic segment on either side can consume
      // what the other spells literally (sunk `/users/:id` shadows a JS
      // `/users/admin`); pathsConflict keeps the decoded-keyspace coverage.
      if (pathsConflict(def.path, sunk) || patternsOverlap(def.path, sunk)) {
        throw new TypeError(
          `route ${upper} ${def.path} overlaps natively-sunk ${sunk} — the Bun routing table would silently shadow it`,
        );
      }
    }
  }
  // Transactional registration: a throwing bind (bad pattern, eager
  // conflict) leaves NO trace — a leaked def/named entry would brick every
  // later use()/param() rebuild with the same setup error.
  const previousNamed = name !== undefined ? state.named.get(name) : undefined;
  state.defs.push(def);
  if (name !== undefined) state.named.set(name, def);
  try {
    bindDef(state, def, middleware);
  } catch (err) {
    state.defs.pop();
    if (name !== undefined && previousNamed === undefined) state.named.delete(name);
    else if (name !== undefined) state.named.set(name, previousNamed as RouteDef);
    rebuildChains(state, middleware); // discard partial index mutations wholesale
    throw err;
  }
  if (state.devTrace) warnShadowGaps(state, def);
  return def;
};

/**
 * Canonical segment list for overlap checks: decode each RAW segment, then
 * re-split its content — an escaped separator ("%2F") becomes a REAL segment
 * boundary here. That is the keyspace a native routing table may match in,
 * which is exactly the shadowing the sink guard exists to catch (a flat
 * startsWith over canonicalKey could never see "/a%2Fb" inside "/a/*" — the
 * re-escaped "%2F" hid the boundary). Double-encoded escapes ("%252F") stay
 * one segment, mirroring the trie contract.
 */
const canonicalSegments = (path: string): string[] => {
  const base = path.endsWith("/*") ? path.slice(0, -2) : path;
  const parts = base.split("/").flatMap((segment) => decodeSegment(segment).split("/"));
  parts.shift(); // the leading "" before "/"
  if (parts.length === 1 && (parts[0] ?? "") === "") parts.length = 0;
  return parts;
};

/** Shared by the middleware-scope matcher (core/middleware-stack.ts) —
 * keep the two callers on one definition. */
export const startsWithSegments = (prefix: readonly string[], full: readonly string[]): boolean =>
  prefix.length <= full.length && prefix.every((segment, i) => segment === full[i]);

/**
 * Boundary-aware path overlap: two paths conflict when they are the same
 * route (wildcard and bare prefix included — a dir sink's JS twin registers
 * the bare prefix), or when a wildcard prefix subtree of one contains the
 * other. Comparison runs segment-wise in the decoded keyspace above.
 */
export const pathsConflict = (a: string, b: string): boolean => {
  const aSegs = canonicalSegments(a);
  const bSegs = canonicalSegments(b);
  if (aSegs.length === bSegs.length && startsWithSegments(aSegs, bSegs)) return true;
  const aWild = a.endsWith("/*");
  const bWild = b.endsWith("/*");
  if (aWild && bSegs.length > aSegs.length && startsWithSegments(aSegs, bSegs)) return true;
  if (bWild && aSegs.length > bSegs.length && startsWithSegments(bSegs, aSegs)) return true;
  return false;
};

export interface RouteMatch {
  target: RouteTarget;
  /** Param names, parallel to `values` (U2: the router hands out raw arrays;
   * `c.params(name)` reads them lazily — no per-request Record construction). */
  names: ReadonlyArray<string>;
  values: ReadonlyArray<string>;
  /**
   * Index offset of `names[0]` inside `values` (U2): the table-regex layer
   * hands out the regex exec array itself — zero copies — and its per-route
   * groups start at `groupStart`. Every other layer uses 0.
   */
  offset: number;
}

// URL building for named routes lives in ./url.ts, re-exported here — the
// router module is the public face of the routing surface.
export {
  buildURL,
  redirectTargetSegments,
  assertRedirectCaptures,
  urlFor,
  routePathOf,
} from "./url.ts";
// The request-side matcher (R413: staticMap → fastDynamic → bucket fast →
// bucket regex → trie) lives in ./match.ts; re-exported here so the router
// module stays the public face of the routing surface.
export { matchRoute } from "./match.ts";
