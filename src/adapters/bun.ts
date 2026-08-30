/**
 * Bun adapter: `Bun.serve` glue.
 *
 * The only place in the framework that references the `Bun` global, and only
 * inside function bodies — so importing this module under Node (tests) is
 * side-effect free. The serve implementation is injectable for unit tests.
 */

import type { Application } from "../application/app.ts";
import type { ListenOptions } from "../types.ts";

/** Minimal structural type of the Bun server handle we expose to users. */
export interface ServerHandle {
  readonly port: number;
  readonly hostname: string;
  stop(closeActiveConnections?: boolean): void;
  fetch(request: Request): Response | Promise<Response>;
  update(options: { fetch?: (request: Request) => Response | Promise<Response> }): void;
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

  const fetch = (request: Request, server: RequestIPHost): Response | Promise<Response> =>
    app.handle(request, server);

  const serveOptions: Record<string, unknown> = {
    port: options.port ?? 3000,
    fetch,
  };
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
