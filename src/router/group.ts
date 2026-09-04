/**
 * Standalone route groups — `new Router({ prefix })`.
 *
 * A group registers routes up front and merges into an app at `mount()` time
 * (route-table merge semantics: an unmatched sub-route falls through to the
 * parent app's own routes and not-found handling, unlike fetch-handler mounts
 * which swallow 404s). Router-level `use()` middleware is prepended to every
 * route of the group; `param()` middleware runs for routes capturing `name`.
 */

import {
  assertRedirectCaptures,
  buildURL,
  normalizePrefix,
  redirectTargetSegments,
} from "./router.ts";
import { compilePattern, normalizePath } from "./pattern.ts";
import type { RouteDef, RouteHandler } from "./router.ts";
import type { Application } from "../core/application.ts";

/** Standalone route group: registers routes now, mounts later. */
export class Router {
  #defs: RouteDef[] = [];
  #middleware: RouteHandler[] = [];
  #params = new Map<string, RouteHandler>();
  #named = new Map<string, RouteDef>();
  #prefix: string;

  constructor(options: { prefix?: string } = {}) {
    const raw = options.prefix ?? "";
    if (raw.length > 0 && raw.charCodeAt(0) !== 47 /* "/" */) {
      throw new TypeError(`Router prefix must start with "/": ${JSON.stringify(raw)}`);
    }
    // The SAME canonical form as every other prefix site: "/" (and "") are
    // the identity mount — keeping a bare "/" here manufactured "//path"
    // defs that compilePattern rightly refuses.
    this.#prefix = normalizePrefix(raw);
  }

  #add(method: string, path: string, handlers: RouteHandler[], name?: string): void {
    if (handlers.length === 0) {
      throw new TypeError("Route registration requires at least one handler");
    }
    for (const handler of handlers) {
      if (typeof handler !== "function") {
        throw new TypeError("Route handlers must be functions");
      }
    }
    // compilePattern runs at mount() for group defs — enforce its leading-
    // slash rule eagerly instead of letting `${prefix}${path}` manufacture
    // paths like "/v1users".
    if (path.length > 0 && path.charCodeAt(0) !== 47 /* "/" */) {
      throw new TypeError(`Route path must start with "/": ${JSON.stringify(path)}`);
    }
    const full = `${this.#prefix}${path}` || "/";
    const def: RouteDef = {
      method: method.toUpperCase(),
      path: normalizePath(full),
      // Raw handlers only — router middleware is injected at mount time, so
      // `use()` registered after routes still applies.
      handlers,
      name,
    };
    this.#defs.push(def);
    if (name !== undefined) this.#named.set(name, def);
  }

  #shortcut(
    method: string,
    pathOrName: string,
    pathOrHandler: string | RouteHandler | undefined,
    rest: RouteHandler[],
  ): Router {
    if (typeof pathOrHandler === "string") {
      // (name, path, ...handlers) form.
      this.#add(method, pathOrHandler, rest, pathOrName);
    } else {
      // (path, handler, ...more) — a missing handler lets #add's "at least
      // one handler" guard throw, the same runtime validation the app-level
      // shortcuts surface.
      const handlers = pathOrHandler === undefined ? rest : [pathOrHandler, ...rest];
      this.#add(method, pathOrName, handlers);
    }
    return this;
  }

  get(path: string, ...handlers: RouteHandler[]): Router;
  get(name: string, path: string, ...handlers: RouteHandler[]): Router;
  get(pathOrName: string, pathOrHandler?: string | RouteHandler, ...rest: RouteHandler[]): Router {
    return this.#shortcut("GET", pathOrName, pathOrHandler, rest);
  }
  post(path: string, ...handlers: RouteHandler[]): Router;
  post(name: string, path: string, ...handlers: RouteHandler[]): Router;
  post(pathOrName: string, pathOrHandler?: string | RouteHandler, ...rest: RouteHandler[]): Router {
    return this.#shortcut("POST", pathOrName, pathOrHandler, rest);
  }
  put(path: string, ...handlers: RouteHandler[]): Router;
  put(name: string, path: string, ...handlers: RouteHandler[]): Router;
  put(pathOrName: string, pathOrHandler?: string | RouteHandler, ...rest: RouteHandler[]): Router {
    return this.#shortcut("PUT", pathOrName, pathOrHandler, rest);
  }
  patch(path: string, ...handlers: RouteHandler[]): Router;
  patch(name: string, path: string, ...handlers: RouteHandler[]): Router;
  patch(
    pathOrName: string,
    pathOrHandler?: string | RouteHandler,
    ...rest: RouteHandler[]
  ): Router {
    return this.#shortcut("PATCH", pathOrName, pathOrHandler, rest);
  }
  delete(path: string, ...handlers: RouteHandler[]): Router;
  delete(name: string, path: string, ...handlers: RouteHandler[]): Router;
  delete(
    pathOrName: string,
    pathOrHandler?: string | RouteHandler,
    ...rest: RouteHandler[]
  ): Router {
    return this.#shortcut("DELETE", pathOrName, pathOrHandler, rest);
  }
  head(path: string, ...handlers: RouteHandler[]): Router;
  head(name: string, path: string, ...handlers: RouteHandler[]): Router;
  head(pathOrName: string, pathOrHandler?: string | RouteHandler, ...rest: RouteHandler[]): Router {
    return this.#shortcut("HEAD", pathOrName, pathOrHandler, rest);
  }
  options(path: string, ...handlers: RouteHandler[]): Router;
  options(name: string, path: string, ...handlers: RouteHandler[]): Router;
  options(
    pathOrName: string,
    pathOrHandler?: string | RouteHandler,
    ...rest: RouteHandler[]
  ): Router {
    return this.#shortcut("OPTIONS", pathOrName, pathOrHandler, rest);
  }
  all(path: string, ...handlers: RouteHandler[]): Router;
  all(name: string, path: string, ...handlers: RouteHandler[]): Router;
  all(pathOrName: string, pathOrHandler?: string | RouteHandler, ...rest: RouteHandler[]): Router {
    return this.#shortcut("ALL", pathOrName, pathOrHandler, rest);
  }

  on(method: string, path: string, ...handlers: RouteHandler[]): Router {
    this.#add(method, path, handlers);
    return this;
  }

  use(...mw: RouteHandler[]): Router {
    for (const handler of mw) {
      if (typeof handler !== "function") {
        throw new TypeError("router.use() requires middleware functions");
      }
      this.#middleware.push(handler);
    }
    return this;
  }

  param(name: string, middleware: RouteHandler): Router {
    if (typeof name !== "string" || name.length === 0) {
      throw new TypeError("router.param() requires a parameter name");
    }
    if (typeof middleware !== "function") {
      throw new TypeError("router.param() requires a middleware function");
    }
    this.#params.set(name, middleware);
    return this;
  }

  redirect(source: string, destination: string, code = 301): Router {
    if (!Number.isInteger(code) || code < 300 || code > 399) {
      // Eager contract (same as registration.ts): a bad code would 500 on
      // every request (the c.status setter throws).
      throw new TypeError(`redirect() code must be a 3xx integer, got ${code}`);
    }
    // A destination PATH carrying `:params` is rebuilt from the matched
    // route's captured values (koa-router behavior); absolute URLs and
    // scheme-relative targets are verbatim Locations.
    const destSegments = redirectTargetSegments(destination);
    if (destSegments !== null) assertRedirectCaptures(source, destSegments);
    this.#add("GET", source, [
      (c) => {
        // BUG-1 (0.6.2 review, mirrors registration.ts): pass the code
        // through c.redirect's EXPLICIT branch — the no-code call's
        // isRedirectStatus gate silently rewrote 304/306/309+ to 302.
        // c.params is never null post-R411 (the ?? {} fallback was dead).
        const target = destSegments === null ? destination : buildURL(destSegments, c.params);
        c.redirect(target, code);
      },
    ]);
    return this;
  }

  url(name: string, values: Record<string, string> = Object.create(null)): string {
    const def = this.#named.get(name);
    if (def === undefined) {
      throw new Error(`No route registered under name: ${JSON.stringify(name)}`);
    }
    return buildURL(compilePattern(def.path).segments, values);
  }

  route(name: string): string | undefined {
    return this.#named.get(name)?.path;
  }

  get defs(): readonly RouteDef[] {
    return this.#defs;
  }
  /** Param middleware registered on this router (consumed at mount time). */
  get paramMiddlewares(): ReadonlyMap<string, RouteHandler> {
    return this.#params;
  }
  /** Router-level middleware (applied at mount time, whenever registered). */
  get middleware(): readonly RouteHandler[] {
    return this.#middleware;
  }
}

export const isRouter = (sub: Router | Application): sub is Router =>
  Array.isArray((sub as Router).defs) && !("router" in sub);
