/**
 * listen() argument parsing — extracted from dispatch.ts for the 500-line
 * budget. Accepts (port), (port, hostname), (port, callback), (hostname,
 * callback), (options) and any mix, koa-style.
 */

import type { ListenOptions } from "../types.ts";

export interface ParsedListen {
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
      // Unknown keys refuse loudly: a typo like `idleTimout` used to vanish
      // silently and the server ran on runtime defaults (audit finding —
      // config must never be accepted-and-ignored).
      const known = new Set([
        "port",
        "hostname",
        "reusePort",
        "idleTimeout",
        "maxRequestBodySize",
        "development",
        "nativeRoutes",
        "websocket",
        "onServeError",
        "signals",
      ]);
      for (const key of Object.keys(opts)) {
        if (!known.has(key)) {
          throw new TypeError(
            `listen(): unknown option ${JSON.stringify(key)} — a typo here used to be silently ignored`,
          );
        }
      }
      if (typeof opts.port === "number" && (!Number.isInteger(opts.port) || opts.port < 0)) {
        throw new RangeError(`listen(): port must be a non-negative integer, got ${opts.port}`);
      }
      if (
        typeof opts.idleTimeout === "number" &&
        (!Number.isFinite(opts.idleTimeout) || opts.idleTimeout < 0)
      ) {
        throw new RangeError(`listen(): idleTimeout must be a non-negative number of seconds`);
      }
      if (
        typeof opts.maxRequestBodySize === "number" &&
        (!Number.isFinite(opts.maxRequestBodySize) || opts.maxRequestBodySize < 0)
      ) {
        throw new RangeError(`listen(): maxRequestBodySize must be a non-negative byte count`);
      }
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
      if (opts.signals !== undefined) parsed.listen.signals = opts.signals;
    }
  }
  return parsed;
};
