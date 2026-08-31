/**
 * Application factory — `createApp()`.
 *
 * Request pipeline (docs/DESIGN.md §2): routing happens at the TOP of the
 * pipeline (not as an onion layer), the matched route's precompiled chain
 * runs (single-handler routes skip composition entirely), and the finalizer
 * converts the context state into a web `Response`. Global middleware runs
 * for unmatched paths and unmatched methods too — koa's observable contract.
 * `app.handle` is a fetch handler — exactly what `Bun.serve` wants; the core
 * also runs under Node (tests).
 */

import type { AppOptions, Plugin as AppOptionsPlugin, ListenOptions, Runtime } from "../types.ts";
import { getPath } from "../utils/url.ts";
import type { SigningKeys } from "../context/cookies.ts";
import type { RequestSettings } from "./context/settings.ts";
import { baseContextProto, createContext, resetContext, type Context } from "./context/context.ts";
import { createPool, retireWithBody } from "./context/pool.ts";
import { createDecorator } from "./context/decorate.ts";
import { compose } from "./compose.ts";
import {
  dispatchChain,
  finalizeGuarded,
  mergeMountedWs,
  onAppError,
  parseListenArgs,
  pluginInstallerOf,
  registerRedirect,
  routeShortcut,
  wsUpgradeHandler,
} from "./dispatch.ts";
import { createEmitter, type Listener } from "./emitter.ts";
import {
  type Chain,
  createRouterState,
  EMPTY_PARAMS,
  matchRoute,
  rebuildChains,
  registerDef,
  normalizePrefix,
  urlFor,
  routePathOf,
  type RouteDef,
  type RouteHandler,
  type RouterState,
} from "../router/router.ts";
import { createRouter, isRouter } from "../router/group.ts";
import type { Router } from "../router/group.ts";
import { startBunServer, type ServerHandle } from "../adapters/bun.ts";
import { buildNativeRoutes, registerSink, type NativeSinkEntry } from "./sink.ts";

export type ErrorListener = (error: Error, c: Context) => void;
export type NotFoundHandler = (c: Context) => Response | void;

/** Bun-native websocket event handlers (the `ws` argument IS Bun's socket). */
export interface WebSocketHandlers {
  open?: (ws: unknown, c: Context) => void | Promise<void>;
  message?: (ws: unknown, message: string | ArrayBuffer, c: Context) => void | Promise<void>;
  close?: (ws: unknown, code: number, reason: string, c: Context) => void | Promise<void>;
  drain?: (ws: unknown, c: Context) => void | Promise<void>;
  error?: (ws: unknown, error: Error, c: Context) => void | Promise<void>;
}

export interface Application {
  /** Subscribe to framework errors (typed hook). */
  onError(handler: ErrorListener): Application;
  emit(event: string, ...args: unknown[]): boolean;
  off(event: string, listener: (...args: unknown[]) => void): void;
  listenerCount(event: string): number;
  /** Register global middleware or a plugin (compiled into every route chain). */
  use(...middleware: (RouteHandler | AppOptionsPlugin)[]): Application;
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
  /**
   * Sink a static route into Bun's native routing table (mirrored as a JS
   * route). Requires an app without global/param middleware — the native
   * table bypasses them. See src/core/sink.ts.
   */
  sink(path: string, response: Response | { dir: string }): Application;
  /** Registered native sinks (consumed by the Bun adapter at listen()). */
  readonly nativeSinks: ReadonlyMap<string, NativeSinkEntry>;
  /** Rebuild the native routes table on the running server (Bun only). */
  reloadNativeRoutes(): void;
  /** Per-parameter middleware, run by every route that captures `name`. */
  param(name: string, middleware: RouteHandler): Application;
  /** WebSocket route: upgraded through the runtime server at request time. */
  ws(path: string, handlers: WebSocketHandlers): Application;
  /** Registered websocket routes (consumed by the Bun adapter). */
  readonly wsRoutes: ReadonlyMap<string, WebSocketHandlers>;
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
  readonly onStreamError: AppOptions["onStreamError"];
}

const defaultNotFound: NotFoundHandler = () => undefined;

/** Routers carry no ws registrations — mount() reads an empty map for them. */
const NO_WS_HANDLERS: ReadonlyMap<string, WebSocketHandlers> = new Map();

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
  const wsRoutes = new Map<string, WebSocketHandlers>();
  const nativeSinks = new Map<string, NativeSinkEntry>();
  let serverHandle: ServerHandle | null = null;
  // Sticky: a listen({nativeRoutes: false}) opt-out must survive later
  // sink() calls (they must not silently install a native table).
  let nativeRoutesEnabled = true;
  // Guarded pooling (opt-in): settled contexts retire through a prototype
  // swap; late writes throw instead of corrupting the next request. Built
  // after `app` exists (the pool captures it); handle() runs later still.
  const poolingEnabled = options.pooling === true;
  let pool: ReturnType<typeof createPool> | null = null;
  // decorate() implementation bound to this app's derived context prototype
  // (collision guard included — see core/context/decorate.ts).
  const decorateContext = createDecorator(contextProto);

  const app: Application = {
    env: options.env ?? process.env["NODE_ENV"] ?? "development",
    proxy: settings.proxy,
    silent: options.silent ?? false,
    keys: options.keys,
    onStreamError: options.onStreamError,
    settings,
    router,
    get stack(): readonly RouteDef[] {
      return router.defs;
    },
    get globalMiddleware(): readonly RouteHandler[] {
      return globalMw;
    },
    get wsRoutes(): ReadonlyMap<string, WebSocketHandlers> {
      return wsRoutes;
    },
    get nativeSinks(): ReadonlyMap<string, NativeSinkEntry> {
      return nativeSinks;
    },
    get notFoundHandler(): NotFoundHandler {
      return notFoundHandler;
    },

    use(...args) {
      for (const mw of args) {
        const installer = pluginInstallerOf(mw);
        if (installer !== null) {
          installer(app);
          continue;
        }
        if (typeof mw !== "function") {
          throw new TypeError("app.use() requires a middleware function or plugin");
        }
        if (nativeSinks.size > 0) {
          throw new TypeError(
            "app.use(fn) cannot run alongside sunk routes — the native routing table bypasses global middleware",
          );
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

    sink(path, response) {
      registerSink(router, nativeSinks, path, response, globalMw);
      if (serverHandle !== null && nativeRoutesEnabled) {
        serverHandle.reload({ routes: buildNativeRoutes(nativeSinks) });
      }
      return app;
    },

    reloadNativeRoutes() {
      if (serverHandle === null) {
        throw new Error("reloadNativeRoutes() requires a running server started via app.listen()");
      }
      if (!nativeRoutesEnabled) {
        throw new Error("reloadNativeRoutes() is disabled by listen({ nativeRoutes: false })");
      }
      serverHandle.reload({ routes: buildNativeRoutes(nativeSinks) });
    },

    ws(path, handlers) {
      if (poolingEnabled) {
        // Sockets keep this request's context alive for the connection
        // lifetime; pooling would recycle it under the next request.
        throw new TypeError(
          "app.ws() cannot run with pooling: true — sockets retain contexts beyond the request lifetime",
        );
      }
      const routeKey = normalizePrefix(path) || "/";
      // A duplicate would silently shadow the first handlers — refuse it.
      if (wsRoutes.has(routeKey)) {
        throw new TypeError(
          `app.ws(${JSON.stringify(routeKey)}) is already registered — a duplicate would shadow it`,
        );
      }
      wsRoutes.set(routeKey, handlers);
      // The upgrade happens on ANY method hit; register ALL so method-based
      // 405s never interfere. The def carries the ws key so mount() can
      // re-key the registration under its prefix.
      registerDef(
        router,
        "ALL",
        routeKey,
        [wsUpgradeHandler(routeKey)],
        undefined,
        globalMw,
      ).wsKey = routeKey;
      return app;
    },

    param(name, middleware) {
      if (typeof name !== "string" || name.length === 0) {
        throw new TypeError("app.param() requires a parameter name");
      }
      if (typeof middleware !== "function") {
        throw new TypeError("app.param() requires a middleware function");
      }
      if (nativeSinks.size > 0) {
        throw new TypeError(
          "app.param() cannot run alongside sunk routes — the native routing table bypasses param middleware",
        );
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
      if (nativeSinks.size > 0 && paramMiddlewares.size > 0) {
        throw new TypeError(
          "app.mount() cannot introduce param middleware alongside sunk routes — the native routing table bypasses it",
        );
      }
      // A mounted app (or router) carries its own middleware ahead of its routes.
      const subGlobal = isRouter(sub) ? sub.middleware : sub.globalMiddleware;
      let mergedParams = false;
      for (const [name, handler] of paramMiddlewares) {
        if (!router.paramMiddlewares.has(name)) {
          router.paramMiddlewares.set(name, handler);
          mergedParams = true;
        }
      }
      // Same contract as app.param(): newly merged param middleware must reach
      // routes registered BEFORE the mount, not only later ones — one rebuild.
      if (mergedParams) rebuildChains(router, globalMw);
      for (const def of defs) {
        const path = `${base}${def.path}` || "/";
        // ws registrations re-key under the mount (see mergeMountedWs — an
        // empty source map makes its own guard throw for router-typed subs).
        if (def.wsKey !== undefined) {
          // The app.ws() pooling guard, enforced on the mount path too: the
          // socket keeps this request's context alive for the connection
          // lifetime, which pooling would recycle under the next request.
          if (poolingEnabled) {
            throw new TypeError(
              "app.mount() cannot introduce ws routes into a pooling: true app — sockets retain contexts beyond the request lifetime",
            );
          }
          mergeMountedWs(
            wsRoutes,
            router,
            path,
            subGlobal,
            def,
            globalMw,
            isRouter(sub) ? NO_WS_HANDLERS : sub.wsRoutes,
          );
          continue;
        }
        // The def's OWN prefix middleware (baked when the sub-app itself
        // mounted a router) runs INSIDE this app's sub-global — dropping it
        // here silently stripped every inner router's use() middleware on a
        // nested remount. Inner first, wrapping sub-global after.
        registerDef(router, def.method, path, def.handlers, def.name, globalMw, [
          ...(def.prefixMiddleware ?? []),
          ...subGlobal,
        ]);
      }
      return app;
    },

    redirect(source, destination, code = 301) {
      registerRedirect(router, source, destination, code, globalMw);
      return app;
    },

    url: (name, params = Object.create(null)) => urlFor(router, name, params),
    route: (name) => routePathOf(router, name),

    notFound(handler) {
      notFoundHandler = handler;
      return app;
    },

    decorate(key, value) {
      decorateContext(key, value, app);
      return app;
    },

    handle(request, runtime) {
      const recycled = pool?.acquire();
      const c =
        recycled === undefined
          ? createContext(app, contextProto, request, runtime)
          : resetContext(recycled, request, runtime);

      const dispatchOf = (): Response | Promise<Response> => {
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
      };

      pool ??= createPool(app, contextProto);
      if (!poolingEnabled) return dispatchOf();
      // Guarded lifecycle: settle (sync or async), then retire to the pool —
      // a late write on the retired context throws instead of corrupting it.
      // Bodies retire through retireWithBody (consumed after handle returns).
      const activePool = pool;
      const release = (value: Response): Response => retireWithBody(activePool, c, value);
      const settled = dispatchOf();
      return settled instanceof Promise ? settled.then(release) : release(settled);
    },

    callback() {
      return (request, runtime) => app.handle(request, runtime);
    },

    listen(...args) {
      const { listen, hostname, onListen } = parseListenArgs(args);
      nativeRoutesEnabled = listen.nativeRoutes !== false;
      serverHandle = startBunServer(
        app,
        { ...listen, ...(hostname !== undefined ? { hostname } : {}) },
        onListen,
      );
      return serverHandle;
    },

    onerror(error, c) {
      // Koa-contract hook — implementation in dispatch.ts (onAppError).
      onAppError(app, emitter, error, c);
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
