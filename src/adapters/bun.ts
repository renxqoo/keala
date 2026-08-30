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
import type { ListenOptions } from "../types.ts";

/** Minimal structural type of the Bun server handle we expose to users. */
export interface ServerHandle {
  readonly port: number;
  readonly hostname: string;
  stop(closeActiveConnections?: boolean): void;
  fetch(request: Request): Response | Promise<Response>;
  /** Hot-reload server options (Bun's actual API — `update` does not exist). */
  reload(options: Record<string, unknown>): void;
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
    // A throwing error listener must not break Bun's error callback itself.
    try {
      app.onerror(error);
    } catch {
      // the listener's failure is its own problem; the 500 still goes out
    }
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
    throw new Error("listen() requires Bun.serve (Bun >= 1.4). Use app.handle() elsewhere.");
  }

  // The server handle rides the runtime channel: `c.ip` resolves through
  // `requestIP` without any Bun-specific code in the core.
  const fetch = (request: Request, server: RequestIPHost): Response | Promise<Response> =>
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
  const wsRoutes = app.wsRoutes;
  if (wsRoutes.size > 0) {
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
    // error hook, mirroring the HTTP chain's floating-next containment.
    const dispatch = (run: () => unknown): void => {
      void Promise.resolve()
        .then(run)
        .catch((error: unknown) =>
          app.onerror(error instanceof Error ? error : new Error(String(error))),
        );
    };
    serveOptions["websocket"] = {
      ...config,
      open: (ws: unknown): void => {
        const entry = entryFor(ws);
        if (entry !== undefined) dispatch(() => entry.handlers.open?.(ws, entry.ctx as Context));
      },
      message: (ws: unknown, message: string | ArrayBuffer): void => {
        const entry = entryFor(ws);
        if (entry !== undefined)
          dispatch(() => entry.handlers.message?.(ws, message, entry.ctx as Context));
      },
      close: (ws: unknown, code: number, reason: string): void => {
        const entry = entryFor(ws);
        if (entry !== undefined)
          dispatch(() => entry.handlers.close?.(ws, code, reason, entry.ctx as Context));
      },
      drain: (ws: unknown): void => {
        const entry = entryFor(ws);
        if (entry !== undefined) dispatch(() => entry.handlers.drain?.(ws, entry.ctx as Context));
      },
      error: (ws: unknown, error: Error): void => {
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
  if (onListen !== undefined) queueMicrotask(onListen);
  return server;
};
