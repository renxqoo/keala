/**
 * CORS — the safe defaults from the security design:
 *  - `allowCredentials: true` NEVER reflects arbitrary origins (whitelist only)
 *  - whitelists REFLECT the request origin, so every negotiated response
 *    carries `Vary: Origin` (a constant "*" answer never varies and omits it)
 *  - preflight responses never carry cookies
 */

import { createError } from "../http/errors.ts";
import { toURL } from "../utils/url.ts";
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
  // A whitelist REFLECTS the request origin — the response is origin-dependent
  // and shared caches must key on it, so `Vary: Origin` is mandatory on every
  // negotiated answer. With a constant "*" the response never varies, and the
  // header would only needlessly disable caching.
  const varyOrigin = originAllow !== "*";

  return async (c, next) => {
    const origin = c.get("origin");
    const allowed = origin.length > 0 && isAllowed(origin, originAllow);

    const preflight = c.method === "OPTIONS" && c.get("access-control-request-method").length > 0;
    if (preflight) {
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
      if (varyOrigin) c.vary("Origin");
      c.status = 204;
      return;
    }

    if (origin.length > 0 && !allowed) {
      if (options.reject !== undefined) return options.reject(origin);
      c.status = 403;
      return;
    }

    await next();

    if (varyOrigin) {
      // Append semantics AFTER the handler: its own `Vary` values must never
      // erase Origin (cache poisoning surface on reflected ACAO responses).
      // With a committed Response the staged record is empty, so the committed
      // header value joins the combined set explicitly.
      const committedVary = c._res?.headers.get("vary") ?? "";
      const existing = c.resHeader("Vary") || committedVary;
      const tokens = existing
        .split(",")
        .map((token) => token.trim())
        .filter((token) => token.length > 0);
      const lower = new Set(tokens.map((token) => token.toLowerCase()));
      if (!lower.has("origin")) tokens.push("Origin");
      c.set("Vary", tokens.join(", "));
    }
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
    // Sandboxed iframes and privacy extensions send the literal "null" —
    // it is never a same-origin signal.
    if (source === "null") {
      throw createError(403, "cross-site request rejected", { expose: true });
    }
    if (source.length === 0) {
      throw createError(403, "missing Origin/Referer for a state-changing request", {
        expose: true,
      });
    }
    const host = c.host;
    // The FULL origin decides — scheme included. Browsers treat
    // http://host and https://host as different origins; comparing hosts
    // alone would let a same-host-other-scheme page forge state changes.
    let sourceOrigin = "";
    try {
      sourceOrigin = new URL(source, `http://${host}`).origin;
    } catch {
      sourceOrigin = "";
    }
    let expectedOrigin = "";
    if (host.length > 0) {
      const parsed = toURL(`${c.protocol}://${host}`);
      if (parsed !== null) expectedOrigin = parsed.origin;
    }
    if (
      sourceOrigin.length === 0 ||
      expectedOrigin.length === 0 ||
      sourceOrigin !== expectedOrigin
    ) {
      throw createError(403, "cross-site request rejected", { expose: true });
    }
    return next();
  };
};
