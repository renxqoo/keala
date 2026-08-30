/**
 * Router — @koa/router-compatible API on top of a static Map + pattern trie.
 *
 * Static routes (no params) hit a single `Map` lookup: O(1), no trie walk.
 * Dynamic routes (`:id`, `:id(\\d+)`, `:id?`, `*`) walk the trie.
 *
 * Every route's middleware stack is compiled ONCE at registration time and
 * reused for all requests — no per-request composition. Fully functional:
 * the router is a closure, not a class.
 */

import { requestStateOf, type Context } from "../context/context.ts";
import { createError } from "../http/errors.ts";
import { compose, type Composed, type Middleware } from "../application/compose.ts";
import { getPath } from "../utils/url.ts";
import {
  compilePattern,
  normalizePath,
  createNode,
  createTarget,
  insertPattern,
  isStaticPattern,
  matchPattern,
  paramNamesOf,
  type CompiledSegment,
  type RouteTarget,
  type TrieNode,
} from "./trie.ts";

export type RouterContext = Context & { params: Record<string, string> };

export interface RouterOptions {
  prefix?: string;
}

export interface RegisterOptions {
  name?: string;
}

// koa-router's methods order — Allow headers follow this sequence.
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

const KNOWN_METHODS = new Set<string>(KNOWN_METHOD_LIST);

const ALL = "ALL";
const EMPTY_PARAMS: Record<string, string> = Object.freeze(Object.create(null));

interface RouteEntry {
  method: string;
  /** Path as passed by the user (relative to the router prefix). */
  path: string;
  name?: string;
  middleware: Middleware<RouterContext>[];
}

interface MountedMiddleware {
  /** Prefix relative to the router's own prefix (recomputed on prefix()). */
  relative: string | null;
  prefix: string | null;
  chain: Composed<Context>;
}

/** Allowed-methods record lives on the context: shared across nested routers
 *  and cleared when a pooled context is recycled. */
const allowedOf = (ctx: Context): Set<string> => {
  const holder = ctx as unknown as { _routerAllowed?: Set<string> };
  return (holder._routerAllowed ??= new Set());
};

export interface Router {
  get(path: string | string[], ...middleware: Middleware<RouterContext>[]): Router;
  get(name: string, path: string, ...middleware: Middleware<RouterContext>[]): Router;
  post(path: string | string[], ...middleware: Middleware<RouterContext>[]): Router;
  post(name: string, path: string, ...middleware: Middleware<RouterContext>[]): Router;
  put(path: string | string[], ...middleware: Middleware<RouterContext>[]): Router;
  put(name: string, path: string, ...middleware: Middleware<RouterContext>[]): Router;
  patch(path: string | string[], ...middleware: Middleware<RouterContext>[]): Router;
  patch(name: string, path: string, ...middleware: Middleware<RouterContext>[]): Router;
  delete(path: string | string[], ...middleware: Middleware<RouterContext>[]): Router;
  delete(name: string, path: string, ...middleware: Middleware<RouterContext>[]): Router;
  head(path: string | string[], ...middleware: Middleware<RouterContext>[]): Router;
  head(name: string, path: string, ...middleware: Middleware<RouterContext>[]): Router;
  options(path: string | string[], ...middleware: Middleware<RouterContext>[]): Router;
  options(name: string, path: string, ...middleware: Middleware<RouterContext>[]): Router;
  all(path: string | string[], ...middleware: Middleware<RouterContext>[]): Router;
  all(name: string, path: string, ...middleware: Middleware<RouterContext>[]): Router;
  register(
    method: string,
    path: string,
    middleware: Middleware<RouterContext>[],
    options?: RegisterOptions,
  ): Router;
  use(path: string | Middleware<RouterContext>, ...middleware: Middleware<RouterContext>[]): Router;
  prefix(prefix: string): Router;
  param(name: string, middleware: Middleware<RouterContext>): Router;
  redirect(source: string, destination: string, code?: number): Router;
  route(name: string): { path: string } | undefined;
  url(name: string, params?: Record<string, string>): string;
  routes(): Middleware<Context>;
  allowedMethods(options?: { throw?: boolean }): Middleware<Context>;
  readonly stack: RouteEntry[];
}

const normalizePrefix = (prefix: string): string => {
  if (prefix.length === 0 || prefix === "/") return "";
  return prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
};

/** Compose a previously-registered chain ahead of a newer one. */
const chainHandlers = (
  previous: unknown,
  next: (ctx: Context, tail: () => Promise<void>) => Promise<void> | void,
): Composed<Context> =>
  compose([
    previous as Middleware<Context>,
    next as Middleware<Context>,
  ]) as unknown as Composed<Context>;

const pathStartsWith = (path: string, prefix: string): boolean =>
  path === prefix || (prefix !== "" && path.startsWith(`${prefix}/`));

const buildURL = (segments: readonly CompiledSegment[], params: Record<string, string>): string => {
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

/** Create a router: `const router = createRouter({ prefix: "/api" })`. */
export const createRouter = (options: RouterOptions = {}): Router => {
  const stack: RouteEntry[] = [];
  const staticRoutes = new Map<string, RouteTarget>();
  const root: TrieNode = createNode();
  const paramMiddlewares = new Map<string, Middleware<RouterContext>>();
  const mounted: MountedMiddleware[] = [];
  const named = new Map<string, RouteEntry>();
  let prefixValue = normalizePrefix(options.prefix ?? "");

  const fullPathOf = (path: string): string => {
    const joined = `${prefixValue}${path}`;
    return normalizePath(joined.length === 0 ? "/" : joined);
  };

  const paramChainFor = (segments: readonly CompiledSegment[]): Middleware<RouterContext>[] => {
    const chain: Middleware<RouterContext>[] = [];
    for (const name of paramNamesOf(segments)) {
      const mw = paramMiddlewares.get(name);
      if (mw !== undefined && !chain.includes(mw)) chain.push(mw);
    }
    return chain;
  };

  const targetOf = (segments: readonly CompiledSegment[], fullPath: string): RouteTarget => {
    if (isStaticPattern(segments)) {
      const existing = staticRoutes.get(fullPath);
      if (existing !== undefined) return existing;
      const target = createTarget();
      staticRoutes.set(fullPath, target);
      return target;
    }
    const node = insertPattern(root, segments);
    if (node.target === null) node.target = createTarget();
    return node.target;
  };

  /** Recompute absolute mounted prefixes from the current router prefix. */
  const refreshMountedPrefixes = (): void => {
    mountedPrefixBase = prefixValue;
    for (const entry of mounted) {
      entry.prefix = entry.relative === null ? null : normalizePrefix(prefixValue + entry.relative);
    }
  };
  let mountedPrefixBase = prefixValue;

  const bindRoute = (entry: RouteEntry): void => {
    const fullPath = fullPathOf(entry.path);
    const segments = compilePattern(fullPath);
    const paramChain = paramChainFor(segments);
    const chain =
      paramChain.length === 0 && entry.middleware.length === 1
        ? (entry.middleware[0] as Middleware<Context>)
        : (compose([...paramChain, ...entry.middleware]) as unknown as Composed<Context>);
    const target = targetOf(segments, fullPath);
    const previous = target.methods.get(entry.method);
    // Duplicate path+method registrations chain in registration order
    // (@koa/router runs every matching layer).
    const merged = previous === undefined ? chain : chainHandlers(previous, chain);
    target.methods.set(entry.method, merged);
    target.allowed.add(entry.method);
    if (entry.method === ALL) target.allowed.add("*");
    // koa-router convention: a GET route also answers HEAD.
    if (entry.method === "GET") target.allowed.add("HEAD");
  };

  const rebuild = (): void => {
    staticRoutes.clear();
    root.children.clear();
    root.param = null;
    root.wildcard = null;
    for (const entry of stack) bindRoute(entry);
  };

  const register = (
    method: string,
    path: string | string[],
    middleware: Middleware<RouterContext>[],
    registerOptions: RegisterOptions = {},
  ): Router => {
    const upper = method.toUpperCase();
    if (!KNOWN_METHODS.has(upper) && upper !== ALL) {
      throw new TypeError(`Unknown HTTP method: ${JSON.stringify(method)}`);
    }
    for (const mw of middleware) {
      if (typeof mw !== "function") {
        throw new TypeError("Route handlers must be functions");
      }
    }
    const paths = Array.isArray(path) ? path : [path];
    for (const single of paths) {
      const entry: RouteEntry = {
        method: upper,
        path: single,
        middleware,
        name: registerOptions.name,
      };
      stack.push(entry);
      if (registerOptions.name !== undefined) named.set(registerOptions.name, entry);
      bindRoute(entry);
    }
    return router;
  };

  const methodShortcut =
    (method: string) =>
    (
      pathOrName: string,
      pathOrMiddleware: string | Middleware<RouterContext>,
      ...rest: Middleware<RouterContext>[]
    ): Router => {
      if (typeof pathOrMiddleware === "string") {
        return register(method, pathOrMiddleware, rest, { name: pathOrName });
      }
      return register(method, pathOrName, [pathOrMiddleware, ...rest]);
    };

  const dispatchRoute = (ctx: Context, path: string, next: () => Promise<void>) => {
    let staticTarget = staticRoutes.get(path);
    if (staticTarget === undefined && path.length > 1 && path.endsWith("/")) {
      staticTarget = staticRoutes.get(path.slice(0, -1));
    }
    let target: RouteTarget | null = null;
    let params: Record<string, string> | null = null;
    if (staticTarget !== undefined) {
      target = staticTarget;
    } else {
      const match = matchPattern(root, path);
      if (match !== null) {
        target = match.target;
        params = match.params;
      }
    }
    if (target === null) return next();

    const rawMethod = requestStateOf(ctx).rawRequest.method;
    const method = rawMethod === "GET" ? "GET" : rawMethod.toUpperCase();
    // Express-style convenience: HEAD falls back to the GET handler.
    const chain = (target.methods.get(method) ??
      (method === "HEAD" ? target.methods.get("GET") : undefined) ??
      target.methods.get(ALL)) as Composed<Context> | undefined;
    if (chain === undefined) {
      const allowed = allowedOf(ctx);
      for (const entry of target.allowed) allowed.add(entry);
      return next();
    }
    (ctx as unknown as RouterContext).params = params ?? EMPTY_PARAMS;
    return chain(ctx, next);
  };

  const router: Router = {
    stack,
    get: methodShortcut("GET"),
    post: methodShortcut("POST"),
    put: methodShortcut("PUT"),
    patch: methodShortcut("PATCH"),
    delete: methodShortcut("DELETE"),
    head: methodShortcut("HEAD"),
    options: methodShortcut("OPTIONS"),
    all: methodShortcut(ALL),
    register,

    use(path: string | Middleware<RouterContext>, ...rest: Middleware<RouterContext>[]): Router {
      const hasPath = typeof path === "string" || Array.isArray(path);
      const middleware = (hasPath ? rest : ([path, ...rest] as Middleware<RouterContext>[])).filter(
        (mw) => typeof mw === "function",
      );
      if (middleware.length === 0) {
        throw new TypeError("router.use() requires at least one middleware function");
      }
      const chain = compose(middleware) as unknown as Composed<Context>;
      const relatives: string[] = [];
      if (typeof path === "string") relatives.push(path);
      else if (Array.isArray(path)) relatives.push(...path);
      if (relatives.length === 0) {
        mounted.push({ relative: null, prefix: null, chain });
      } else {
        for (const relative of relatives) {
          mounted.push({ relative, prefix: null, chain });
        }
      }
      refreshMountedPrefixes();
      return router;
    },

    prefix(prefix: string): Router {
      const next = normalizePrefix(prefix);
      if (prefixValue === next) return router;
      prefixValue = next;
      rebuild();
      refreshMountedPrefixes();
      return router;
    },

    param(name: string, middleware: Middleware<RouterContext>): Router {
      if (typeof name !== "string" || name.length === 0) {
        throw new TypeError("router.param() requires a parameter name");
      }
      if (typeof middleware !== "function") {
        throw new TypeError("router.param() requires a middleware function");
      }
      paramMiddlewares.set(name, middleware);
      rebuild();
      return router;
    },

    redirect(source: string, destination: string, code = 301): Router {
      const destSegments = destination.includes(":") ? compilePattern(destination) : null;
      return register("GET", source, [
        (ctx) => {
          const target = destSegments === null ? destination : buildURL(destSegments, ctx.params);
          ctx.status = code;
          ctx.redirect(target);
        },
      ]);
    },

    route(name: string): { path: string } | undefined {
      const entry = named.get(name);
      return entry === undefined ? undefined : { path: fullPathOf(entry.path) };
    },

    url(name: string, params: Record<string, string> = Object.create(null)): string {
      const entry = named.get(name);
      if (entry === undefined) {
        throw new Error(`No route registered under name: ${JSON.stringify(name)}`);
      }
      return buildURL(compilePattern(fullPathOf(entry.path)), params);
    },

    routes(): Middleware<Context> {
      return (ctx, next) => {
        const state = requestStateOf(ctx);
        const path = state._url !== null ? getPath(state._url) : getPath(state.rawRequest.url);
        const middlewares = mounted;
        if (middlewares.length === 0) return dispatchRoute(ctx, path, next);
        if (mountedPrefixBase !== prefixValue) refreshMountedPrefixes();
        let index = 0;
        const runMounted = (): Promise<void> | void => {
          if (index === middlewares.length) return dispatchRoute(ctx, path, next);
          const entry = middlewares[index++] as MountedMiddleware;
          if (entry.prefix !== null && !pathStartsWith(path, entry.prefix)) {
            return runMounted();
          }
          if (entry.prefix === null) {
            return entry.chain(ctx, () => runMounted() as Promise<void>);
          }
          // Mount semantics (like koa-mount): downstream sees the stripped
          // path — but the query string survives the rewrite.
          const previousUrl = ctx.url;
          const stripped = path.slice(entry.prefix.length) || "/";
          const mark = previousUrl.indexOf("?");
          ctx.url = mark === -1 ? stripped : `${stripped}${previousUrl.slice(mark)}`;
          return Promise.resolve(
            entry.chain(ctx, () => runMounted() as Promise<void>) as Promise<void>,
          ).finally(() => {
            ctx.url = previousUrl;
          });
        };
        return runMounted();
      };
    },

    allowedMethods(throwOptions: { throw?: boolean } = {}): Middleware<Context> {
      return (ctx, next) =>
        next().then(() => {
          if (ctx.status !== 404) return;
          const allowed = (ctx as unknown as { _routerAllowed?: Set<string> })._routerAllowed;
          if (allowed === undefined || allowed.size === 0) return;
          // koa-router emits Allow in its methods-array order (HEAD first).
          const allowHeader = KNOWN_METHOD_LIST.filter((m) => allowed.has(m)).join(", ");
          ctx.set("Allow", allowHeader);
          const method = ctx.method.toUpperCase();
          if (!KNOWN_METHODS.has(method)) {
            if (throwOptions.throw === true) {
              throw createError(501, { headers: { Allow: allowHeader } });
            }
            ctx.status = 501;
            return;
          }
          if (method === "OPTIONS") {
            // koa-router: OPTIONS answers 200 with an empty body and Allow.
            if (throwOptions.throw === true) {
              throw createError(405, { headers: { Allow: allowHeader } });
            }
            ctx.status = 200;
            ctx.body = "";
            return;
          }
          if (!allowed.has(method)) {
            if (throwOptions.throw === true) {
              throw createError(405, { headers: { Allow: allowHeader } });
            }
            ctx.status = 405;
            return;
          }
        });
    },
  };

  return router;
};
