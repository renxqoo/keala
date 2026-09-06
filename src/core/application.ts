/**
 * The Application contract — the public type of a `new Keala()` instance.
 *
 * Kept as a standalone structural interface (not the class itself) so the
 * dispatch/respond/adapter layers can consume `app` without importing the
 * implementation module, and so the class in core/app.ts has a crisp,
 * reviewable public surface to `implements` against.
 */

import type {
  AppOptions,
  CloseOptions,
  CloseStatus,
  ListenOptions,
  Plugin as AppOptionsPlugin,
  Runtime,
} from "../types.ts";
import type { RequestSettings } from "./context/settings.ts";
import type { Context } from "./context/context.ts";
import type { RouteDef, RouteHandler, RouterState } from "../router/router.ts";
import type { HttpError } from "../http/errors.ts";
import type { Router } from "../router/group.ts";
import type { ServerHandle } from "../adapters/bun.ts";
import type { NativeSinkEntry, SunkHandler } from "./sink.ts";
import type { RequestSource } from "./request-source.ts";

/** Internal native-adapter entry; not exported from the package surface. */
export const HANDLE_REQUEST_SOURCE = Symbol("keala.handleRequestSource");

/**
 * The single error entry (R4.3): the mapper ALWAYS receives an HttpError
 * (non-HttpError throwables are wrapped as an unexposed 500 upstream).
 * Returning a Response takes over the error response (HEAD body stripped,
 * error.headers and staged security headers merged if-absent); returning
 * void keeps the built-in response — side effects in the same function are
 * the observation story. Single slot: a second registration throws.
 */
export type ErrorMapper = (
  error: HttpError,
  c: Context,
) => Response | void | Promise<Response | void>;
export type NotFoundHandler = (c: Context) => Response | void;

/** Bun-native websocket event handlers (the `ws` argument IS Bun's socket). */
export interface WebSocketHandlers {
  /**
   * Origin check for the upgrade handshake (SEC-2, CSWSH defense): the
   * cross-site-websocket-hijack vector is invisible to csrf() — a browser
   * WebSocket cannot carry a custom token header, so the upgrade itself
   * must refuse foreign origins. Array form: exact match, case-insensitive,
   * and a MISSING Origin header is refused (fail closed — browser
   * handshakes always send one). Predicate form: owns the whole decision
   * (read `c.header("origin")` yourself); returning false refuses the
   * upgrade with 403. Omitted: no origin enforcement (previous behavior).
   */
  origin?: string[] | ((c: Context) => boolean);
  open?: (ws: unknown, c: Context) => void | Promise<void>;
  message?: (ws: unknown, message: string | ArrayBuffer, c: Context) => void | Promise<void>;
  close?: (ws: unknown, code: number, reason: string, c: Context) => void | Promise<void>;
  drain?: (ws: unknown, c: Context) => void | Promise<void>;
  error?: (ws: unknown, error: Error, c: Context) => void | Promise<void>;
}

export interface Application {
  /**
   * Register THE error mapper (single slot — a second registration throws).
   * Unregistered + 5xx + non-test env keeps the framework console fallback.
   */
  onError(mapper: ErrorMapper): Application;
  onShutdown(handler: () => unknown): Application;
  /** The registered error mapper, or undefined when the built-in owns errors. */
  readonly errorMapper: ErrorMapper | undefined;
  /** Register global middleware or a plugin (compiled into every route chain). */
  use(...middleware: (RouteHandler | AppOptionsPlugin)[]): Application;
  /** Register static exact-path or trailing-wildcard scoped middleware. */
  use(pattern: string, ...middleware: RouteHandler[]): Application;
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
  sink(path: string, response: Response | { dir: string } | SunkHandler): Application;
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
  /**
   * Extend every context with a LAZY accessor (setup time only). The value
   * form never sniffs shapes — accessors must opt in explicitly.
   */
  decorateLazy(key: string, getter: (this: Context) => unknown): Application;
  /**
   * Fetch-style request handler — the heart of the framework. Always settles
   * through a Promise (sync internals aside, consumers never see a bare
   * Response — DOGFOOD-R1 C1) and never rejects: failures answer error
   * Responses.
   */
  handle(request: Request, runtime?: Runtime): Promise<Response>;
  /** Alias for `handle`, useful for adapters. */
  callback(): (request: Request, runtime?: Runtime) => Promise<Response>;
  /** Start a `Bun.serve` server. Returns the Bun server handle. */
  listen(
    port?: number | string | ListenOptions | (() => void),
    hostname?: string | (() => void),
    onListen?: () => void,
  ): ServerHandle;
  /**
   * Graceful stop (R4.6): refuse new requests, stop accepting, wait up to
   * `options.drain` ms (default 30_000; 0 = immediate force; Infinity waits
   * indefinitely) for in-flight requests — bodied responses hold their
   * slot until the consumer finishes — then force-close. Idempotent.
   */
  close(options?: CloseOptions): Promise<CloseStatus>;
  /** Readiness for LB health endpoints: true once close() has begun (one-way). */
  isDraining(): boolean;
  /** Admitted-and-unsettled requests (overload capacity view). */
  readonly inFlight: number;
  /** Serialized app summary. */
  toJSON(): { env: string; proxy: boolean };
  /** Effective not-found handler used by the finalizer. */
  readonly notFoundHandler: NotFoundHandler;
  /** Whether unknown (non-RFC-9110-grammar) methods answer 404 instead of 501. */
  readonly unknownMethodAs404: boolean;
  /** Registered route definitions (inspection/tests). */
  readonly stack: readonly RouteDef[];
  /** Global middleware stack, exposed for inspection and mount compatibility. */
  readonly globalMiddleware: readonly RouteHandler[];
  /** Setup-time view used by mount() to preserve scoped registration order. */
  middlewareForRoute(path: string, pathOffset?: number): readonly RouteHandler[];
  readonly router: RouterState;
  readonly settings: RequestSettings;
  readonly env: string;
  readonly proxy: boolean;
  readonly onStreamError: AppOptions["onStreamError"];
}

/** Internal extension consumed only by runtime adapters. */
export interface NativeApplication extends Application {
  [HANDLE_REQUEST_SOURCE](source: RequestSource, runtime?: Runtime): Response | Promise<Response>;
}
