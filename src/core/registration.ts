/**
 * Setup-time registration helpers (extracted from dispatch.ts for the
 * 500-line budget): route shortcuts, redirects, websocket routes and the
 * mount merge — everything that mutates the router BEFORE a request runs.
 */

import type { Application, WebSocketHandlers } from "./app.ts";
import type { RouteDef, RouteHandler, RouterState } from "../router/router.ts";
import {
  assertRedirectCaptures,
  buildURL,
  normalizePrefix,
  redirectTargetSegments,
  rebuildChains,
  registerDef,
} from "../router/router.ts";
import { isRouter, type Router } from "../router/group.ts";
import { compilePattern } from "../router/pattern.ts";
import { rebaseMountedMiddleware, type MiddlewareStack } from "./middleware-stack.ts";

/** A plugin is any object exposing `install(app)`; middleware is not one. */
export const pluginInstallerOf = (value: unknown): ((app: Application) => void) | null => {
  if (typeof value !== "object" || value === null) return null;
  const install = (value as { install?: unknown }).install;
  return typeof install === "function"
    ? (value as { install: (a: Application) => void }).install
    : null;
};

/** Shared body of the app.get/post/… shortcuts (named and unnamed forms). */
export const routeShortcut = (
  app: Application,
  router: RouterState,
  middleware: MiddlewareStack,
  method: string,
  args: unknown[],
): Application => {
  const [first, second, ...rest] = args as [string, string | RouteHandler, ...RouteHandler[]];
  if (typeof first !== "string") {
    throw new TypeError("Route registration requires a path string");
  }
  if (typeof second === "string") {
    registerDef(router, method, second, rest as RouteHandler[], first, middleware);
  } else if (typeof second === "function") {
    registerDef(router, method, first, [second, ...rest], undefined, middleware);
  } else {
    throw new TypeError("Route registration requires at least one handler");
  }
  return app;
};

/**
 * Register a redirect route (GET): a destination PATH carrying `:params` is
 * rebuilt from the matched route's captured params; anything the source does
 * not capture is a registration error, never a per-request 500.
 */
export const registerRedirect = (
  router: RouterState,
  source: string,
  destination: string,
  code: number,
  middleware: MiddlewareStack,
): void => {
  const destSegments = redirectTargetSegments(destination);
  if (destSegments !== null) assertRedirectCaptures(source, destSegments);
  registerDef(
    router,
    "GET",
    source,
    [
      (c) => {
        const target = destSegments === null ? destination : buildURL(destSegments, c.params ?? {});
        c.status = code;
        c.redirect(target);
      },
    ],
    undefined,
    middleware,
  );
};

/**
 * The handler behind every `app.ws()` route: upgrades through the runtime
 * server handle. The context rides the socket data so ws event handlers
 * receive `c`; Bun ignores the fetch return value and the spec forbids a
 * 101 Response, so a null Response stands in.
 */
export const wsUpgradeHandler =
  (wsKey: string): RouteHandler =>
  (c) => {
    const server = c.runtime?.server as
      | { upgrade?(req: Request, opts?: { data?: unknown }): boolean }
      | undefined;
    if (server === undefined || typeof server?.upgrade !== "function") {
      c.throw(501, "websocket upgrades require a Bun server runtime", { expose: true });
    }
    const ok = (server as { upgrade(r: Request, o: { data: unknown }): boolean }).upgrade(c.raw, {
      data: { wsKey, ctx: c },
    });
    if (!ok) {
      c.throw(400, "websocket upgrade rejected");
    }
    return new Response(null);
  };

/**
 * Merge one mounted ws registration under the mount prefix: the copied def's
 * upgrade handler closes over the OLD route key, so a fresh handler bound to
 * the prefixed key is registered and the socket handlers travel with it.
 * Duplicate keys are refused exactly like app.ws() does.
 */
export const mergeMountedWs = (
  wsRoutes: Map<string, WebSocketHandlers>,
  router: RouterState,
  path: string,
  mountedMiddleware: readonly RouteHandler[],
  def: RouteDef,
  middleware: MiddlewareStack,
  handlers: ReadonlyMap<string, WebSocketHandlers>,
): void => {
  const socketHandlers = def.wsKey === undefined ? undefined : handlers.get(def.wsKey);
  if (socketHandlers === undefined) {
    throw new TypeError(`mount(): no ws handlers found for ${JSON.stringify(def.wsKey)}`);
  }
  const newKey = normalizePrefix(path) || "/";
  if (wsRoutes.has(newKey)) {
    throw new TypeError(
      `app.ws(${JSON.stringify(newKey)}) is already registered — a duplicate would shadow it`,
    );
  }
  // Registration FIRST, key claim SECOND (same transactionality rule as
  // app.ws(): a throwing registerDef must not strand the wsRoutes key).
  const rekeyed = registerDef(
    router,
    def.method,
    path,
    [wsUpgradeHandler(newKey)],
    def.name,
    middleware,
    mountedMiddleware,
  );
  wsRoutes.set(newKey, socketHandlers);
  // Same merge contract as the non-ws mount path: the def's own prefix
  // middleware (baked by a nested mount of the sub-app) survives the
  // re-key, running inside the mounted app's applicable middleware.
  rekeyed.wsKey = newKey;
};

/**
 * app.ws() body (extracted for the app.ts line budget): register the
 * ALL-method upgrade route plus its socket handlers, refusing duplicates.
 */
export const registerWsRoute = (
  wsRoutes: Map<string, WebSocketHandlers>,
  router: RouterState,
  middleware: MiddlewareStack,
  poolingEnabled: boolean,
  path: string,
  handlers: WebSocketHandlers,
): void => {
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
  // The upgrade happens on ANY method hit; register ALL so method-based
  // 405s never interfere. The def carries the ws key so mount() can
  // re-key the registration under its prefix. Registration FIRST — a
  // throwing registerDef (sunk overlap, bad pattern) must not strand the
  // wsRoutes key: the HTTP route would not exist while the key stays
  // occupied, bricking every later registration under it.
  const def = registerDef(
    router,
    "ALL",
    routeKey,
    [wsUpgradeHandler(routeKey)],
    undefined,
    middleware,
  );
  wsRoutes.set(routeKey, handlers);
  def.wsKey = routeKey;
};

/** Routers carry no ws registrations — mountInto reads an empty map for them. */
const NO_WS_HANDLERS: ReadonlyMap<string, WebSocketHandlers> = new Map();

/**
 * app.mount() body (extracted for the app.ts line budget): merge a
 * sub-router's routes (or another app's) under a prefix.
 */
export const mountInto = (
  app: Application,
  wsRoutes: Map<string, WebSocketHandlers>,
  router: RouterState,
  middleware: MiddlewareStack,
  poolingEnabled: boolean,
  nativeSinkCount: number,
  prefix: string,
  sub: Router | Application,
): void => {
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
  const mountOffset = compilePattern(base || "/").segments.length;
  // Snapshot: registering into this app must not alias the live array
  // being iterated (self-referential mounts would otherwise grow forever).
  const defs = [...(isRouter(sub) ? sub.defs : sub.router.defs)];
  const paramMiddlewares = isRouter(sub) ? sub.paramMiddlewares : sub.router.paramMiddlewares;
  if (nativeSinkCount > 0 && paramMiddlewares.size > 0) {
    throw new TypeError(
      "app.mount() cannot introduce param middleware alongside sunk routes — the native routing table bypasses it",
    );
  }
  // A mounted app (or router) carries its own middleware ahead of its routes.
  let mergedParams = false;
  for (const [name, handler] of paramMiddlewares) {
    if (!router.paramMiddlewares.has(name)) {
      router.paramMiddlewares.set(name, handler);
      mergedParams = true;
    }
  }
  // Same contract as app.param(): newly merged param middleware must reach
  // routes registered BEFORE the mount, not only later ones — one rebuild.
  if (mergedParams) rebuildChains(router, middleware);
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
      if (poolingEnabled) {
        throw new TypeError(
          "app.mount() cannot introduce ws routes into a pooling: true app — sockets retain contexts beyond the request lifetime",
        );
      }
      mergeMountedWs(
        wsRoutes,
        router,
        path,
        mountedMiddleware,
        def,
        middleware,
        isRouter(sub) ? NO_WS_HANDLERS : sub.wsRoutes,
      );
      continue;
    }
    // The def's OWN prefix middleware (baked when the sub-app itself
    // mounted a router) runs INSIDE this app's mounted middleware — dropping
    // here silently stripped every inner router's use() middleware on a
    // nested remount. Inner first, wrapping mounted middleware after.
    registerDef(router, def.method, path, def.handlers, def.name, middleware, [
      ...mountedMiddleware,
    ]);
  }
};
