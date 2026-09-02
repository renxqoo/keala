/**
 * Bun adapter: `Bun.serve` glue.
 *
 * The only module in the framework that references the `Bun` global, and only
 * inside function bodies — importing the core under Node (tests) is
 * side-effect free. The serve implementation is injectable for unit tests.
 */

import type { Application, WebSocketHandlers } from "../core/app.ts";
import type { Context } from "../core/context/context.ts";
import { buildNativeRoutes } from "../core/sink.ts";
import { consoleFallback } from "../core/error-response.ts";
import type { GracefulStopOptions } from "../core/lifecycle.ts";
import { attachServer } from "../core/server-slot.ts";
import { toHttpError } from "../http/errors.ts";
import type { ListenOptions } from "../types.ts";

/** Minimal structural type of the Bun server handle we expose to users. */
export interface ServerHandle {
  readonly port: number;
  readonly hostname: string;
  stop(closeActiveConnections?: boolean): void;
  fetch(request: Request): Promise<Response>;
  /** Hot-reload server options (Bun's actual API — `update` does not exist). */
  reload(options: Record<string, unknown>): void;
  /** R4.6 graceful stop (attached by startBunServer when the handle allows). */
  stopGraceful?(options: GracefulStopOptions): Promise<{ timedOut: boolean }>;
}

export type ServeImplementation = (options: Record<string, unknown>) => ServerHandle;

interface RequestIPHost {
  requestIP(request: Request): { readonly address: string } | null;
}

const defaultServeImplementation = (): ServeImplementation | undefined =>
  typeof Bun !== "undefined" && typeof Bun.serve === "function"
    ? (Bun.serve as unknown as ServeImplementation)
    : undefined;

const defaultServeError =
  (app: Application) =>
  (error: Error): Response => {
    // A serve error is a server fault, not a request-path error: it has no
    // context, so the mapper contract does not apply — console fallback only.
    consoleFallback(app, undefined, toHttpError(error));
    return new Response("Internal Server Error", { status: 500 });
  };

/**
 * Start a Bun server for the app. Returns the Bun `Server`.
 *
 * ```ts
 * const server = app.listen(3000, "0.0.0.0", () => console.log("up"))
 * server.stop()
 * ```
 */
export const startBunServer = (
  app: Application,
  options: ListenOptions,
  onListen?: () => void,
  serveImpl?: ServeImplementation,
): ServerHandle => {
  const serve = serveImpl ?? defaultServeImplementation();
  if (serve === undefined) {
    throw new Error(
      'listen() requires Bun.serve (Bun >= 1.4). Under Node use startNodeServer from "keala/node", or call app.handle() yourself.',
    );
  }

  // The server handle rides the runtime channel: `c.ip` resolves through
  // `requestIP` without any Bun-specific code in the core.
  const fetch = (request: Request, server: RequestIPHost): Promise<Response> =>
    app.handle(request, { server });

  const serveOptions: Record<string, unknown> = {
    port: options.port ?? 3000,
    fetch,
    // Server-level failures (fetch threw, streaming body crashed) route
    // through the app's error hook and answer a plain 500.
    error: options.onServeError ?? defaultServeError(app),
  };
  // Sunk routes ride the native routing table — matched before `fetch`,
  // with zero JS per request. `nativeRoutes: false` forces JS-only serving.
  if (options.nativeRoutes !== false && app.nativeSinks.size > 0) {
    serveOptions["routes"] = buildNativeRoutes(app.nativeSinks);
  }
  // Websocket handlers install UNCONDITIONALLY: they dispatch through the
  // live wsRoutes map, so `app.ws()` registered after listen() is picked up
  // without a reload (HTTP routes hot-register the same way). Skipping the
  // install when no ws route exists yet would silently dead-end late
  // registrations under Bun (server.upgrade fails without handlers).
  const wsRoutes = app.wsRoutes;
  // R4.6: open sockets tracked for drain — a websocket never settles an HTTP
  // request (the upgrade returns immediately, releasing its slot), so a
  // courtesy 1001 close lets clients reconnect elsewhere instead of eating
  // the drain timeout. Entries leave on close/error.
  const openSockets = new Set<unknown>();
  {
    const config = (options.websocket ?? {}) as Record<string, unknown>;
    interface WsData {
      wsKey?: string;
      ctx?: Context;
    }
    const entryFor = (ws: unknown): { handlers: WebSocketHandlers; ctx?: Context } | undefined => {
      const data = (ws as { data?: WsData }).data;
      if (data?.wsKey === undefined) return undefined;
      const handlers = wsRoutes.get(data.wsKey);
      return handlers === undefined ? undefined : { handlers, ctx: data.ctx };
    };
    // A rejecting async ws handler must never become an unhandledRejection
    // (a process-killer under Bun.serve) — rejections route to the app's
    // error hook, mirroring the HTTP chain's floating-next containment. The
    // hook itself can throw (a failing listener, a non-Error value) — that
    // failure must die here too, exactly like defaultServeError below.
    const dispatch = (run: () => unknown): void => {
      void Promise.resolve()
        .then(run)
        .catch((error: unknown) => {
          // ws runtime errors live outside the request funnel (no context,
          // no mapper contract) — the console fallback keeps them visible.
          // The containment itself must never become an unhandledRejection
          // (a process-killer under Bun.serve), so it guards its own body.
          try {
            consoleFallback(app, undefined, toHttpError(error));
          } catch {
            // Even a throwing fallback dies here, quietly.
          }
        });
    };
    serveOptions["websocket"] = {
      ...config,
      open: (ws: unknown): void => {
        openSockets.add(ws);
        const entry = entryFor(ws);
        if (entry !== undefined) dispatch(() => entry.handlers.open?.(ws, entry.ctx as Context));
      },
      message: (ws: unknown, message: string | ArrayBuffer): void => {
        const entry = entryFor(ws);
        if (entry !== undefined)
          dispatch(() => entry.handlers.message?.(ws, message, entry.ctx as Context));
      },
      close: (ws: unknown, code: number, reason: string): void => {
        openSockets.delete(ws);
        const entry = entryFor(ws);
        if (entry !== undefined)
          dispatch(() => entry.handlers.close?.(ws, code, reason, entry.ctx as Context));
      },
      drain: (ws: unknown): void => {
        const entry = entryFor(ws);
        if (entry !== undefined) dispatch(() => entry.handlers.drain?.(ws, entry.ctx as Context));
      },
      error: (ws: unknown, error: Error): void => {
        openSockets.delete(ws);
        const entry = entryFor(ws);
        if (entry !== undefined)
          dispatch(() => entry.handlers.error?.(ws, error, entry.ctx as Context));
      },
    };
  }
  if (options.hostname !== undefined) serveOptions["hostname"] = options.hostname;
  if (options.reusePort !== undefined) serveOptions["reusePort"] = options.reusePort;
  if (options.idleTimeout !== undefined) serveOptions["idleTimeout"] = options.idleTimeout;
  if (options.maxRequestBodySize !== undefined) {
    serveOptions["maxRequestBodySize"] = options.maxRequestBodySize;
  }
  if (options.development !== undefined) serveOptions["development"] = options.development;

  const server = serve(serveOptions);
  // R4.6 graceful stop, injected onto the handle: Bun's stop() stops
  // accepting and drains its own in-flight connections; completion of the
  // APPLICATION-side work (handler settle + drain body-holds) arrives via
  // the onSettled callback. Websockets close first (1001) — they never
  // settle an HTTP request.
  const stopGraceful = (grace: GracefulStopOptions): Promise<{ timedOut: boolean }> =>
    new Promise((resolve) => {
      for (const ws of openSockets) {
        try {
          (ws as { close(code?: number, reason?: string): void }).close(
            1001,
            "server shutting down",
          );
        } catch {
          // A dead socket refusing a courtesy close is not worth stopping for.
        }
      }
      openSockets.clear();
      server.stop();
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (timedOut: boolean): void => {
        if (done) return;
        done = true;
        if (timer !== undefined) clearTimeout(timer);
        if (timedOut) server.stop(true);
        resolve({ timedOut });
      };
      // Operator escalation (second SIGTERM): kill sockets AND this wait.
      grace.registerForce?.(() => finish(true));
      // Arm the timer BEFORE the settled check (FINDING-5): a finish on the
      // already-settled path must be able to clear it. Infinity never arms
      // (setTimeout clamps it to ~1ms — FINDING-3).
      if (grace.drain !== Number.POSITIVE_INFINITY) {
        timer = setTimeout(() => finish(true), grace.drain);
      }
      if (grace.onSettled(() => finish(false))) finish(false);
    });
  try {
    server.stopGraceful = stopGraceful;
  } catch {
    // A frozen handle: close() falls back to the embedded counter-wait.
  }
  // Register on the app's server slot so app.close() reaches this server no
  // matter how it was started (listen() or a direct startBunServer).
  attachServer(app, server);
  if (onListen !== undefined) queueMicrotask(onListen);
  return server;
};
