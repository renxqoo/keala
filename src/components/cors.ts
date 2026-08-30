/**
 * CORS — the safe defaults from the v2 security design:
 *  - `allowCredentials: true` NEVER reflects arbitrary origins (whitelist only)
 *  - every negotiated response carries `Vary: Origin`
 *  - preflight responses never carry cookies
 */

import { createError } from "../http/errors.ts";
import type { RouteHandler } from "../router/router.ts";

export interface CorsOptions {
  /** Allowed origin(s). "*" (default) or an explicit whitelist. */
  origin?: string | string[];
  /** Request methods allowed (preflight answer). Default GET,HEAD,PUT,POST,DELETE. */
  allowMethods?: string[];
  /** Request headers allowed — never reflect the request's own list. */
  allowHeaders?: string[];
  /** Expose response headers to the browser. */
  exposeHeaders?: string[];
  /** Send Access-Control-Allow-Credentials. Whitelist REQUIRED when true. */
  allowCredentials?: boolean;
  /** Preflight cache time in seconds. */
  maxAge?: number;
  /** Handler invoked when the origin is rejected. Default: plain 403. */
  reject?: (origin: string) => Response;
}

const DEFAULT_METHODS = "GET, HEAD, PUT, POST, DELETE";

const isAllowed = (origin: string, allow: string | string[]): boolean => {
  if (allow === "*") return true;
  const list = Array.isArray(allow) ? allow : [allow];
  return list.includes(origin);
};

export const cors = (options: CorsOptions = {}): RouteHandler => {
  const originAllow = options.origin ?? "*";
  if (options.allowCredentials === true && originAllow === "*") {
    throw new TypeError(
      "cors({ allowCredentials: true }) requires an explicit origin whitelist — reflecting arbitrary origins with credentials enables any-site data theft",
    );
  }
  const methods = (options.allowMethods ?? DEFAULT_METHODS.split(", ")).join(", ").toUpperCase();
  const allowHeaders = options.allowHeaders?.join(", ").toLowerCase();
  const exposeHeaders = options.exposeHeaders?.join(", ");
  const maxAge = options.maxAge;

  return async (c, next) => {
    const origin = c.get("origin");
    const allowed = origin.length > 0 && isAllowed(origin, originAllow);
    if (origin.length > 0) c.set("Vary", "Origin");

    if (c.method === "OPTIONS") {
      if (!allowed) {
        if (options.reject !== undefined) return options.reject(origin);
        c.status = 403;
        return;
      }
      c.set("Access-Control-Allow-Origin", originAllow === "*" ? "*" : origin);
      c.set("Access-Control-Allow-Methods", methods);
      if (allowHeaders !== undefined) c.set("Access-Control-Allow-Headers", allowHeaders);
      if (options.allowCredentials === true) c.set("Access-Control-Allow-Credentials", "true");
      if (maxAge !== undefined) c.set("Access-Control-Max-Age", String(Math.trunc(maxAge)));
      // Preflight answers carry no body and never cookies.
      c.status = 204;
      return;
    }

    if (origin.length > 0 && !allowed) {
      if (options.reject !== undefined) return options.reject(origin);
      c.status = 403;
      return;
    }

    await next();

    if (allowed) {
      c.set("Access-Control-Allow-Origin", originAllow === "*" ? "*" : origin);
      if (exposeHeaders !== undefined) c.set("Access-Control-Expose-Headers", exposeHeaders);
      if (options.allowCredentials === true) c.set("Access-Control-Allow-Credentials", "true");
    }
  };
};

/**
 * CSRF — Origin/Referer validation for state-changing requests (no tokens).
 *
 * Safe methods (GET/HEAD/OPTIONS) and same-origin requests pass; anything
 * else answers 403. Requests without BOTH Origin and Referer are rejected:
 * browsers always send one on cross-site state changes.
 */
export const csrf = (): RouteHandler => {
  const SAFE = new Set(["GET", "HEAD", "OPTIONS", "TRACE"]);
  return async (c, next) => {
    if (SAFE.has(c.method)) return next();
    const originHeader = c.get("origin");
    const source = originHeader.length > 0 ? originHeader : c.get("referer");
    if (source.length === 0) {
      throw createError(403, "missing Origin/Referer for a state-changing request", {
        expose: true,
      });
    }
    const host = c.host;
    let originHost = "";
    try {
      originHost = new URL(source, `http://${host}`).host;
    } catch {
      originHost = "";
    }
    if (originHost.length === 0 || originHost !== host) {
      throw createError(403, "cross-site request rejected", { expose: true });
    }
    return next();
  };
};
