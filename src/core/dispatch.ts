/**
 * Request dispatch helpers: guarded finalization, the error response builder
 * and listen-argument parsing. Extracted from app.ts for the 500-line budget.
 */

import type { Application } from "./app.ts";
import type { Chain, RouteHandler, RouterState } from "../router/router.ts";
import { EMPTY_PARAMS, matchRoute } from "../router/router.ts";
import { splitPathSearch } from "../utils/url.ts";
import { isEmptyStatus } from "../http/status.ts";
import { DIRECT_HANDLER, NOOP_TAIL, type HandlerResult } from "./compose.ts";
import type { Context } from "./context/context.ts";
import {
  fallbackMiddlewareForPath,
  hasMiddlewareForPath,
  type MiddlewareStack,
} from "./middleware-stack.ts";
import { FLAG_CHAIN_STALLED, FLAG_ROUTE_REACHED } from "./context/state.ts";
import { retireWithBody, type ContextPool } from "./context/pool.ts";
import { errorResponse } from "./error-response.ts";
import { finalize } from "./respond.ts";
import type { RequestSource } from "./request-source.ts";
import { sourceMethod, sourceUrl } from "./request-source.ts";

/**
 * Finalize behind the never-reject guard: a failing finalizer (unserializable
 * bodies, throwing not-found handlers, bad headers) answers 500 instead of
 * rejecting past `app.handle`.
 */
export const finalizeGuarded = (app: Application, c: Context): Response | Promise<Response> => {
  try {
    // finalize is synchronous by construction (its stream wrapper is built
    // synchronously inside new Response) — the union only documents shape.
    return finalize(app, c);
  } catch (err) {
    return errorResponse(app, c, err);
  }
};

/**
 * The `app.handle` boundary (DOGFOOD-R1 C1): run the dispatcher, retire a
 * pooling context through its body-safe wrapper, and ALWAYS hand back a
 * Promise — the sync fast paths stay internal, the public contract settles
 * uniformly (a bare sync `Response` cost every consumer the
 * `Response | Promise<Response>` union). Never throws, never rejects: the
 * dispatcher's own guards already answer error Responses.
 */
/**
 * Native adapters keep synchronous chains synchronous; public handle wraps once.
 * The optional `release` slot (R4.6) rides the SAME settle tail — during
 * drain a bodied response holds its in-flight slot until consumed, and a
 * deadline zombie (504 already answered, `c.deadlineAnswered`) releases
 * capacity without retiring into the pool: the live handler still holds
 * the context, so it goes to GC instead of the next request.
 */
export const settleNativeHandle = (
  pool: ContextPool | null,
  pooling: boolean,
  c: Context,
  settled: Response | Promise<Response>,
  release?: (value: Response) => Response,
): Response | Promise<Response> => {
  if (!pooling) {
    if (release === undefined) return settled;
    // Capacity release rides the callback (deadline-configured apps pass a
    // guarded settle — the zombie's late release dies THERE, at settle time).
    return settled instanceof Promise ? settled.then(release) : release(settled);
  }
  if (pool === null) throw new TypeError("pooling dispatch requires a context pool");
  // Guarded lifecycle: settle (sync or async), then retire to the pool — a
  // late write on the retired context throws instead of corrupting it. The
  // drain-hold wraps INSIDE the retirement wrapper so a draining close
  // observes stream completion at the consumer's pace, not the producer's.
  // A deadline zombie's late settle (checked at SETTLE time — the flag can
  // only flip after dispatch parked) skips retirement: the live handler
  // still holds the context, so it goes to GC instead of the next request.
  if (release === undefined) {
    if (settled instanceof Promise) {
      return settled.then((value) =>
        c.deadlineAnswered === true ? value : retireWithBody(pool, c, value),
      );
    }
    return retireWithBody(pool, c, settled);
  }
  if (settled instanceof Promise) {
    return settled.then((value) =>
      c.deadlineAnswered === true ? value : retireWithBody(pool, c, release(value)),
    );
  }
  return retireWithBody(pool, c, release(settled));
};

/** Dev-only trace of which matched route a chain was dispatched for.
 * `marked` = the R1 route-reached marker is compiled into this chain
 * (global middleware exists); without it the swallow check is skipped —
 * the marker could never have been set. */
export interface RouteTrace {
  method: string;
  path: string;
  marked: boolean;
}

/** One swallowed-route/stalled-chain warning per (app, method, path). */
const swallowWarned = new WeakMap<Application, Set<string>>();

const warnOnce = (app: Application, key: string, message: string): boolean => {
  let seen = swallowWarned.get(app);
  if (seen === undefined) {
    seen = new Set<string>();
    swallowWarned.set(app, seen);
  }
  if (seen.has(key)) return false;
  seen.add(key);
  console.warn(message);
  return true;
};

/**
 * Dev-only (DOGFOOD-R1 C4): the koa contract compiles global middleware INTO
 * every route chain, so a middleware that returns without calling next()
 * keeps the route's handlers from ever running — which reads as "my route
 * 404s" to anyone arriving with a routing-first mental model. Fires on the
 * success path only: a thrown rejection (c.throw / throw) is an intentional
 * koa pattern and stays silent. Production/test chains never compile the
 * marker, so the flags check alone is the whole prod cost (one AND).
 * Returns true when it warned (the R2 stall warning then stays silent —
 * same root cause, better message).
 */
const warnIfSwallowed = (app: Application, c: Context, trace: RouteTrace): boolean => {
  if (!trace.marked || (c.flags & FLAG_ROUTE_REACHED) !== 0) return false;
  return warnOnce(
    app,
    `${trace.method} ${trace.path}`,
    `keala(dev): ${trace.method} ${trace.path} matched a route but its handler never ran — global middleware returned before calling next(). Call next() for requests you don't handle, or use c.throw() to reject intentionally.`,
  );
};

/**
 * Dev-only (DOGFOOD-R2 C2): a NON-terminal middleware (route-scoped or
 * Router.use prefix — positions the R1 warning cannot see) settled with
 * void, never called next(), and nothing in the chain produced a response:
 * the request is heading for a silent notFound 404. Legit shapes stay
 * silent: a terminal handler's void return IS the contract, state-style
 * responses without next() set the response, throws take the error path.
 */
const warnIfStalled = (app: Application, c: Context, trace: RouteTrace): void => {
  if (
    (c.flags & FLAG_CHAIN_STALLED) === 0 ||
    c._res !== undefined ||
    (c.flags & 1) !== 0 ||
    c.bodyValue !== null
  ) {
    return;
  }
  warnOnce(
    app,
    `${trace.method} ${trace.path}`,
    `keala(dev): ${trace.method} ${trace.path} stalled without a response — a middleware returned before calling next() and no handler ran, so keala answers 404. Every non-terminal middleware must call next() or produce a response.`,
  );
};

/** Run the compiled chain and finalize; never rethrows to the caller. */
export const dispatchChain = (
  app: Application,
  c: Context,
  chain: Chain,
  trace?: RouteTrace,
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
  // The swallow warning runs BEFORE finalize (finalize reads flags, never
  // resets them — but check-first keeps the order irrelevant).
  // Fully synchronous middleware chains settle without a single promise.
  if (settled !== undefined && typeof (settled as PromiseLike<void>).then === "function") {
    return (settled as Promise<void>).then(
      () => finishDispatch(app, c, trace),
      (err: unknown) => errorResponse(app, c, err),
    );
  }
  return finishDispatch(app, c, trace);
};

/**
 * A route with one handler and no middleware has no downstream observer that
 * could mutate its committed response. Return a valid Response immediately;
 * state-style/HEAD/error cases still enter the full finalizer. This removes
 * the commit slot and a second finalization pass from the dominant endpoint
 * shape without weakening onion semantics anywhere they can exist.
 */
const dispatchDirect = (
  app: Application,
  c: Context,
  handler: RouteHandler,
  method: string,
): Response | Promise<Response> => {
  const finish = (result: HandlerResult): Response | Promise<Response> => {
    try {
      if (result === undefined || result === null) return finalizeGuarded(app, c);
      if (!(result instanceof Response)) {
        if (typeof (result as PromiseLike<unknown>).then === "function") {
          return errorResponse(
            app,
            c,
            new TypeError("handler returned a promise — await it inside the handler instead"),
          );
        }
        return errorResponse(
          app,
          c,
          new TypeError(
            `handler returned ${typeof result}; only Response, undefined or null are valid`,
          ),
        );
      }
      if (
        c.headersRecord === null &&
        method !== "HEAD" &&
        !(isEmptyStatus(result.status) && result.body !== null)
      ) {
        return result;
      }
      c._res = result;
      return finalizeGuarded(app, c);
    } catch (error) {
      return errorResponse(app, c, error);
    }
  };
  try {
    const result = handler(c, NOOP_TAIL);
    if (result instanceof Promise) {
      return result.then(finish, (error: unknown) => errorResponse(app, c, error));
    }
    // Sync fast path: no closure was needed — finish would only allocate
    // one per sync request for nothing (~3-5ns + 64B each).
    try {
      if (result === undefined || result === null) return finalizeGuarded(app, c);
      if (!(result instanceof Response)) {
        if (typeof (result as PromiseLike<unknown>).then === "function") {
          return errorResponse(
            app,
            c,
            new TypeError("handler returned a promise — await it inside the handler instead"),
          );
        }
        return errorResponse(
          app,
          c,
          new TypeError(
            `handler returned ${typeof result}; only Response, undefined or null are valid`,
          ),
        );
      }
      if (
        c.headersRecord === null &&
        method !== "HEAD" &&
        !(isEmptyStatus(result.status) && result.body !== null)
      ) {
        return result;
      }
      c._res = result;
      return finalizeGuarded(app, c);
    } catch (error) {
      return errorResponse(app, c, error);
    }
  } catch (error) {
    return errorResponse(app, c, error);
  }
};

const finishDispatch = (
  app: Application,
  c: Context,
  trace: RouteTrace | undefined,
): Response | Promise<Response> => {
  if (trace !== undefined && !warnIfSwallowed(app, c, trace)) {
    warnIfStalled(app, c, trace);
  }
  return finalizeGuarded(app, c);
};

/**
 * Match and dispatch one request without manufacturing a request-local
 * closure in `Application.handle`. Registration has already selected and
 * compiled each route's applicable middleware; request time only chooses the
 * chain or the precompiled fallback.
 */
export const dispatchRequest = (
  app: Application,
  c: Context,
  router: RouterState,
  middleware: MiddlewareStack,
  request: RequestSource,
): Response | Promise<Response> => {
  const rawUrl = sourceUrl(request);
  // One pass yields both the match path and the context's path+search view
  // (R413: getPath + getSearch paid two scans). First-touch c.path/c.url
  // reads stay memo reads; a later rewrite invalidates both.
  const [path, search] = splitPathSearch(rawUrl);
  c.pathValue = path;
  c.urlValue = search.length === 0 ? path : path + search;
  const match = matchRoute(router, path);
  if (match !== null) {
    c.params = match.params ?? EMPTY_PARAMS;
    // Matched-pattern facts (R411 Fix 4), published beside params: visible
    // to every chain layer, the 405 path below and post-next() observers —
    // metrics labels and span names get the route TEMPLATE, never the
    // high-cardinality raw path.
    c.routePath = match.target.pattern;
    c.routeName = match.target.name;
    const rawMethod = sourceMethod(request);
    const method = rawMethod === "GET" ? "GET" : rawMethod.toUpperCase();
    // Express-style convenience: HEAD falls back to the GET handler.
    const chain =
      (match.target.methods.get(method) as Chain | undefined) ??
      (method === "HEAD" ? (match.target.methods.get("GET") as Chain | undefined) : undefined) ??
      (match.target.methods.get("ALL") as Chain | undefined);
    if (chain !== undefined) {
      const directHandler = chain[DIRECT_HANDLER];
      if (directHandler !== undefined) {
        return dispatchDirect(app, c, directHandler, method);
      }
      return dispatchChain(
        app,
        c,
        chain,
        router.devTrace
          ? { method, path, marked: hasMiddlewareForPath(middleware, path) }
          : undefined,
      );
    }
    for (const allowed of match.target.allowed) c.routerAllowed.add(allowed);
  }
  // No handler: global middleware still runs (koa contract), then the
  // finalizer decides between 405/501/OPTIONS and not-found.
  const fallback = fallbackMiddlewareForPath(middleware, path);
  return fallback === null ? finalizeGuarded(app, c) : dispatchChain(app, c, fallback);
};
