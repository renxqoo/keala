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
  /** Length of "/firstSegment" this matcher skips (decoded first segment). */
  prefixLength: number;
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
    let target = state.staticMap.get(fullPath);
    if (target === undefined) {
      target = createTarget();
      state.staticMap.set(fullPath, target);
    }
    return target;
  }
  const node = insertPattern(state.trieRoot, ir.segments);
  if (node.target === null) node.target = createTarget();
  state.hasDynamic = true;
  const first = ir.segments[0] as CompiledSegment;
  if (first.kind !== "static") return node.target;
  let bucket = state.buckets.get(first.value);
  if (bucket === undefined) {
    bucket = { fast: null, count: 0 };
    state.buckets.set(first.value, bucket);
  }
  bucket.count++;
  bucket.fast =
    bucket.count === 1 && ir.isSimple
      ? {
          prefixLength: first.value.length + 1,
          names: paramNamesOf(ir.segments),
          target: node.target,
        }
      : null;
  return node.target;
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
  const handlers = [...paramChainFor(state, ir.segments), ...def.handlers];
  const chain = chainOf(handlers, globalMw);
  // Duplicate path+method registrations chain in registration order
  // (@koa/router runs every matching layer).
  const previous = target.methods.get(def.method);
  target.methods.set(
    def.method,
    previous === undefined ? chain : compose([previous as RouteHandler, chain as RouteHandler]),
  );
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

export const registerDef = (
  state: RouterState,
  method: string,
  path: string,
  handlers: RouteHandler[],
  name?: string,
  globalMw: readonly RouteHandler[] = [],
): void => {
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
  };
  state.defs.push(def);
  if (name !== undefined) state.named.set(name, def);
  bindDef(state, def, globalMw);
};

const normalizePath = (path: string): string =>
  path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;

export interface RouteMatch {
  target: RouteTarget;
  params: Record<string, string> | null;
}

/** Try the fast matcher for a bucket; provably equivalent to the trie walk. */
const fastMatch = (bucket: Bucket, path: string): RouteMatch | null => {
  const fast = bucket.fast;
  if (fast === null) return null;
  const rest = path.slice(fast.prefixLength);
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
  let target = state.staticMap.get(path);
  if (target === undefined && path.length > 1 && path.endsWith("/")) {
    target = state.staticMap.get(path.slice(0, -1));
  }
  if (target !== undefined) return { target, params: null };
  if (!state.hasDynamic) return null;

  // Bucket by first segment. The fast matcher only applies to a RAW first
  // segment (its prefix length is derived from the pattern's decoded
  // segment); an escaped first segment goes straight to the trie, whose
  // static children implement the decoded retry themselves.
  const firstEnd = path.indexOf("/", 1);
  const first = firstEnd === -1 ? path.slice(1) : path.slice(1, firstEnd);
  if (first.length > 0) {
    const bucket = state.buckets.get(first);
    if (bucket !== undefined) {
      const fast = fastMatch(bucket, path);
      if (fast !== null) return fast;
    }
  }
  return matchPattern(state.trieRoot, path);
};

// ---- URL building (named routes) ---------------------------------------------

export const buildURL = (
  segments: readonly CompiledSegment[],
  params: Record<string, string>,
): string => {
  const parts: string[] = [];
  for (const segment of segments) {
    if (segment.kind === "static") {
      parts.push(segment.value);
      continue;
    }
    const value = params[segment.value];
    if (value === undefined) {
      if (segment.optional) continue;
      throw new Error(`Missing required parameter "${segment.value}" for url()`);
    }
    parts.push(segment.kind === "wildcard" ? value : encodeURIComponent(value));
  }
  if (parts.length === 0) return "/";
  const joined = parts.join("/");
  return joined.startsWith("/") ? joined : `/${joined}`;
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
