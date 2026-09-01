/**
 * The `new Keala()` shell. Routing selects a precompiled chain before the
 * onion runs; dispatch/finalization remain in the functional core. `handle`
 * is a fetch handler for Bun and Node, while Application is its public type.
 */

import type { AppOptions, Plugin as AppOptionsPlugin, Runtime } from "../types.ts";
import { getPath } from "../utils/url.ts";
import type { SigningKeys } from "../context/cookies.ts";
import type { RequestSettings } from "./context/settings.ts";
import { baseContextProto, createContext, resetContext, type Context } from "./context/context.ts";
import { createPool, type ContextPool } from "./context/pool.ts";
import { createDecorators, type Decorators } from "./context/decorate.ts";
import {
  createMiddlewareStack,
  fallbackMiddlewareForPath,
  hasMiddlewareForPath,
  middlewareForRoute as middlewareForRegisteredRoute,
  rebaseMountedMiddleware,
  registerMiddleware,
  type MiddlewareStack,
} from "./middleware-stack.ts";
import {
  dispatchChain,
  finalizeGuarded,
  mergeMountedWs,
  pluginInstallerOf,
  registerRedirect,
  routeShortcut,
  settleHandle,
  wsUpgradeHandler,
} from "./dispatch.ts";
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
import { isRouter } from "../router/group.ts";
import type { Router } from "../router/group.ts";
import { parseListenArgs } from "./listen.ts";
import { compilePattern } from "../router/pattern.ts";
import { startBunServer, type ServerHandle } from "../adapters/bun.ts";
import { buildNativeRoutes, registerSink, type NativeSinkEntry } from "./sink.ts";
import {
  type Application,
  type ErrorMapper,
  type NotFoundHandler,
  type WebSocketHandlers,
} from "./application.ts";

export type {
  Application,
  ErrorMapper,
  NotFoundHandler,
  WebSocketHandlers,
} from "./application.ts";

const defaultNotFound: NotFoundHandler = () => undefined;

/** Routers carry no ws registrations — mount() reads an empty map for them. */
const NO_WS_HANDLERS: ReadonlyMap<string, WebSocketHandlers> = new Map();

export { isRouter };

export class Keala implements Application {
  readonly env: string;
  readonly proxy: boolean;
  readonly keys: SigningKeys | undefined;
  readonly onStreamError: AppOptions["onStreamError"];
  readonly settings: RequestSettings;
  readonly router: RouterState;
  readonly wsRoutes: Map<string, WebSocketHandlers> = new Map();
  readonly nativeSinks: Map<string, NativeSinkEntry> = new Map();

  // Per-app prototype: decorators never leak into another application.
  #contextProto: object = Object.create(baseContextProto);
  #decorators: Decorators = createDecorators(this.#contextProto);
  // R4.3: single error-mapper slot — a second onError registration throws.
  #errorMapper: ErrorMapper | undefined;
  #middleware: MiddlewareStack = createMiddlewareStack();
  #notFoundHandler: NotFoundHandler = defaultNotFound;
  #serverHandle: ServerHandle | null = null;
  // Sticky: a listen({nativeRoutes: false}) opt-out must survive later
  // sink() calls (they must not silently install a native table).
  #nativeRoutesEnabled = true;
  // Guarded pooling (opt-in): settled contexts retire through a prototype
  // swap; late writes throw instead of corrupting the next request.
  #poolingEnabled: boolean;
  #pool: ContextPool | null = null;

  constructor(options: AppOptions = {}) {
    this.env = options.env ?? process.env["NODE_ENV"] ?? "development";
    this.proxy = options.proxy ?? false;
    this.keys = options.keys;
    this.onStreamError = options.onStreamError;
    this.settings = Object.freeze({
      proxy: options.proxy ?? false,
      proxyIpHeader: options.proxyIpHeader ?? "x-forwarded-for",
      maxIpsCount: options.maxIpsCount,
      subdomainOffset: options.subdomainOffset ?? 2,
    });
    this.router = createRouterState();
    this.#errorMapper = undefined;
    this.#poolingEnabled = options.pooling === true;
    // Dev-only route tracing (DOGFOOD-R1 C4): chains embed a reached-marker
    // so dispatch can warn when global middleware swallows a matched route.
    this.router.devTrace = this.env === "development";
  }

  get stack(): readonly RouteDef[] {
    return this.router.defs;
  }
  get globalMiddleware(): readonly RouteHandler[] {
    return this.#middleware.global;
  }
  middlewareForRoute(path: string, pathOffset = 0): readonly RouteHandler[] {
    return middlewareForRegisteredRoute(this.#middleware, path, pathOffset);
  }
  get notFoundHandler(): NotFoundHandler {
    return this.#notFoundHandler;
  }

  use(...middleware: (RouteHandler | AppOptionsPlugin)[]): Application;
  use(pattern: string, ...middleware: RouteHandler[]): Application;
  use(...args: (string | RouteHandler | AppOptionsPlugin)[]): Application {
    const changed = registerMiddleware(
      this.#middleware,
      this.router.sunkPaths,
      this.nativeSinks.size,
      args,
      pluginInstallerOf,
      this,
    );
    // Late middleware re-composes every route chain — O(routes), a
    // documented setup-time cost.
    if (changed) rebuildChains(this.router, this.#middleware);
    return this;
  }

  get(
    pathOrName: string,
    pathOrHandler?: string | RouteHandler,
    ...rest: RouteHandler[]
  ): Application {
    return routeShortcut(this, this.router, this.#middleware, "GET", [
      pathOrName,
      ...(pathOrHandler !== undefined ? [pathOrHandler] : []),
      ...rest,
    ]);
  }
  post(
    pathOrName: string,
    pathOrHandler?: string | RouteHandler,
    ...rest: RouteHandler[]
  ): Application {
    return routeShortcut(this, this.router, this.#middleware, "POST", [
      pathOrName,
      ...(pathOrHandler !== undefined ? [pathOrHandler] : []),
      ...rest,
    ]);
  }
  put(
    pathOrName: string,
    pathOrHandler?: string | RouteHandler,
    ...rest: RouteHandler[]
  ): Application {
    return routeShortcut(this, this.router, this.#middleware, "PUT", [
      pathOrName,
      ...(pathOrHandler !== undefined ? [pathOrHandler] : []),
      ...rest,
    ]);
  }
  patch(
    pathOrName: string,
    pathOrHandler?: string | RouteHandler,
    ...rest: RouteHandler[]
  ): Application {
    return routeShortcut(this, this.router, this.#middleware, "PATCH", [
      pathOrName,
      ...(pathOrHandler !== undefined ? [pathOrHandler] : []),
      ...rest,
    ]);
  }
  delete(
    pathOrName: string,
    pathOrHandler?: string | RouteHandler,
    ...rest: RouteHandler[]
  ): Application {
    return routeShortcut(this, this.router, this.#middleware, "DELETE", [
      pathOrName,
      ...(pathOrHandler !== undefined ? [pathOrHandler] : []),
      ...rest,
    ]);
  }
  head(
    pathOrName: string,
    pathOrHandler?: string | RouteHandler,
    ...rest: RouteHandler[]
  ): Application {
    return routeShortcut(this, this.router, this.#middleware, "HEAD", [
      pathOrName,
      ...(pathOrHandler !== undefined ? [pathOrHandler] : []),
      ...rest,
    ]);
  }
  options(
    pathOrName: string,
    pathOrHandler?: string | RouteHandler,
    ...rest: RouteHandler[]
  ): Application {
    return routeShortcut(this, this.router, this.#middleware, "OPTIONS", [
      pathOrName,
      ...(pathOrHandler !== undefined ? [pathOrHandler] : []),
      ...rest,
    ]);
  }
  all(
    pathOrName: string,
    pathOrHandler?: string | RouteHandler,
    ...rest: RouteHandler[]
  ): Application {
    return routeShortcut(this, this.router, this.#middleware, "ALL", [
      pathOrName,
      ...(pathOrHandler !== undefined ? [pathOrHandler] : []),
      ...rest,
    ]);
  }
  on(method: string, path: string, ...handlers: RouteHandler[]): Application {
    registerDef(this.router, method, path, handlers, undefined, this.#middleware);
    return this;
  }

  sink(path: string, response: Response | { dir: string }): Application {
    registerSink(this.router, this.nativeSinks, path, response, this.#middleware);
    if (this.#serverHandle !== null && this.#nativeRoutesEnabled) {
      this.#serverHandle.reload({ routes: buildNativeRoutes(this.nativeSinks) });
    }
    return this;
  }

  reloadNativeRoutes(): void {
    if (this.#serverHandle === null) {
      throw new Error("reloadNativeRoutes() requires a running server started via app.listen()");
    }
    if (!this.#nativeRoutesEnabled) {
      throw new Error("reloadNativeRoutes() is disabled by listen({ nativeRoutes: false })");
    }
    this.#serverHandle.reload({ routes: buildNativeRoutes(this.nativeSinks) });
  }

  ws(path: string, handlers: WebSocketHandlers): Application {
    if (this.#poolingEnabled) {
      // Sockets keep this request's context alive for the connection
      // lifetime; pooling would recycle it under the next request.
      throw new TypeError(
        "app.ws() cannot run with pooling: true — sockets retain contexts beyond the request lifetime",
      );
    }
    const routeKey = normalizePrefix(path) || "/";
    // A duplicate would silently shadow the first handlers — refuse it.
    if (this.wsRoutes.has(routeKey)) {
      throw new TypeError(
        `app.ws(${JSON.stringify(routeKey)}) is already registered — a duplicate would shadow it`,
      );
    }
    // The upgrade happens on ANY method hit; register ALL so method-based
    // 405s never interfere. The def carries the ws key so mount() can
    // re-key the registration under its prefix. Registration FIRST — a
    // throwing registerDef (sunk overlap, bad pattern) must not strand the
    // wsRoutes key: the HTTP route would not exist while the key stays
    // occupied, bricking every later registration under it.
    const def = registerDef(
      this.router,
      "ALL",
      routeKey,
      [wsUpgradeHandler(routeKey)],
      undefined,
      this.#middleware,
    );
    this.wsRoutes.set(routeKey, handlers);
    def.wsKey = routeKey;
    return this;
  }

  param(name: string, middleware: RouteHandler): Application {
    if (typeof name !== "string" || name.length === 0) {
      throw new TypeError("app.param() requires a parameter name");
    }
    if (typeof middleware !== "function") {
      throw new TypeError("app.param() requires a middleware function");
    }
    if (this.nativeSinks.size > 0) {
      throw new TypeError(
        "app.param() cannot run alongside sunk routes — the native routing table bypasses param middleware",
      );
    }
    this.router.paramMiddlewares.set(name, middleware);
    // Existing routes capturing this param pick it up on rebuild.
    rebuildChains(this.router, this.#middleware);
    return this;
  }

  mount(prefix: string, sub: Router | Application): Application {
    if (sub === this) {
      throw new TypeError("app.mount() cannot mount an app into itself");
    }
    // "/" (and "") mount at the root without doubling slashes.
    const base =
      prefix === "/" || prefix === ""
        ? ""
        : prefix.endsWith("/") && prefix.length > 1
          ? prefix.slice(0, -1)
          : prefix;
    const mountOffset = compilePattern(base || "/").segments.length;
    // Snapshot: registering into this app must not alias the live array
    // being iterated (self-referential mounts would otherwise grow forever).
    const defs = [...(isRouter(sub) ? sub.defs : sub.router.defs)];
    const paramMiddlewares = isRouter(sub) ? sub.paramMiddlewares : sub.router.paramMiddlewares;
    if (this.nativeSinks.size > 0 && paramMiddlewares.size > 0) {
      throw new TypeError(
        "app.mount() cannot introduce param middleware alongside sunk routes — the native routing table bypasses it",
      );
    }
    // A mounted app (or router) carries its own middleware ahead of its routes.
    let mergedParams = false;
    for (const [name, handler] of paramMiddlewares) {
      if (!this.router.paramMiddlewares.has(name)) {
        this.router.paramMiddlewares.set(name, handler);
        mergedParams = true;
      }
    }
    // Same contract as app.param(): newly merged param middleware must reach
    // routes registered BEFORE the mount, not only later ones — one rebuild.
    if (mergedParams) rebuildChains(this.router, this.#middleware);
    for (const def of defs) {
      const path = `${base}${def.path}` || "/";
      const subMiddleware = isRouter(sub)
        ? sub.middleware
        : sub.middlewareForRoute(def.path, mountOffset);
      const mountedMiddleware = [
        ...rebaseMountedMiddleware(def.prefixMiddleware ?? [], mountOffset),
        ...subMiddleware,
      ];
      // ws registrations re-key under the mount (see mergeMountedWs — an
      // empty source map makes its own guard throw for router-typed subs).
      if (def.wsKey !== undefined) {
        // The app.ws() pooling guard, enforced on the mount path too: the
        // socket keeps this request's context alive for the connection
        // lifetime, which pooling would recycle under the next request.
        if (this.#poolingEnabled) {
          throw new TypeError(
            "app.mount() cannot introduce ws routes into a pooling: true app — sockets retain contexts beyond the request lifetime",
          );
        }
        mergeMountedWs(
          this.wsRoutes,
          this.router,
          path,
          mountedMiddleware,
          def,
          this.#middleware,
          isRouter(sub) ? NO_WS_HANDLERS : sub.wsRoutes,
        );
        continue;
      }
      // The def's OWN prefix middleware (baked when the sub-app itself
      // mounted a router) runs INSIDE this app's mounted middleware — dropping
      // here silently stripped every inner router's use() middleware on a
      // nested remount. Inner first, wrapping mounted middleware after.
      registerDef(this.router, def.method, path, def.handlers, def.name, this.#middleware, [
        ...mountedMiddleware,
      ]);
    }
    return this;
  }

  redirect(source: string, destination: string, code = 301): Application {
    registerRedirect(this.router, source, destination, code, this.#middleware);
    return this;
  }

  url(name: string, params: Record<string, string> = Object.create(null)): string {
    return urlFor(this.router, name, params);
  }
  route(name: string): string | undefined {
    return routePathOf(this.router, name);
  }

  notFound(handler: NotFoundHandler): Application {
    this.#notFoundHandler = handler;
    return this;
  }

  decorate(key: string, value: unknown): Application {
    this.#decorators.decorate(key, value, this);
    return this;
  }

  decorateLazy(key: string, getter: (this: Context) => unknown): Application {
    this.#decorators.decorateLazy(key, getter as (this: never) => unknown, this);
    return this;
  }

  handle(request: Request, runtime?: Runtime): Promise<Response> {
    const recycled = this.#pool?.acquire();
    const c =
      recycled === undefined
        ? createContext(this, this.#contextProto, request, runtime)
        : resetContext(recycled, request, runtime);

    const dispatchOf = (): Response | Promise<Response> => {
      const path = getPath(request.url);
      const match = matchRoute(this.router, path);
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
        if (chain !== undefined) {
          // Dev tracing only (DOGFOOD-R1 C4 swallow + R2 C2 stall): one
          // small object per request in dev; `marked` mirrors whether the
          // route-reached marker is compiled in (global middleware exists).
          return dispatchChain(
            this,
            c,
            chain,
            this.router.devTrace
              ? { method, path, marked: hasMiddlewareForPath(this.#middleware, path) }
              : undefined,
          );
        }
        for (const allowed of match.target.allowed) c.routerAllowed.add(allowed);
      }
      // No handler: global middleware still runs (koa contract), then the
      // finalizer decides between 405/501/OPTIONS and not-found.
      const fallback = fallbackMiddlewareForPath(this.#middleware, path);
      if (fallback === null) return finalizeGuarded(this, c);
      return dispatchChain(this, c, fallback);
    };

    this.#pool ??= createPool(this, this.#contextProto);
    return settleHandle(this.#pool, this.#poolingEnabled, c, dispatchOf);
  }

  callback(): (request: Request, runtime?: Runtime) => Promise<Response> {
    return (request, runtime) => this.handle(request, runtime);
  }

  listen(...args: Parameters<Application["listen"]>): ServerHandle {
    const { listen, hostname, onListen } = parseListenArgs(args);
    this.#nativeRoutesEnabled = listen.nativeRoutes !== false;
    this.#serverHandle = startBunServer(
      this,
      { ...listen, ...(hostname !== undefined ? { hostname } : {}) },
      onListen,
    );
    return this.#serverHandle;
  }

  toJSON(): { env: string; proxy: boolean } {
    return { env: this.env, proxy: this.proxy };
  }

  get errorMapper(): ErrorMapper | undefined {
    return this.#errorMapper;
  }

  onError(mapper: ErrorMapper): Application {
    if (typeof mapper !== "function") {
      throw new TypeError("app.onError() requires a function");
    }
    if (this.#errorMapper !== undefined) {
      throw new TypeError(
        "app.onError() is already registered — compose inside one handler instead",
      );
    }
    this.#errorMapper = mapper;
    return this;
  }
}
