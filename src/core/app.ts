/**
 * Application factory — `createApp()`.
 *
 * Request pipeline (docs/v2-DESIGN.md §2): routing happens at the TOP of the
 * pipeline (not as an onion layer), the matched route's precompiled chain
 * runs (single-handler routes skip composition entirely), and the finalizer
 * converts the context state into a web `Response`. Global middleware runs
 * for unmatched paths and unmatched methods too — koa's observable contract.
 *
 * `app.handle` is a standard fetch handler: `(request, runtime?) => Response`,
 * which is exactly what `Bun.serve` wants. The Bun adapter is the only module
 * that references the `Bun` global, so the core also runs under Node (tests).
 */

import type { AppOptions, ListenOptions, Runtime } from "../types.ts";
import { getPath } from "../utils/url.ts";
import { isHttpError, normalizeError } from "../http/errors.ts";
import { isValidErrorStatus, statusMessage } from "../http/status.ts";
import type { SigningKeys } from "../context/cookies.ts";
import type { RequestSettings } from "./context/settings.ts";
import { baseContextProto, createContext, type Context } from "./context/context.ts";
import { compose, NOOP_TAIL } from "./compose.ts";
import { finalize } from "./respond.ts";
import { createEmitter, type Listener } from "./emitter.ts";
import {
  type Chain,
  buildURL,
  createRouterState,
  EMPTY_PARAMS,
  matchRoute,
  rebuildChains,
  registerDef,
  urlFor,
  routePathOf,
  type RouteDef,
  type RouteHandler,
  type RouterState,
} from "../router/router.ts";
import { compilePattern } from "../router/pattern.ts";
import { createRouter, isRouter } from "../router/group.ts";
import type { Router } from "../router/group.ts";
import { startBunServer, type ServerHandle } from "../adapters/bun.ts";

export type ErrorListener = (error: Error, c: Context) => void;
export type NotFoundHandler = (c: Context) => Response | void;

export interface Application {
  /** Subscribe to framework errors (typed hook). */
  onError(handler: ErrorListener): Application;
  emit(event: string, ...args: unknown[]): boolean;
  off(event: string, listener: (...args: unknown[]) => void): void;
  listenerCount(event: string): number;
  /** Register global middleware (compiled into every route chain). */
  use(...middleware: RouteHandler[]): Application;
  /** Register a route. Named form: get(name, path, ...handlers). */
  get(path: string, ...handlers: RouteHandler[]): Application;
  get(name: string, path: string, ...handlers: RouteHandler[]): Application;
  post(path: string, ...handlers: RouteHandler[]): Application;
  post(name: string, path: string, ...handlers: RouteHandler[]): Application;
  put(path: string, ...handlers: RouteHandler[]): Application;
  put(name: string, path: string, ...handlers: RouteHandler[]): Application;
  patch(path: string, ...handlers: RouteHandler[]): Application;
  patch(name: string, path: string, ...handlers: RouteHandler[]): Application;
  delete(path: string, ...handlers: RouteHandler[]): Application;
  delete(name: string, path: string, ...handlers: RouteHandler[]): Application;
  head(path: string, ...handlers: RouteHandler[]): Application;
  head(name: string, path: string, ...handlers: RouteHandler[]): Application;
  options(path: string, ...handlers: RouteHandler[]): Application;
  options(name: string, path: string, ...handlers: RouteHandler[]): Application;
  all(path: string, ...handlers: RouteHandler[]): Application;
  all(name: string, path: string, ...handlers: RouteHandler[]): Application;
  /** Register with an explicit method (any case). */
  on(method: string, path: string, ...handlers: RouteHandler[]): Application;
  /** Per-parameter middleware, run by every route that captures `name`. */
  param(name: string, middleware: RouteHandler): Application;
  /** Merge a sub-router's routes (or another app's) under a prefix. */
  mount(prefix: string, sub: Router | Application): Application;
  /** Redirect route (GET): app.redirect("/a", "/b", 302). */
  redirect(source: string, destination: string, code?: number): Application;
  /** URL for a named route (throws when a required param is missing). */
  url(name: string, params?: Record<string, string>): string;
  /** Path of a named route, undefined when absent. */
  route(name: string): string | undefined;
  /** Custom not-found handler (runs when a request never produced a response). */
  notFound(handler: NotFoundHandler): Application;
  /** Extend every context with a property or method (setup time only). */
  decorate(key: string, value: unknown): Application;
  /** Fetch-style request handler — the heart of the framework. */
  handle(request: Request, runtime?: Runtime): Response | Promise<Response>;
  /** Alias for `handle`, useful for adapters. */
  callback(): (request: Request, runtime?: Runtime) => Response | Promise<Response>;
  /** Start a `Bun.serve` server. Returns the Bun server handle. */
  listen(
    port?: number | string | ListenOptions | (() => void),
    hostname?: string | (() => void),
    onListen?: () => void,
  ): ServerHandle;
  /** Central error hook (emit + fallback logging). */
  onerror(error: Error, c?: Context): void;
  /** Serialized app summary. */
  toJSON(): { env: string; proxy: boolean };
  /** Effective not-found handler used by the finalizer. */
  readonly notFoundHandler: NotFoundHandler;
  /** Registered route definitions (inspection/tests). */
  readonly stack: readonly RouteDef[];
  /** Global middleware stack (consumed whole by `mount`). */
  readonly globalMiddleware: readonly RouteHandler[];
  readonly router: RouterState;
  readonly settings: RequestSettings;
  readonly env: string;
  readonly proxy: boolean;
  readonly silent: boolean;
  readonly keys: SigningKeys | undefined;
}

interface ParsedListen {
  listen: ListenOptions;
  hostname?: string;
  onListen?: () => void;
}

const parseListenArgs = (args: readonly unknown[]): ParsedListen => {
  const parsed: ParsedListen = { listen: {} };
  for (const arg of args) {
    if (typeof arg === "function") parsed.onListen = arg as () => void;
    else if (typeof arg === "number") parsed.listen.port = arg;
    else if (typeof arg === "string") {
      // "3000" is a port; anything else is a hostname.
      if (/^\d+$/.test(arg.trim())) parsed.listen.port = Number(arg);
      else parsed.hostname = arg;
    } else if (typeof arg === "object" && arg !== null) {
      const opts = arg as ListenOptions & { hostname?: string };
      if (opts.hostname !== undefined) parsed.hostname = opts.hostname;
      if (opts.port !== undefined) parsed.listen.port = opts.port;
      if (opts.reusePort !== undefined) parsed.listen.reusePort = opts.reusePort;
      if (opts.idleTimeout !== undefined) parsed.listen.idleTimeout = opts.idleTimeout;
      if (opts.maxRequestBodySize !== undefined) {
        parsed.listen.maxRequestBodySize = opts.maxRequestBodySize;
      }
      if (opts.development !== undefined) parsed.listen.development = opts.development;
    }
  }
  return parsed;
};

/** Node-style plain errors may carry `.status` or `.statusCode`. */
const errorStatusCode = (error: Error): number => {
  const candidate = (error as Partial<Error & { status: number; statusCode: number }>).status;
  const code = (error as Partial<{ statusCode: number }>).statusCode;
  return isValidErrorStatus(candidate as number)
    ? (candidate as number)
    : isValidErrorStatus(code as number)
      ? (code as number)
      : 500;
};

/**
 * Finalize behind the never-reject guard: a failing finalizer (unserializable
 * bodies, throwing not-found handlers, bad headers) answers 500 instead of
 * rejecting past `app.handle`.
 */
const finalizeGuarded = (app: Application, c: Context): Response | Promise<Response> => {
  try {
    const out = finalize(app, c);
    if (out instanceof Promise) {
      return out.catch((err: unknown) => errorResponse(app, c, err));
    }
    return out;
  } catch (err) {
    return errorResponse(app, c, err);
  }
};

/** Run the compiled chain and finalize; never rethrows to the caller. */
const dispatchChain = (
  app: Application,
  c: Context,
  chain: Chain,
): Response | Promise<Response> => {
  let settled: Promise<void> | void;
  try {
    settled = chain(c, NOOP_TAIL);
  } catch (err) {
    return errorResponse(app, c, err);
  }
  // The finalizer itself can fail (unserializable bodies, bad headers) — it
  // must answer 500, never reject past app.handle. It stays synchronous on
  // every hot path (only committed-Response-under-HEAD goes async), so fully
  // synchronous middleware chains settle without a single extra promise.
  const finish = (): Response | Promise<Response> => finalizeGuarded(app, c);
  // Fully synchronous middleware chains settle without a single promise.
  if (settled !== undefined && typeof (settled as PromiseLike<void>).then === "function") {
    return (settled as Promise<void>).then(finish, (err: unknown) => errorResponse(app, c, err));
  }
  return finish();
};

const errorResponse = async (app: Application, c: Context, err: unknown): Promise<Response> => {
  try {
    return await buildErrorResponse(app, c, err);
  } catch {
    return new Response("Internal Server Error", {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
};

const buildErrorResponse = (
  app: Application,
  c: Context,
  err: unknown,
): Response | Promise<Response> => {
  const error = normalizeError(err);
  app.onerror(error, c);

  // A stale committed response must not shadow the error.
  c._res = undefined;
  // Koa's onerror contract: a failed response starts from a clean header set
  // (set-cookie survives — deliberate, tested divergence from koa).
  const record = c.headersRecord;
  if (record !== null) {
    for (const key of Object.keys(record)) {
      if (key !== "set-cookie") delete record[key];
    }
  }
  c.bodyValue = null;
  c.messageValue = "";
  c.flags = 0;
  if (isHttpError(error)) {
    for (const [field, value] of Object.entries(error.headers ?? {})) {
      // The error path must never throw; skip headers that fail validation.
      try {
        c.set(field, Array.isArray(value) ? value : String(value));
      } catch {
        // Invalid header from an error object — drop it silently.
      }
    }
  }
  const status = isHttpError(error) ? error.status : errorStatusCode(error);
  c.status = status;
  const exposed = isHttpError(error) ? error.expose === true : false;
  const message = exposed ? error.message : statusMessage(status) || "Internal Server Error";
  c.set("Content-Type", "text/plain; charset=utf-8");
  c.body = message;
  return finalizeGuarded(app, c);
};

const defaultNotFound: NotFoundHandler = () => undefined;

const routeShortcut = (
  app: Application,
  router: RouterState,
  globalMw: RouteHandler[],
  method: string,
  args: unknown[],
): Application => {
  const [first, second, ...rest] = args as [string, string | RouteHandler, ...RouteHandler[]];
  if (typeof first !== "string") {
    throw new TypeError("Route registration requires a path string");
  }
  if (typeof second === "string") {
    registerDef(router, method, second, rest as RouteHandler[], first, globalMw);
  } else if (typeof second === "function") {
    registerDef(router, method, first, [second, ...rest], undefined, globalMw);
  } else {
    throw new TypeError("Route registration requires at least one handler");
  }
  return app;
};

export { createRouter, isRouter };

export const createApp = (options: AppOptions = {}): Application => {
  const emitter = createEmitter();
  const globalMw: RouteHandler[] = [];
  const router = createRouterState();
  // Derived per app: decorate() writes land here, never on the shared base
  // prototype — one app's extensions must not leak into another's contexts.
  const contextProto: object = Object.create(baseContextProto);
  const settings: RequestSettings = Object.freeze({
    proxy: options.proxy ?? false,
    proxyIpHeader: options.proxyIpHeader ?? "x-forwarded-for",
    maxIpsCount: options.maxIpsCount,
    subdomainOffset: options.subdomainOffset ?? 2,
  });
  let globalChain: Chain | null = null;
  let notFoundHandler: NotFoundHandler = defaultNotFound;

  const app: Application = {
    env: options.env ?? process.env["NODE_ENV"] ?? "development",
    proxy: settings.proxy,
    silent: options.silent ?? false,
    keys: options.keys,
    settings,
    router,
    get stack(): readonly RouteDef[] {
      return router.defs;
    },
    get globalMiddleware(): readonly RouteHandler[] {
      return globalMw;
    },
    get notFoundHandler(): NotFoundHandler {
      return notFoundHandler;
    },

    use(...args) {
      for (const mw of args) {
        if (typeof mw !== "function") {
          throw new TypeError("app.use() requires a middleware function");
        }
        globalMw.push(mw);
      }
      // Late middleware re-composes every route chain — O(routes), a
      // documented setup-time cost.
      globalChain = compose(globalMw) as Chain;
      rebuildChains(router, globalMw);
      return app;
    },

    get(...args) {
      return routeShortcut(app, router, globalMw, "GET", args);
    },
    post(...args) {
      return routeShortcut(app, router, globalMw, "POST", args);
    },
    put(...args) {
      return routeShortcut(app, router, globalMw, "PUT", args);
    },
    patch(...args) {
      return routeShortcut(app, router, globalMw, "PATCH", args);
    },
    delete(...args) {
      return routeShortcut(app, router, globalMw, "DELETE", args);
    },
    head(...args) {
      return routeShortcut(app, router, globalMw, "HEAD", args);
    },
    options(...args) {
      return routeShortcut(app, router, globalMw, "OPTIONS", args);
    },
    all(...args) {
      return routeShortcut(app, router, globalMw, "ALL", args);
    },
    on(method, path, ...handlers) {
      registerDef(router, method, path, handlers, undefined, globalMw);
      return app;
    },

    param(name, middleware) {
      if (typeof name !== "string" || name.length === 0) {
        throw new TypeError("app.param() requires a parameter name");
      }
      if (typeof middleware !== "function") {
        throw new TypeError("app.param() requires a middleware function");
      }
      router.paramMiddlewares.set(name, middleware);
      // Existing routes capturing this param pick it up on rebuild.
      rebuildChains(router, globalMw);
      return app;
    },

    mount(prefix, sub) {
      if (sub === app) {
        throw new TypeError("app.mount() cannot mount an app into itself");
      }
      // "/" (and "") mount at the root without doubling slashes.
      const base =
        prefix === "/" || prefix === ""
          ? ""
          : prefix.endsWith("/") && prefix.length > 1
            ? prefix.slice(0, -1)
            : prefix;
      // Snapshot: registering into this app must not alias the live array
      // being iterated (self-referential mounts would otherwise grow forever).
      const defs = [...(isRouter(sub) ? sub.defs : sub.router.defs)];
      const paramMiddlewares = isRouter(sub) ? sub.paramMiddlewares : sub.router.paramMiddlewares;
      // A mounted app (or router) carries its own middleware ahead of its routes.
      const subGlobal = isRouter(sub) ? sub.middleware : sub.globalMiddleware;
      for (const [name, handler] of paramMiddlewares) {
        if (!router.paramMiddlewares.has(name)) router.paramMiddlewares.set(name, handler);
      }
      for (const def of defs) {
        const path = `${base}${def.path}` || "/";
        registerDef(router, def.method, path, [...subGlobal, ...def.handlers], def.name, globalMw);
      }
      return app;
    },

    redirect(source, destination, code = 301) {
      const destSegments = destination.includes(":") ? compilePattern(destination).segments : null;
      registerDef(
        router,
        "GET",
        source,
        [
          (c) => {
            const target =
              destSegments === null ? destination : buildURL(destSegments, c.params ?? {});
            c.status = code;
            c.redirect(target);
          },
        ],
        undefined,
        globalMw,
      );
      return app;
    },

    url: (name, params = Object.create(null)) => urlFor(router, name, params),
    route: (name) => routePathOf(router, name),

    notFound(handler) {
      notFoundHandler = handler;
      return app;
    },

    decorate(key, value) {
      Object.defineProperty(contextProto, key, {
        value,
        writable: true,
        configurable: true,
        enumerable: false,
      });
      return app;
    },

    handle(request, runtime) {
      const c = createContext(app, contextProto, request, runtime);
      const path = getPath(request.url);
      const match = matchRoute(router, path);
      if (match !== null) {
        c.params = match.params ?? EMPTY_PARAMS;
        const rawMethod = request.method;
        const method = rawMethod === "GET" ? "GET" : rawMethod.toUpperCase();
        // Express-style convenience: HEAD falls back to the GET handler.
        const chain =
          (match.target.methods.get(method) as Chain | undefined) ??
          (method === "HEAD"
            ? (match.target.methods.get("GET") as Chain | undefined)
            : undefined) ??
          (match.target.methods.get("ALL") as Chain | undefined);
        if (chain !== undefined) return dispatchChain(app, c, chain);
        for (const allowed of match.target.allowed) c.routerAllowed.add(allowed);
      }
      // No handler: global middleware still runs (koa contract), then the
      // finalizer decides between 405/501/OPTIONS and not-found.
      if (globalChain === null) return finalizeGuarded(app, c);
      return dispatchChain(app, c, globalChain);
    },

    callback() {
      return (request, runtime) => app.handle(request, runtime);
    },

    listen(...args) {
      const { listen, hostname, onListen } = parseListenArgs(args);
      return startBunServer(
        app,
        { ...listen, ...(hostname !== undefined ? { hostname } : {}) },
        onListen,
      );
    },

    onerror(error, c) {
      // Koa contract: null is a no-op; a non-Error is a loud TypeError.
      if (error == null) return;
      if (!(error instanceof Error)) {
        throw new TypeError(`non-error thrown: ${JSON.stringify(error)}`);
      }
      const heard = emitter.emit("error", error, c);
      // Koa: client-level errors (4xx / exposed) are not server faults — no log.
      const status = (error as Partial<{ status: number }>).status;
      const expose = (error as Partial<{ expose: boolean }>).expose;
      const clientError =
        status === 404 || expose === true || (typeof status === "number" && status < 500);
      if (!heard && !app.silent && app.env !== "test" && !clientError) {
        console.error(`\n  ${error.stack ?? error.message}\n  at ${c?.url ?? "unknown"}\n`);
      }
    },

    toJSON() {
      return { env: app.env, proxy: app.proxy };
    },

    onError(handler) {
      emitter.on("error", handler as Listener);
      return app;
    },
    off: (event, listener) => emitter.off(event, listener as Listener),
    emit: (event, ...args) => emitter.emit(event, ...args),
    listenerCount: (event) => emitter.listenerCount(event),
  };

  return app;
};
