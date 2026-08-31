/**
 * Standalone route groups — `createRouter({ prefix })`.
 *
 * A group registers routes up front and merges into an app at `mount()` time
 * (route-table merge semantics: an unmatched sub-route falls through to the
 * parent app's own routes and not-found handling, unlike fetch-handler mounts
 * which swallow 404s). Router-level `use()` middleware is prepended to every
 * route of the group; `param()` middleware runs for routes capturing `name`.
 */

import { buildURL, redirectTargetSegments } from "./router.ts";
import { compilePattern } from "./pattern.ts";
import type { RouteDef, RouteHandler } from "./router.ts";
/** Standalone route group: registers routes now, mounts later. */
export interface Router {
  get(path: string, ...handlers: RouteHandler[]): Router;
  get(name: string, path: string, ...handlers: RouteHandler[]): Router;
  post(path: string, ...handlers: RouteHandler[]): Router;
  post(name: string, path: string, ...handlers: RouteHandler[]): Router;
  put(path: string, ...handlers: RouteHandler[]): Router;
  put(name: string, path: string, ...handlers: RouteHandler[]): Router;
  patch(path: string, ...handlers: RouteHandler[]): Router;
  patch(name: string, path: string, ...handlers: RouteHandler[]): Router;
  delete(path: string, ...handlers: RouteHandler[]): Router;
  delete(name: string, path: string, ...handlers: RouteHandler[]): Router;
  head(path: string, ...handlers: RouteHandler[]): Router;
  head(name: string, path: string, ...handlers: RouteHandler[]): Router;
  options(path: string, ...handlers: RouteHandler[]): Router;
  options(name: string, path: string, ...handlers: RouteHandler[]): Router;
  all(path: string, ...handlers: RouteHandler[]): Router;
  all(name: string, path: string, ...handlers: RouteHandler[]): Router;
  on(method: string, path: string, ...handlers: RouteHandler[]): Router;
  /** Middleware prepended to every route of this router. */
  use(...middleware: RouteHandler[]): Router;
  /** Per-parameter middleware, run for routes that capture `name`. */
  param(name: string, middleware: RouteHandler): Router;
  redirect(source: string, destination: string, code?: number): Router;
  url(name: string, params?: Record<string, string>): string;
  route(name: string): string | undefined;
  readonly defs: readonly RouteDef[];
  /** Param middleware registered on this router (consumed at mount time). */
  readonly paramMiddlewares: ReadonlyMap<string, RouteHandler>;
  /** Router-level middleware (applied at mount time, whenever registered). */
  readonly middleware: readonly RouteHandler[];
}

import type { Application } from "../core/app.ts";

/** Create a standalone router: `const api = createRouter({ prefix: "/v1" })`. */
export const createRouter = (options: { prefix?: string } = {}): Router => {
  const defs: RouteDef[] = [];
  const middleware: RouteHandler[] = [];
  const params = new Map<string, RouteHandler>();
  const named = new Map<string, RouteDef>();
  let prefix = options.prefix ?? "";
  if (prefix.length > 1 && prefix.endsWith("/")) prefix = prefix.slice(0, -1);

  const add = (method: string, path: string, handlers: RouteHandler[], name?: string): void => {
    if (handlers.length === 0) {
      throw new TypeError("Route registration requires at least one handler");
    }
    for (const handler of handlers) {
      if (typeof handler !== "function") {
        throw new TypeError("Route handlers must be functions");
      }
    }
    const full = `${prefix}${path}` || "/";
    const def: RouteDef = {
      method: method.toUpperCase(),
      path: full.length > 1 && full.endsWith("/") ? full.slice(0, -1) : full,
      // Raw handlers only — router middleware is injected at mount time, so
      // `use()` registered after routes still applies.
      handlers,
      name,
    };
    defs.push(def);
    if (name !== undefined) named.set(name, def);
  };

  const shortcut =
    (method: string) =>
    (pathOrName: string, pathOrHandler: string | RouteHandler, ...rest: RouteHandler[]): Router => {
      if (typeof pathOrHandler === "string") {
        add(method, pathOrHandler, rest, pathOrName);
      } else {
        add(method, pathOrName, [pathOrHandler, ...rest]);
      }
      return router;
    };

  const urlOf = (name: string, values: Record<string, string>): string => {
    const def = named.get(name);
    if (def === undefined) {
      throw new Error(`No route registered under name: ${JSON.stringify(name)}`);
    }
    return buildURL(compilePattern(def.path).segments, values);
  };

  const router: Router = {
    get: shortcut("GET"),
    post: shortcut("POST"),
    put: shortcut("PUT"),
    patch: shortcut("PATCH"),
    delete: shortcut("DELETE"),
    head: shortcut("HEAD"),
    options: shortcut("OPTIONS"),
    all: shortcut("ALL"),
    on: (method, path, ...handlers) => {
      add(method, path, handlers);
      return router;
    },
    use(...mw) {
      for (const handler of mw) {
        if (typeof handler !== "function") {
          throw new TypeError("router.use() requires middleware functions");
        }
        middleware.push(handler);
      }
      return router;
    },
    param(name, handler) {
      if (typeof name !== "string" || name.length === 0) {
        throw new TypeError("router.param() requires a parameter name");
      }
      if (typeof handler !== "function") {
        throw new TypeError("router.param() requires a middleware function");
      }
      params.set(name, handler);
      return router;
    },
    redirect(source, destination, code = 301) {
      // A destination PATH carrying `:params` is rebuilt from the matched
      // route's captured values (koa-router behavior); absolute URLs and
      // scheme-relative targets are verbatim Locations.
      const destSegments = redirectTargetSegments(destination);
      add("GET", source, [
        (c) => {
          const target =
            destSegments === null ? destination : buildURL(destSegments, c.params ?? {});
          c.status = code;
          c.redirect(target);
        },
      ]);
      return router;
    },
    url: (name, values = Object.create(null)) => urlOf(name, values),
    route: (name) => named.get(name)?.path,
    get defs(): readonly RouteDef[] {
      return defs;
    },
    get paramMiddlewares(): ReadonlyMap<string, RouteHandler> {
      return params;
    },
    get middleware(): readonly RouteHandler[] {
      return middleware;
    },
  };

  return router;
};

export const isRouter = (sub: Router | Application): sub is Router =>
  Array.isArray((sub as Router).defs) && !("router" in sub);
