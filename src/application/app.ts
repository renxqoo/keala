/**
 * Application factory — the `createApp()` entry point (Koa's `new Koa()`).
 *
 * Sits on top of three pieces:
 *  - `compose`: the onion chain, compiled once, re-used for every request
 *  - `createContext`: flat per-request context objects with shared prototypes
 *  - `respond`: one-shot conversion of response state into a web `Response`
 *
 * `app.handle` is a standard fetch handler: `(request) => Promise<Response>`,
 * which is exactly what `Bun.serve` wants. The adapter module never touches
 * `Bun` at import time, so the core also runs under Node (tests).
 */

import { AsyncLocalStorage } from "node:async_hooks";

import type { AppOptions, ListenOptions } from "../types.ts";
import { contextProto } from "../context/context.ts";
import { requestProto } from "../http/request.ts";
import { responseProto } from "../http/response.ts";
import type { Context } from "../context/context.ts";
import { createContext, resetContext } from "../context/context.ts";
import type { ContextState } from "../context/context.ts";
import type { SigningKeys } from "../context/cookies.ts";
import { isHttpError, normalizeError } from "../http/errors.ts";
import { isValidErrorStatus, statusMessage } from "../http/status.ts";
import type { ResponseState } from "../http/response.ts";
import type { RemoteSource } from "../http/request.ts";
import { startBunServer, type ServerHandle } from "../adapters/bun.ts";
import { compose, NOOP_TAIL, type Composed, type Middleware } from "./compose.ts";
import { createEmitter, type Emitter, type Listener } from "./emitter.ts";
import { respond } from "./respond.ts";

export type ErrorListener = (error: Error, ctx?: Context) => void;

export interface Application extends Emitter {
  /** Subscribe to framework errors with a typed callback. */
  on(event: "error", listener: ErrorListener): () => void;
  on(event: string, listener: Listener): () => void;
  once(event: "error", listener: ErrorListener): () => void;
  once(event: string, listener: Listener): () => void;
  /** Register middleware. Returns the app for chaining. */
  use(...middleware: Middleware<Context>[]): Application;
  /** Fetch-style request handler — the heart of the framework. */
  handle(request: Request, remoteAddress?: RemoteSource): Response | Promise<Response>;
  /** Alias for `handle`, useful for adapters. */
  callback(): (request: Request, remoteAddress?: RemoteSource) => Response | Promise<Response>;
  /** Start a `Bun.serve` server. Returns the Bun server handle. */
  listen(
    port?: number | string | ListenOptions | (() => void),
    hostname?: string | (() => void),
    onListen?: () => void,
  ): ServerHandle;
  /** Central error hook (emit + fallback logging). */
  onerror(error: Error, ctx?: Context): void;
  /** Koa-compatible serialization. */
  toJSON(): { subdomainOffset: number; proxy: boolean; env: string };
  // ---- settings (read live by the request facade)
  readonly env: string;
  proxy: boolean;
  proxyIpHeader: string;
  maxIpsCount?: number;
  subdomainOffset: number;
  silent: boolean;
  keys: SigningKeys | undefined;
  /** Koa-compatible extension layer: properties land on every ctx. */
  readonly context: object;
  /** Extension layer for `ctx.request` (Koa's app.request). */
  readonly request: object;
  /** Extension layer for `ctx.response` (Koa's app.response). */
  readonly response: object;
  /** The context of the request currently running on this async chain. */
  readonly currentContext: Context | undefined;
}

const TERMINATE = NOOP_TAIL;

export const createApp = (options: AppOptions = {}): Application => {
  const emitter = createEmitter();
  const middleware: Middleware<Context>[] = [];
  let chain: Composed<Context> | null = null;
  const contextLayer = Object.create(contextProto);
  const requestLayer = Object.create(requestProto);
  const responseLayer = Object.create(responseProto);
  // AsyncLocalStorage costs ~30% of request throughput on Bun, so koa 3's
  // app.currentContext ships behind an opt-in flag. Everything else works
  // the same with or without it.
  const storage = options.currentContext === true ? new AsyncLocalStorage<Context>() : null;
  // Opt-in context pooling: recycles the three per-request objects. Only safe
  // when application code never retains ctx past the middleware chain
  // (timers, background promises, external stores).
  const pooling = options.pooling === true;
  const pool: ContextState[] = [];
  const POOL_MAX = 128;
  const recycle = (ctx: Context): void => {
    if (pool.length < POOL_MAX) pool.push(ctx as unknown as ContextState);
  };

  const app: Application = {
    env: options.env ?? process.env["NODE_ENV"] ?? "development",
    proxy: options.proxy ?? false,
    proxyIpHeader: options.proxyIpHeader ?? "x-forwarded-for",
    maxIpsCount: options.maxIpsCount,
    subdomainOffset: options.subdomainOffset ?? 2,
    silent: options.silent ?? false,
    keys: options.keys,
    context: contextLayer,
    request: requestLayer,
    response: responseLayer,
    get currentContext(): Context | undefined {
      return storage?.getStore();
    },

    use(...args) {
      for (const mw of args) {
        if (typeof mw !== "function") {
          throw new TypeError("app.use() requires a middleware function");
        }
      }
      middleware.push(...args);
      chain = null;
      return app;
    },

    handle(request, remoteAddress) {
      const pooled = pooling ? pool.pop() : undefined;
      const ctx =
        pooled === undefined
          ? createContext(app, request, remoteAddress)
          : resetContext(pooled, request, remoteAddress);
      const run = chain ?? (chain = compose(middleware));
      if (!pooling) {
        if (storage !== null) return storage.run(ctx, () => dispatch(app, ctx, request, run));
        return dispatch(app, ctx, request, run);
      }
      const settle = (value: Response): Response => {
        recycle(ctx);
        return value;
      };
      if (storage !== null) {
        const result = storage.run(ctx, () => dispatch(app, ctx, request, run));
        return result instanceof Promise ? result.then(settle) : settle(result);
      }
      const settled = dispatch(app, ctx, request, run);
      return settled instanceof Promise ? settled.then(settle) : settle(settled);
    },

    callback() {
      return (request, remoteAddress) => app.handle(request, remoteAddress);
    },

    listen(...args) {
      const { listen, hostname, onListen } = parseListenArgs(args);
      return startBunServer(
        app,
        { ...listen, ...(hostname !== undefined ? { hostname } : {}) },
        onListen,
      );
    },

    onerror(error, ctx) {
      // Koa contract: null is a no-op; a non-Error is a loud TypeError.
      if (error == null) return;
      if (!(error instanceof Error)) {
        throw new TypeError(`non-error thrown: ${JSON.stringify(error)}`);
      }
      const heard = emitter.emit("error", error, ctx);
      // Koa: client-level errors (4xx / exposed) are not server faults — no log.
      const status = (error as Partial<{ status: number }>).status;
      const expose = (error as Partial<{ expose: boolean }>).expose;
      const clientError =
        status === 404 || expose === true || (typeof status === "number" && status < 500);
      if (!heard && !app.silent && app.env !== "test" && !clientError) {
        console.error(
          `\n  ${error.stack ?? error.message}\n  at ${ctx?.request.url ?? "unknown"}\n`,
        );
      }
    },

    toJSON() {
      return { subdomainOffset: app.subdomainOffset, proxy: app.proxy, env: app.env };
    },

    on: (event, listener) => emitter.on(event, listener as Listener),
    once: (event, listener) => emitter.once(event, listener as Listener),
    off: (event, listener) => emitter.off(event, listener),
    emit: (event, ...args) => emitter.emit(event, ...args),
    listenerCount: (event) => emitter.listenerCount(event),
  };

  return app;
};

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
  const code = (error as Partial<Error & { statusCode: number }>).statusCode;
  return isValidErrorStatus(candidate as number)
    ? (candidate as number)
    : isValidErrorStatus(code as number)
      ? (code as number)
      : 500;
};

/** Run the compiled chain and finalize; never rethrows to the caller. */
const dispatch = (
  app: Application,
  ctx: Context,
  request: Request,
  run: Composed<Context>,
): Response | Promise<Response> => {
  let settled: Promise<void> | void;
  try {
    settled = run(ctx, TERMINATE);
  } catch (err) {
    return errorResponse(app, ctx, err);
  }
  // Fully synchronous middleware chains settle without a single promise.
  if (settled !== undefined && typeof (settled as PromiseLike<void>).then === "function") {
    return (settled as Promise<void>).then(
      () => finalize(app, ctx, request),
      (err: unknown) => errorResponse(app, ctx, err),
    );
  }
  return finalize(app, ctx, request);
};

/** Terminal conversion that can never throw past app.handle. */
const finalize = (app: Application, ctx: Context, request: Request): Response => {
  try {
    return respond(ctx.response, request.method, (err) => {
      app.onerror(normalizeError(err), ctx);
    });
  } catch (err) {
    return errorResponse(app, ctx, err);
  }
};

/** Build the error response. Emits `error` (Koa semantics) and never throws. */
const errorResponse = (app: Application, ctx: Context, err: unknown): Response => {
  try {
    return buildErrorResponse(app, ctx, err);
  } catch {
    return new Response("Internal Server Error", {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
};

const buildErrorResponse = (app: Application, ctx: Context, err: unknown): Response => {
  const error = normalizeError(err);
  app.onerror(error, ctx);

  const response = ctx.response;
  const state = response as unknown as ResponseState;
  // Koa's onerror contract: a failed response starts from a clean header set.
  for (const key of Object.keys(state._headers)) {
    if (key !== "set-cookie") delete state._headers[key];
  }
  state._body = null;
  state._message = "";
  state._flags = 0;
  if (isHttpError(error)) {
    for (const [field, value] of Object.entries(error.headers ?? {})) {
      // The error path must never throw; skip headers that fail validation.
      try {
        response.set(field, Array.isArray(value) ? value : String(value));
      } catch {
        // Invalid header from an error object — drop it silently.
      }
    }
  }
  const status = isHttpError(error) ? error.status : errorStatusCode(error);
  response.status = status;
  const exposed = isHttpError(error) ? error.expose === true : false;
  const message = exposed ? error.message : statusMessage(status) || "Internal Server Error";
  response.set("Content-Type", "text/plain; charset=utf-8");
  response.body = message;
  return respond(response, ctx.request.raw.method);
};
