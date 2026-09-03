/**
 * The `new Keala()` shell. Routing selects a precompiled chain before the
 * onion runs; dispatch/finalization remain in the functional core. `handle`
 * is a fetch handler for Bun and Node, while Application is its public type.
 */

import type { AppOptions, Plugin as AppOptionsPlugin, Runtime } from "../types.ts";
import type { SigningKeys } from "../context/cookies.ts";
import type { RequestSettings } from "./context/settings.ts";
import {
  baseContextProto,
  createBoundContext,
  resetContext,
  type Context,
} from "./context/context.ts";
import { createPool, type ContextPool } from "./context/pool.ts";
import { createDecorators, type Decorators } from "./context/decorate.ts";
import {
  createMiddlewareStack,
  middlewareForRoute as middlewareForRegisteredRoute,
  registerMiddleware,
  type MiddlewareStack,
} from "./middleware-stack.ts";
import { dispatchRequest, settleNativeHandle } from "./dispatch.ts";
import {
  mountInto,
  pluginInstallerOf,
  registerRedirect,
  registerWsRoute,
  routeShortcut,
} from "./registration.ts";
import {
  closeApp,
  createLifecycle,
  installSignalBridge,
  normalizeRequestTimeout,
  settleRequest,
  type LifecycleState,
} from "./lifecycle.ts";
import { raceDeadline } from "./lifecycle-deadline.ts";
import { admitRequest } from "./lifecycle-admission.ts";
import { serverOf } from "./server-slot.ts";
import type { CloseOptions, CloseStatus } from "../types.ts";
import {
  createRouterState,
  rebuildChains,
  registerDef,
  urlFor,
  routePathOf,
  type RouteDef,
  type RouteHandler,
  type RouterState,
} from "../router/router.ts";
import { isRouter } from "../router/group.ts";
import type { Router } from "../router/group.ts";
import { parseListenArgs } from "./listen.ts";
import { startBunServer, type ServerHandle } from "../adapters/bun.ts";
import {
  buildNativeRoutes,
  registerSink,
  sinkGuardSpecs,
  type NativeSinkEntry,
  type SunkHandler,
} from "./sink.ts";
import {
  type Application,
  type ErrorMapper,
  type NativeApplication,
  type NotFoundHandler,
  type WebSocketHandlers,
  HANDLE_REQUEST_SOURCE,
} from "./application.ts";
import type { RequestSource } from "./request-source.ts";
import { FLAG_DEV_CHAIN } from "./context/state.ts";

export type {
  Application,
  ErrorMapper,
  NotFoundHandler,
  WebSocketHandlers,
} from "./application.ts";

const defaultNotFound: NotFoundHandler = () => undefined;

export { isRouter };

export class Keala implements NativeApplication {
  readonly env: string;
  readonly proxy: boolean;
  readonly keys: SigningKeys | undefined;
  readonly onStreamError: AppOptions["onStreamError"];
  readonly settings: RequestSettings;
  readonly router: RouterState;
  readonly wsRoutes: Map<string, WebSocketHandlers> = new Map();
  readonly nativeSinks: Map<string, NativeSinkEntry> = new Map();

  // Per-app prototype: decorators never leak into another application.
  #contextProto: object;
  #decorators: Decorators;
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
  // R4.6 lifecycle: the admission gate's state — one in-flight counter for
  // overload capacity, drain completion and `app.inFlight`. The stable
  // per-app settle callback releases it with zero per-request allocation.
  #lifecycle: LifecycleState;
  #settle: (value: Response) => Response;
  // R4.6 request deadline in ms (0 = off; see lifecycle-deadline.ts).
  #requestTimeout: number;

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
    this.#contextProto = Object.assign(Object.create(baseContextProto) as object, {
      appValue: this,
      appSettings: this.settings,
      flags: this.env === "development" ? FLAG_DEV_CHAIN : 0,
    });
    this.#decorators = createDecorators(this.#contextProto);
    this.#errorMapper = undefined;
    this.#poolingEnabled = options.pooling === true;
    this.#lifecycle = createLifecycle(options.overload);
    this.#settle = (value: Response): Response => settleRequest(this.#lifecycle, value);
    this.#requestTimeout = normalizeRequestTimeout(options.requestTimeout);
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
      sinkGuardSpecs(this.router.sunkPaths, this.nativeSinks),
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

  sink(path: string, response: Response | { dir: string } | SunkHandler): Application {
    registerSink(
      this.router,
      this.nativeSinks,
      path,
      response,
      this.#middleware,
      this.#errorMapper !== undefined,
    );
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
    registerWsRoute(
      this.wsRoutes,
      this.router,
      this.#middleware,
      this.#poolingEnabled,
      path,
      handlers,
    );
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
    mountInto(
      this,
      this.wsRoutes,
      this.router,
      this.#middleware,
      this.#poolingEnabled,
      this.nativeSinks.size,
      prefix,
      sub,
    );
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
    const settled = this[HANDLE_REQUEST_SOURCE](request, runtime);
    return settled instanceof Promise ? settled : Promise.resolve(settled);
  }

  [HANDLE_REQUEST_SOURCE](request: RequestSource, runtime?: Runtime): Response | Promise<Response> {
    // R4.6 admission slot, fast path inlined: an unconfigured, non-draining
    // app pays two field loads, one branch and the increment. Anything else
    // (overload arithmetic, queueing, drain refusals) takes the full gate.
    const lc = this.#lifecycle;
    if (!lc.draining && lc.overload === null) {
      lc.inFlight++;
      return this.#serve(request, runtime);
    }
    const admission = admitRequest(lc, request);
    if (admission !== null) {
      // Queued admission resolves null once a slot transfers in.
      return admission instanceof Response
        ? admission
        : admission.then((wake) => (wake === null ? this.#serve(request, runtime) : wake));
    }
    return this.#serve(request, runtime);
  }

  /** Post-admission request pipeline: context, dispatch, settle, deadline. */
  #serve(request: RequestSource, runtime: Runtime | undefined): Response | Promise<Response> {
    const recycled = this.#pool?.acquire();
    const c =
      recycled === undefined
        ? createBoundContext(this.#contextProto, request, runtime)
        : resetContext(recycled, request, runtime);

    const settled = dispatchRequest(this, c, this.router, this.#middleware, request);
    if (this.#poolingEnabled) this.#pool ??= createPool(this, this.#contextProto);
    // Deadline-configured apps pay ONE guarded settle per request (the U2
    // once guard — where r4-4 allocated a settleOnce/releaseOnce pair) plus
    // the race; unconfigured apps (the default) pass the stable callback.
    if (this.#requestTimeout > 0) {
      const settle = (value: Response): Response =>
        c.deadlineAnswered === true ? value : this.#settle(value);
      return raceDeadline(
        this,
        this.#lifecycle,
        c,
        settleNativeHandle(this.#pool, this.#poolingEnabled, c, settled, settle),
        this.#requestTimeout,
      );
    }
    return settleNativeHandle(this.#pool, this.#poolingEnabled, c, settled, this.#settle);
  }

  callback(): (request: Request, runtime?: Runtime) => Promise<Response> {
    return (request, runtime) => this.handle(request, runtime);
  }

  listen(...args: Parameters<Application["listen"]>): ServerHandle {
    if (this.#lifecycle.draining) {
      throw new TypeError("app.listen() after app.close() — the app is shutting down");
    }
    const { listen, hostname, onListen } = parseListenArgs(args);
    this.#nativeRoutesEnabled = listen.nativeRoutes !== false;
    this.#serverHandle = startBunServer(
      this,
      { ...listen, ...(hostname !== undefined ? { hostname } : {}) },
      onListen,
    );
    if (listen.signals === true) installSignalBridge(this);
    return this.#serverHandle;
  }

  /**
   * Graceful stop (R4.6): refuse new requests (503 + `connection: close`),
   * stop accepting connections, wait up to `drain` ms for in-flight
   * requests — including draining streams — then force-close. Idempotent;
   * the same promise is returned on repeat calls; a repeat call with
   * `drain: 0` escalates a running close to force.
   */
  close(options?: CloseOptions): Promise<CloseStatus> {
    return closeApp(this.#lifecycle, serverOf(this), options);
  }

  /** Readiness for LB health endpoints: true once close() has begun. */
  isDraining(): boolean {
    return this.#lifecycle.draining;
  }

  /** Admitted-and-unsettled requests (overload capacity view). */
  get inFlight(): number {
    return this.#lifecycle.inFlight;
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
    // The mapper contract is context-based; sunk function handlers run
    // without one and answer through the builtin funnel — refuse the mix
    // instead of silently diverging (mirrors the use-after-sink guard).
    for (const entry of this.nativeSinks.values()) {
      if ("handler" in entry) {
        throw new TypeError(
          "app.onError() cannot run alongside a sunk function handler — the error mapper contract is context-based and sunk handlers have no context",
        );
      }
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
