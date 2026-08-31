/**
 * The Application contract — the public type of a `new Eleu()` instance.
 *
 * Kept as a standalone structural interface (not the class itself) so the
 * dispatch/respond/adapter layers can consume `app` without importing the
 * implementation module, and so the class in core/app.ts has a crisp,
 * reviewable public surface to `implements` against.
 */

import type { AppOptions } from "../types.ts";
import type { SigningKeys } from "../context/cookies.ts";
import type { RequestSettings } from "./context/settings.ts";
import type { Context } from "./context/context.ts";
import type { RouteDef, RouteHandler, RouterState } from "../router/router.ts";
import type { Router } from "../router/group.ts";
import type { ListenOptions, Plugin as AppOptionsPlugin, Runtime } from "../types.ts";
import type { ServerHandle } from "../adapters/bun.ts";
import type { NativeSinkEntry } from "./sink.ts";

export type ErrorListener = (error: Error, c: Context) => void;
export type NotFoundHandler = (c: Context) => Response | void;

/** Bun-native websocket event handlers (the `ws` argument IS Bun's socket). */
export interface WebSocketHandlers {
  open?: (ws: unknown, c: Context) => void | Promise<void>;
  message?: (ws: unknown, message: string | ArrayBuffer, c: Context) => void | Promise<void>;
  close?: (ws: unknown, code: number, reason: string, c: Context) => void | Promise<void>;
  drain?: (ws: unknown, c: Context) => void | Promise<void>;
  error?: (ws: unknown, error: Error, c: Context) => void | Promise<void>;
}

export interface Application {
  /** Subscribe to framework errors (typed hook). */
  onError(handler: ErrorListener): Application;
  emit(event: string, ...args: unknown[]): boolean;
  off(event: string, listener: (...args: unknown[]) => void): void;
  listenerCount(event: string): number;
  /** Register global middleware or a plugin (compiled into every route chain). */
  use(...middleware: (RouteHandler | AppOptionsPlugin)[]): Application;
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
  sink(path: string, response: Response | { dir: string }): Application;
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
  /** Fetch-style request handler — the heart of the framework. */
  handle(request: Request, runtime?: Runtime): Response | Promise<Response>;
  /** Alias for `handle`, useful for adapters. */
  callback(): (request: Request, runtime?: Runtime) => Response | Promise<Response>;
  /** Start a `Bun.serve` server. Returns the Bun server handle. */
  listen(
    port?: number | string | ListenOptions | (() => void),
    hostname?: string | (() => void),
    onListen?: () => void,
  ): ServerHandle;
  /** Central error hook (emit + fallback logging). */
  onerror(error: Error, c?: Context): void;
  /** Serialized app summary. */
  toJSON(): { env: string; proxy: boolean };
  /** Effective not-found handler used by the finalizer. */
  readonly notFoundHandler: NotFoundHandler;
  /** Registered route definitions (inspection/tests). */
  readonly stack: readonly RouteDef[];
  /** Global middleware stack (consumed whole by `mount`). */
  readonly globalMiddleware: readonly RouteHandler[];
  readonly router: RouterState;
  readonly settings: RequestSettings;
  readonly env: string;
  readonly proxy: boolean;
  readonly silent: boolean;
  readonly keys: SigningKeys | undefined;
  readonly onStreamError: AppOptions["onStreamError"];
}
