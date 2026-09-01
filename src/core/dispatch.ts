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
import { FLAG_ROUTE_REACHED } from "./context/state.ts";
import { retireWithBody, type ContextPool } from "./context/pool.ts";
import { finalize } from "./respond.ts";
import { isHttpError, normalizeError } from "../http/errors.ts";
import { isValidErrorStatus, statusMessage } from "../http/status.ts";
import type { ListenOptions } from "../types.ts";

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
  globalMw: readonly RouteHandler[],
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
    globalMw,
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
  subGlobal: readonly RouteHandler[],
  def: RouteDef,
  globalMw: readonly RouteHandler[],
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
  wsRoutes.set(newKey, socketHandlers);
  // Same merge contract as the non-ws mount path: the def's own prefix
  // middleware (baked by a nested mount of the sub-app) survives the
  // re-key, running inside the sub-app's global middleware.
  registerDef(router, def.method, path, [wsUpgradeHandler(newKey)], def.name, globalMw, [
    ...(def.prefixMiddleware ?? []),
    ...subGlobal,
  ]).wsKey = newKey;
};

/** Errors from OTHER realms (vm contexts, structured clones) fail instanceof
 * but are still Errors by koa's toString-based contract — treat them as such. */
const isErrorLike = (value: unknown): boolean =>
  Object.prototype.toString.call(value) === "[object Error]";

/**
 * The app error hook (koa contract): null is a no-op, a non-Error is a loud
 * TypeError; listeners hear every error, and only SERVER faults fall back to
 * console logging (client-level 4xx / exposed errors are not faults).
 */
export const onAppError = (
  app: Application,
  emitter: { emit(event: string, ...args: unknown[]): boolean },
  error: Error,
  c?: Context,
): void => {
  if (error == null) return;
  if (!(error instanceof Error) && !isErrorLike(error)) {
    throw new TypeError(`non-error thrown: ${JSON.stringify(error)}`);
  }
  const heard = emitter.emit("error", error, c);
  const status = (error as Partial<{ status: number }>).status;
  const expose = (error as Partial<{ expose: boolean }>).expose;
  const clientError =
    status === 404 || expose === true || (typeof status === "number" && status < 500);
  if (!heard && !app.silent && app.env !== "test" && !clientError) {
    console.error(`\n  ${error.stack ?? error.message}\n  at ${c?.url ?? "unknown"}\n`);
  }
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

/** Dev-only trace of which matched route a chain was dispatched for. */
export interface RouteTrace {
  method: string;
  path: string;
}

/** One swallowed-route warning per (app, method, path) — never per request. */
const swallowWarned = new WeakMap<Application, Set<string>>();

/**
 * Dev-only (DOGFOOD-R1 C4): the koa contract compiles global middleware INTO
 * every route chain, so a middleware that returns without calling next()
 * keeps the route's handlers from ever running — which reads as "my route
 * 404s" to anyone arriving with a routing-first mental model. Fires on the
 * success path only: a thrown rejection (c.throw / throw) is an intentional
 * koa pattern and stays silent. Production/test chains never compile the
 * marker, so the flags check alone is the whole prod cost (one AND).
 */
const warnIfSwallowed = (app: Application, c: Context, trace: RouteTrace | undefined): void => {
  if (trace === undefined || (c.flags & FLAG_ROUTE_REACHED) !== 0) return;
  let seen = swallowWarned.get(app);
  if (seen === undefined) {
    seen = new Set<string>();
    swallowWarned.set(app, seen);
  }
  const key = `${trace.method} ${trace.path}`;
  if (seen.has(key)) return;
  seen.add(key);
  console.warn(
    `keala(dev): ${key} matched a route but its handler never ran — global middleware returned before calling next(). Call next() for requests you don't handle, or use c.throw() to reject intentionally.`,
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
    warnIfSwallowed(app, c, trace);
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

const buildErrorResponse = (
  app: Application,
  c: Context,
  err: unknown,
): Response | Promise<Response> => {
  const error = normalizeError(err);
  app.onerror(error, c);

  // A stale committed response must not shadow the error.
  c._res = undefined;
  // Koa parity on the error path: headers the chain already staged ride
  // along (koa's res keeps them; middleware security headers must still
  // cover error pages) — only content-DESCRIBING headers drop, because they
  // describe the body that failed to ship. The body/message below replace
  // the failed response state entirely.
  const record = c.headersRecord;
  if (record !== null) {
    delete record["content-type"];
    delete record["content-length"];
    delete record["transfer-encoding"];
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
  // TERMINAL conversion — the error path must never re-enter the full error
  // pipeline: a finalize failure here (say, a staged header no Response can
  // carry) answers the static 500 directly. Routing this through
  // finalizeGuarded's catch → errorResponse → buildErrorResponse recursed
  // mutually until stack overflow, firing app.onerror ~1.3k times for ONE
  // request and, on promise-shaped finalize failures, escaping as an
  // unhandled RangeError.
  try {
    const out = finalize(app, c);
    if (out instanceof Promise) return out.catch(() => staticServerError(c.method));
    return out;
  } catch {
    return staticServerError(c.method);
  }
};

interface ParsedListen {
  listen: ListenOptions;
  hostname?: string;
  onListen?: () => void;
}

export const parseListenArgs = (args: readonly unknown[]): ParsedListen => {
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
      if (opts.nativeRoutes !== undefined) parsed.listen.nativeRoutes = opts.nativeRoutes;
      if (opts.websocket !== undefined) parsed.listen.websocket = opts.websocket;
      if (opts.onServeError !== undefined) parsed.listen.onServeError = opts.onServeError;
    }
  }
  return parsed;
};
