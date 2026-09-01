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
