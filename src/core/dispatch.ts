/**
 * Request dispatch helpers: guarded finalization, the error response builder
 * and listen-argument parsing. Extracted from app.ts for the 500-line budget.
 */

import type { Application, WebSocketHandlers } from "./app.ts";
import type { Chain, RouteDef, RouteHandler, RouterState } from "../router/router.ts";
import {
  assertRedirectCaptures,
  buildURL,
  normalizePrefix,
  redirectTargetSegments,
  registerDef,
} from "../router/router.ts";
import { NOOP_TAIL } from "./compose.ts";
import type { Context } from "./context/context.ts";
import type { MiddlewareStack } from "./middleware-stack.ts";
import { FLAG_CHAIN_STALLED, FLAG_ROUTE_REACHED } from "./context/state.ts";
import { retireWithBody, type ContextPool } from "./context/pool.ts";
import { finalize, flattenHeaders, stripBody } from "./respond.ts";
import { normalizeError, toHttpError, type HttpError } from "../http/errors.ts";
import { statusMessage } from "../http/status.ts";
import type { HeaderMap } from "../types.ts";

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
 * Console fallback for UNOBSERVED server faults (R4.3 rule 6): request-path
 * errors fire it only when no error mapper is registered (a registered
 * mapper owns observation — silence is then an explicit `app.onError(() => {})`,
 * not a boolean switch). Non-request framework errors (serve/ws runtime)
 * have no mapper context and always use this fallback.
 */
export const consoleFallback = (
  app: Application,
  url: string | undefined,
  error: HttpError,
): void => {
  if (app.env !== "test" && error.status >= 500) {
    console.error(`\n  ${error.stack ?? error.message}\n  at ${url ?? "unknown"}\n`);
  }
};

/**
 * Finalize behind the never-reject guard: a failing finalizer (unserializable
 * bodies, throwing not-found handlers, bad headers) answers 500 instead of
 * rejecting past `app.handle`.
 */
export const finalizeGuarded = (app: Application, c: Context): Response | Promise<Response> => {
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

/**
 * The `app.handle` boundary (DOGFOOD-R1 C1): run the dispatcher, retire a
 * pooling context through its body-safe wrapper, and ALWAYS hand back a
 * Promise — the sync fast paths stay internal, the public contract settles
 * uniformly (a bare sync `Response` cost every consumer the
 * `Response | Promise<Response>` union). Never throws, never rejects: the
 * dispatcher's own guards already answer error Responses.
 */
export const settleHandle = (
  pool: ContextPool,
  pooling: boolean,
  c: Context,
  dispatch: () => Response | Promise<Response>,
): Promise<Response> => {
  let settled: Response | Promise<Response>;
  if (!pooling) {
    settled = dispatch();
  } else {
    // Guarded lifecycle: settle (sync or async), then retire to the pool —
    // a late write on the retired context throws instead of corrupting it.
    // Bodies retire through retireWithBody (consumed after handle returns).
    const release = (value: Response): Response => retireWithBody(pool, c, value);
    const out = dispatch();
    settled = out instanceof Promise ? out.then(release) : release(out);
  }
  return settled instanceof Promise ? settled : Promise.resolve(settled);
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
  const finish = (): Response | Promise<Response> => {
    if (trace !== undefined && !warnIfSwallowed(app, c, trace)) {
      warnIfStalled(app, c, trace);
    }
    return finalizeGuarded(app, c);
  };
  // Fully synchronous middleware chains settle without a single promise.
  if (settled !== undefined && typeof (settled as PromiseLike<void>).then === "function") {
    return (settled as Promise<void>).then(finish, (err: unknown) => errorResponse(app, c, err));
  }
  return finish();
};

const errorResponse = (
  app: Application,
  c: Context,
  err: unknown,
): Response | Promise<Response> => {
  try {
    const out = buildErrorResponse(app, c, err);
    if (out instanceof Promise) {
      return out.catch(() => staticServerError(c.method));
    }
    return out;
  } catch {
    return staticServerError(c.method);
  }
};

/**
 * The absolute last resort. HEAD-aware: a bodied HEAD response desyncs every
 * keep-alive connection (RFC 9110 §9.3.2 — the client would read the body
 * bytes as the next response).
 */
const staticServerError = (method: string | undefined): Response =>
  new Response(method === "HEAD" ? null : "Internal Server Error", {
    status: 500,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof (value as Partial<PromiseLike<unknown>>)?.then === "function";

const buildErrorResponse = (
  app: Application,
  c: Context,
  err: unknown,
): Response | Promise<Response> => {
  // Funnel entry contract (R4.3): everything downstream sees an HttpError —
  // non-HttpError throwables wrap as an unexposed 500 (stack/cause kept).
  const error = toHttpError(err);
  // A stale committed response must not shadow the error. The reset is
  // shared by the built-in and mapper paths; headers the chain already
  // staged ride along (koa parity — security headers must still cover error
  // pages); only content-DESCRIBING headers drop, they describe the body
  // that failed to ship.
  c._res = undefined;
  const record = c.headersRecord;
  if (record !== null) {
    delete record["content-type"];
    delete record["content-length"];
    delete record["transfer-encoding"];
  }
  c.bodyValue = null;
  c.messageValue = "";
  c.flags = 0;

  const mapper = app.errorMapper;
  if (mapper === undefined) {
    consoleFallback(app, c.url, error);
    return builtinErrorResponse(app, c, error);
  }
  // The mapper failure path must stay LOUD: its own bug answers the static
  // 500 AND is console.error'd — an envelope bug must never fail silently.
  const fail = (mapperErr: unknown): Response => {
    const normalized = normalizeError(mapperErr);
    console.error(
      `\n  error mapper failed: ${normalized.stack ?? normalized.message}\n  at ${c.url ?? "unknown"}\n`,
    );
    return staticServerError(c.method);
  };
  try {
    const out = mapper(error, c);
    if (isThenable(out)) {
      return out.then(
        (res) => finalizeMapperResponse(app, c, res, error),
        (mapperErr: unknown) => fail(mapperErr),
      );
    }
    return finalizeMapperResponse(app, c, out, error);
  } catch (mapperErr) {
    return fail(mapperErr);
  }
};

/** Apply the takeover rules to a mapper's return value (R4.3 rules 3-4). */
const finalizeMapperResponse = (
  app: Application,
  c: Context,
  res: unknown,
  error: HttpError,
): Response => {
  // void — or any non-Response garbage — declines to the built-in response.
  if (!(res instanceof Response)) return builtinErrorResponse(app, c, error) as Response;
  const out = c.method === "HEAD" && res.body !== null ? stripBody(res) : res;
  mergeAbsentHeaders(out, error, c.headersRecord);
  return out;
};

/**
 * if-absent merge (R4.3 rule 3): `error.headers` (the throw's own protocol
 * headers, e.g. WWW-Authenticate / Retry-After) and the staged security
 * headers fill only slots the takeover Response left empty — a header the
 * mapper set itself always wins. Content-describing headers are never
 * merged. An immutable Headers object ships the Response untouched rather
 * than failing the error path.
 */
const mergeAbsentHeaders = (res: Response, error: HttpError, staged: HeaderMap | null): void => {
  try {
    const headers = res.headers;
    const errorHeaders = error.headers;
    if (errorHeaders !== undefined) {
      for (const [field, value] of Object.entries(errorHeaders)) {
        if (!headers.has(field)) {
          headers.set(field, Array.isArray(value) ? (value as string[]).join(", ") : String(value));
        }
      }
    }
    if (staged !== null) {
      for (const [name, value] of flattenHeaders(staged)) {
        if (value !== undefined && !headers.has(name)) headers.set(name, value);
      }
    }
  } catch {
    // Immutable Headers — ship exactly what the mapper built.
  }
};

/** The built-in text/plain error response — the decline default. */
const builtinErrorResponse = (
  app: Application,
  c: Context,
  error: HttpError,
): Response | Promise<Response> => {
  for (const [field, value] of Object.entries(error.headers ?? {})) {
    // The error path must never throw; skip headers that fail validation.
    try {
      c.set(field, Array.isArray(value) ? value : String(value));
    } catch {
      // Invalid header from an error object — drop it silently.
    }
  }
  c.status = error.status;
  const message =
    error.expose === true ? error.message : statusMessage(error.status) || "Internal Server Error";
  c.set("Content-Type", "text/plain; charset=utf-8");
  c.body = message;
  // TERMINAL conversion — the error path must never re-enter the full error
  // pipeline: a finalize failure here (say, a staged header no Response can
  // carry) answers the static 500 directly. This built-in path never calls
  // the mapper, so a mapper failure can never recurse (the historical
  // mutual-recursion bug fired app.onerror ~1.3k times for ONE request).
  // finalize is synchronous here by construction: _res is cleared and the
  // body is the plain message string, so no stream/HEAD async branch exists.
  try {
    return finalize(app, c) as Response;
  } catch {
    return staticServerError(c.method);
  }
};
