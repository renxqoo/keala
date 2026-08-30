/**
 * Bun adapter: `Bun.serve` glue.
 *
 * The only module in the framework that references the `Bun` global, and only
 * inside function bodies — importing the core under Node (tests) is
 * side-effect free. The serve implementation is injectable for unit tests.
 */

import type { Application, WebSocketHandlers } from "../core/app.ts";
import type { Context } from "../core/context/context.ts";
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
  };
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
    serveOptions["websocket"] = {
      ...config,
      open: (ws: unknown): void => {
        const entry = entryFor(ws);
        if (entry !== undefined) void entry.handlers.open?.(ws, entry.ctx as Context);
      },
      message: (ws: unknown, message: string | ArrayBuffer): void => {
        const entry = entryFor(ws);
        if (entry !== undefined) void entry.handlers.message?.(ws, message, entry.ctx as Context);
      },
      close: (ws: unknown, code: number, reason: string): void => {
        const entry = entryFor(ws);
        if (entry !== undefined)
          void entry.handlers.close?.(ws, code, reason, entry.ctx as Context);
      },
      drain: (ws: unknown): void => {
        const entry = entryFor(ws);
        if (entry !== undefined) void entry.handlers.drain?.(ws, entry.ctx as Context);
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
