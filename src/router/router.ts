/**
 * Hybrid router: exact static Map + per-bucket compiled fast matchers, with
 * the trie as the source of truth for every dynamic pattern.
 *
 * Matching order per request:
 *   1. staticMap — O(1) exact hit (plus the trailing-slash retry)
 *   2. bucket fast matcher — only when the bucket holds exactly ONE dynamic
 *      pattern of "simple shape" (static head + plain params), where the
 *      matcher is provably equivalent to the trie walk
 *   3. trie — handles every other shape (optionals, custom patterns,
 *      wildcards, param-first routes, multi-pattern buckets); its O(segments)
 *      walk is what keeps 1000-route tables fast where regex scans collapse.
 *
 * Registration is incremental and validates eagerly (conflicting parameter
 * names throw at `register`, not at request time). Chains are recomposed via
 * `rebuildChains` whenever the app-level middleware stack changes.
 */

import { compose, direct, type Composed, type Handler } from "../core/compose.ts";
import type { Context } from "../core/context/context.ts";
import type { CompiledSegment, PatternIR } from "./pattern.ts";
import { compilePattern, decodeSegment, paramNamesOf } from "./pattern.ts";
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
export type Chain = Composed<Context>;

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

/** A fast matcher for a bucket with exactly one simple-shape pattern. */
interface FastMatcher {
  /** The pattern's full static head ("/v1/users") skipped before captures. */
  prefix: string;
  names: readonly string[];
  target: RouteTarget;
}

interface Bucket {
  fast: FastMatcher | null;
  /** Dynamic patterns in this bucket (always present in the trie as well). */
  count: number;
}

export interface RouterState {
  defs: RouteDef[];
  named: Map<string, RouteDef>;
  paramMiddlewares: Map<string, RouteHandler>;
  staticMap: Map<string, RouteTarget>;
  buckets: Map<string, Bucket>;
  trieRoot: TrieNode;
  hasDynamic: boolean;
  prefix: string;
  /** Paths sunk into the native routing table — later JS registrations
   *  overlapping them throw (the native table would silently shadow them). */
  sunkPaths: Set<string>;
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
  sunkPaths: new Set(),
});

export const normalizePrefix = (prefix: string): string => {
  if (prefix.length === 0 || prefix === "/") return "";
  return prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
};

/**
 * Index one compiled pattern. The trie insert validates conflicts eagerly;
 * bucket bookkeeping mirrors it. A bucket keeps its fast matcher only while
 * it holds exactly one simple-shape dynamic pattern.
 */
const indexPattern = (state: RouterState, ir: PatternIR, fullPath: string): RouteTarget => {
  if (ir.isStatic) {
    // Key by the CANONICAL path — decoded per segment exactly like the
    // trie's static children, with "%" and "/" re-escaped inside decoded
    // values so the flat key can never conflate "%2F" with a real separator
    // (patterns like "/foo%20bar" and "/foo bar" still share one route).
    const key = fullPath.indexOf("%") !== -1 ? canonicalKey(fullPath) : fullPath;
    let target = state.staticMap.get(key);
    if (target === undefined) {
      target = createTarget();
      state.staticMap.set(key, target);
    }
    return target;
  }
  // A pattern with optional params has one terminal per skip/consume
  // combination — every terminal shares ONE target (duplicates of the same
  // pattern merge into the existing target exactly like before).
  const terminals = insertPattern(state.trieRoot, ir.segments);
  const target = (terminals[0] as TrieNode).target ?? createTarget();
  for (const terminal of terminals) {
    if (terminal.target === null) terminal.target = target;
  }
  state.hasDynamic = true;
  const first = ir.segments[0] as CompiledSegment;
  if (first.kind !== "static") return target;
  let bucket = state.buckets.get(first.value);
  if (bucket === undefined) {
    bucket = { fast: null, count: 0 };
    state.buckets.set(first.value, bucket);
  }
  bucket.count++;
  bucket.fast =
    bucket.count === 1 && ir.isSimple
      ? {
          // Full static head ("/v1/users"), not just the first segment — the
          // matcher must skip every leading static before captures begin.
          prefix: staticHeadOf(ir.segments),
          names: paramNamesOf(ir.segments),
          target,
        }
      : null;
  return target;
};

/** Concatenate the leading static segments into a path prefix. */
const staticHeadOf = (segments: readonly CompiledSegment[]): string => {
  let prefix = "";
  for (const segment of segments) {
    if (segment.kind !== "static") break;
    prefix += `/${segment.value}`;
  }
  return prefix;
};

const paramChainFor = (
  state: RouterState,
  segments: readonly CompiledSegment[],
): RouteHandler[] => {
  const chain: RouteHandler[] = [];
  for (const name of paramNamesOf(segments)) {
    const mw = state.paramMiddlewares.get(name);
    if (mw !== undefined && !chain.includes(mw)) chain.push(mw);
  }
  return chain;
};

const chainOf = (handlers: readonly RouteHandler[], globalMw: readonly RouteHandler[]): Chain => {
  if (globalMw.length === 0 && handlers.length === 1) return direct(handlers[0] as RouteHandler);
  return compose(globalMw.length === 0 ? handlers : [...globalMw, ...handlers]) as Chain;
};

/** Index + compose the chain for ONE definition (incremental registration). */
const bindDef = (state: RouterState, def: RouteDef, globalMw: readonly RouteHandler[]): void => {
  const ir = compilePattern(def.path);
  const target = indexPattern(state, ir, def.path);
  // Koa order along the chain: the sub-router's use() middleware (if this
  // def came through mount()) runs BEFORE param middleware, the handler last.
  const handlers = [
    ...(def.prefixMiddleware ?? []),
    ...paramChainFor(state, ir.segments),
    ...def.handlers,
  ];
  // Duplicate path+method registrations append LAYERS (@koa/router runs
  // every matching layer) and the chain is recomposed over the full layer
  // list — the global middleware is embedded exactly once no matter how
  // many layers the path accumulated. (Composing the previous CHAIN under
  // the new one re-ran the global once per duplicate.)
  const previous = target.layers.get(def.method) as RouteHandler[] | undefined;
  const layers = previous === undefined ? handlers : [...previous, ...handlers];
  target.layers.set(def.method, layers);
  target.methods.set(def.method, chainOf(layers, globalMw));
  target.allowed.add(def.method);
  if (def.method === ALL) target.allowed.add("*");
  if (def.method === "GET") target.allowed.add("HEAD");
  if (def.name !== undefined) target.name = def.name;
};

const resetIndex = (state: RouterState): void => {
  state.staticMap = new Map();
  state.buckets = new Map();
  state.trieRoot = createNode();
  state.hasDynamic = false;
};

/** Full re-index + recompose (middleware stack or param middleware changed). */
export const rebuildChains = (state: RouterState, globalMw: readonly RouteHandler[]): void => {
  resetIndex(state);
  for (const def of state.defs) bindDef(state, def, globalMw);
};

/** Register one definition; returns it (callers may tag it, e.g. wsKey). */
export const registerDef = (
  state: RouterState,
  method: string,
  path: string,
  handlers: RouteHandler[],
  name?: string,
  globalMw: readonly RouteHandler[] = [],
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
      if (pathsConflict(def.path, sunk)) {
        throw new TypeError(
          `route ${upper} ${def.path} overlaps natively-sunk ${sunk} — the Bun routing table would silently shadow it`,
        );
      }
    }
  }
  state.defs.push(def);
  if (name !== undefined) state.named.set(name, def);
  bindDef(state, def, globalMw);
  return def;
};

const normalizePath = (path: string): string =>
  path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;

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

const startsWithSegments = (prefix: readonly string[], full: readonly string[]): boolean =>
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
  params: Record<string, string> | null;
}

/**
 * Canonical static-route key: decode each RAW segment independently (an
 * escaped `%2F` never becomes a separator — the trie contract), then
 * re-escape "%" and "/" inside the decoded value. The re-escaping keeps the
 * key injective, so two paths land on the same key EXACTLY when their
 * decoded segments are equal — i.e. precisely when the trie's per-segment
 * static walk would reach the same node.
 */
const canonicalKey = (path: string): string =>
  path
    .split("/")
    .map((segment) => decodeSegment(segment).replace(/%/g, "%25").replace(/\//g, "%2F"))
    .join("/");

/** Try the fast matcher for a bucket; provably equivalent to the trie walk. */
const fastMatch = (bucket: Bucket, path: string): RouteMatch | null => {
  const fast = bucket.fast;
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
    params[names[0] as string] = decodeSegment(value);
    return { target: fast.target, params };
  }
  if (rest.length <= 1) return null;
  const parts = rest.slice(1).split("/");
  if (parts.length !== names.length) return null;
  const params: Record<string, string> = Object.create(null);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] as string;
    if (part.length === 0) return null;
    params[names[i] as string] = decodeSegment(part);
  }
  return { target: fast.target, params };
};

export const matchRoute = (state: RouterState, path: string): RouteMatch | null => {
  // Static candidates mirror the trie exactly: raw, trailing-slash-stripped,
  // then the decoded variants of both (%2F stays one segment per decode).
  let target = state.staticMap.get(path);
  const stripped = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  if (target === undefined && stripped !== path) {
    target = state.staticMap.get(stripped);
  }
  if (target === undefined && path.indexOf("%") !== -1) {
    const decoded = canonicalKey(path);
    target = state.staticMap.get(decoded);
    if (target === undefined && stripped !== path) {
      target = state.staticMap.get(canonicalKey(stripped));
    }
  }
  if (target !== undefined) return { target, params: null };
  if (!state.hasDynamic) return null;

  // Bucket by first segment. The fast matcher's prefix is a DECODED pattern
  // value — a request path carrying escapes compares in a different key
  // space, so those go straight to the trie (whose static children do the
  // decoded comparison canonically).
  const firstEnd = path.indexOf("/", 1);
  const first = firstEnd === -1 ? path.slice(1) : path.slice(1, firstEnd);
  if (first.length > 0 && path.indexOf("%") === -1) {
    const bucket = state.buckets.get(first);
    if (bucket !== undefined) {
      const fast = fastMatch(bucket, path);
      if (fast !== null) return fast;
    }
  }
  return matchPattern(state.trieRoot, path);
};

// ---- URL building (named routes) ---------------------------------------------

/**
 * Percent-encode a path value: encodeURIComponent, except "/" stays a real
 * separator (wildcard values span segments). Without this a value carrying
 * "?", "#" or a space stops addressing the same resource (`?` becomes a
 * query string — a silent round-trip break).
 */
const encodePathValue = (value: string): string =>
  value.split("/").map(encodeURIComponent).join("/");

export const buildURL = (
  segments: readonly CompiledSegment[],
  params: Record<string, string>,
): string => {
  const parts: string[] = [];
  for (const segment of segments) {
    if (segment.kind === "static") {
      // Compiled static segments are DECODED — re-encode for the wire so the
      // built URL is canonical (a decoded "?" or "#" would change meaning).
      parts.push(encodePathValue(segment.value));
      continue;
    }
    const value = params[segment.value];
    if (value === undefined) {
      if (segment.optional) continue;
      throw new Error(`Missing required parameter "${segment.value}" for url()`);
    }
    parts.push(segment.kind === "wildcard" ? encodePathValue(value) : encodeURIComponent(value));
  }
  if (parts.length === 0) return "/";
  const joined = parts.join("/");
  return joined.startsWith("/") ? joined : `/${joined}`;
};

/**
 * Pattern segments of a redirect destination, or null when the destination is
 * verbatim. Only a PATH may carry `:params`: absolute URLs
 * ("https://host:port/x") contain scheme/port colons that are NOT parameter
 * markers, and scheme-relative targets ("//host/x") are verbatim as well.
 */
export const redirectTargetSegments = (destination: string): readonly CompiledSegment[] | null => {
  if (!destination.startsWith("/") || destination.startsWith("//")) return null;
  return destination.includes(":") ? compilePattern(destination).segments : null;
};

/**
 * A redirect destination may only reference params the SOURCE route
 * GUARANTEES at request time — a missing required param would explode as a
 * per-request 500, violating the eager-validation contract. Optional source
 * params are NOT guarantees: they can be absent, exactly like an uncaptured
 * position. Checked at registration.
 */
export const assertRedirectCaptures = (source: string, dest: readonly CompiledSegment[]): void => {
  const available = new Set(
    compilePattern(source)
      .segments.filter((segment) => segment.kind !== "static" && !segment.optional)
      .map((segment) => segment.value),
  );
  for (const segment of dest) {
    if (segment.kind === "static" || segment.optional) continue;
    if (!available.has(segment.value)) {
      throw new TypeError(
        `redirect destination references ":${segment.value}", which ${JSON.stringify(source)} never captures (optionals may be absent at runtime)`,
      );
    }
  }
};

export const urlFor = (
  state: RouterState,
  name: string,
  params: Record<string, string>,
): string => {
  const def = state.named.get(name);
  if (def === undefined) {
    throw new Error(`No route registered under name: ${JSON.stringify(name)}`);
  }
  return buildURL(compilePattern(def.path).segments, params);
};

export const routePathOf = (state: RouterState, name: string): string | undefined =>
  state.named.get(name)?.path;
