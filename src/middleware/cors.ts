/**
 * CORS — the safe defaults from the security design:
 *  - `allowCredentials: true` NEVER reflects arbitrary origins (whitelist or
 *    origin predicate only)
 *  - whitelists (and origin predicates) REFLECT the request origin, so every
 *    negotiated response carries `Vary: Origin` (a constant "*" answer never
 *    varies and omits it)
 *  - preflight responses never carry cookies
 *  - `Access-Control-Request-Headers` reflection is opt-in (`reflectHeaders`)
 */

import { createError } from "../http/errors.ts";
import { statusMessage } from "../http/status.ts";
import { toURL } from "../utils/url.ts";
import type { Context } from "../core/context/context.ts";
import type { RouteHandler } from "../router/router.ts";

export interface CorsOptions {
  /**
   * Allowed origin(s). "*" (default), an explicit whitelist, or a predicate
   * consulted on EVERY request (multi-tenant / dynamically provisioned
   * domains): returning true reflects that request's Origin, false rejects
   * like a whitelist miss. Called with `undefined` when the request carries
   * no Origin header — there is nothing to reflect then.
   */
  origin?: string | string[] | ((origin: string | undefined) => boolean | Promise<boolean>);
  /** Request methods allowed (preflight answer). Default GET,HEAD,PUT,POST,DELETE. */
  allowMethods?: string[];
  /**
   * Request headers allowed — never reflect the request's own list.
   * (See `reflectHeaders` for the explicit opt-in to reflection.)
   */
  allowHeaders?: string[];
  /** Expose response headers to the browser. */
  exposeHeaders?: string[];
  /** Send Access-Control-Allow-Credentials. Whitelist REQUIRED when true. */
  allowCredentials?: boolean;
  /** Preflight cache time in seconds. */
  maxAge?: number;
  /**
   * Preflight opt-in: with no `allowHeaders` configured, reflect the
   * request's `Access-Control-Request-Headers` back (hono behavior) and add
   * `Vary: Access-Control-Request-Headers` — the answer depends on what the
   * browser asked for. Default false: an unset list stays unset.
   */
  reflectHeaders?: boolean;
  /** Handler invoked when the origin is rejected. Default: plain 403. */
  reject?: (origin: string) => Response;
}

const DEFAULT_METHODS = "GET, HEAD, PUT, POST, DELETE";

const isAllowed = (origin: string, allow: string | string[]): boolean => {
  if (allow === "*") return true;
  const list = Array.isArray(allow) ? allow : [allow];
  return list.includes(origin);
};

/**
 * Add one `Vary` token without duplicating it. The token merge (not a bare
 * append) matters pre-commit AND post-commit: repeated runs must never grow
 * "Origin, Origin", and after `await next()` the handler's own Vary values
 * must survive (cache-poisoning surface on reflected ACAO responses).
 */
const addVary = (c: Parameters<RouteHandler>[0], field: string): void => {
  const existing = c.resHeader("Vary");
  const tokens = existing
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  const lower = new Set(tokens.map((token) => token.toLowerCase()));
  if (!lower.has(field.toLowerCase())) tokens.push(field);
  c.setHeader("Vary", tokens.join(", "));
};

export const cors = (options: CorsOptions = {}): RouteHandler => {
  // A predicate is an explicit decision surface exactly like a whitelist —
  // the construction guard below keeps targeting only the constant "*".
  const originFn = typeof options.origin === "function" ? options.origin : null;
  const originList: string | string[] =
    typeof options.origin === "string" || Array.isArray(options.origin) ? options.origin : "*";
  const wildcard = originFn === null && originList === "*";
  if (options.allowCredentials === true && wildcard) {
    throw new TypeError(
      "cors({ allowCredentials: true }) requires an explicit origin whitelist — reflecting arbitrary origins with credentials enables any-site data theft",
    );
  }
  const methods = (options.allowMethods ?? DEFAULT_METHODS.split(", ")).join(", ").toUpperCase();
  const allowHeaders = options.allowHeaders?.join(", ").toLowerCase();
  const exposeHeaders = options.exposeHeaders?.join(", ");
  const maxAge = options.maxAge;
  // A whitelist (or predicate) REFLECTS the request origin — the response is
  // origin-dependent and shared caches must key on it, so `Vary: Origin` is
  // mandatory on every negotiated answer. With a constant "*" the response
  // never varies, and the header would only needlessly disable caching.
  const varyOrigin = originFn !== null || originList !== "*";
  // ACRH reflection only ever applies when no explicit list is configured.
  const reflectHeaders = options.reflectHeaders === true && allowHeaders === undefined;

  return async (c, next) => {
    const origin = c.header("origin");
    const allowed =
      originFn !== null
        ? Boolean(await originFn(origin.length > 0 ? origin : undefined)) && origin.length > 0
        : origin.length > 0 && isAllowed(origin, originList);

    const preflight =
      c.method === "OPTIONS" && c.header("access-control-request-method").length > 0;
    if (preflight) {
      if (!allowed) {
        // The 403 exists ONLY because of the Origin header — a shared cache
        // must key it on Origin like every other negotiated answer (below).
        if (varyOrigin) addVary(c, "Origin");
        if (options.reject !== undefined) return options.reject(origin);
        return c.text(statusMessage(403), 403);
      }
      c.setHeader("Access-Control-Allow-Origin", wildcard ? "*" : origin);
      c.setHeader("Access-Control-Allow-Methods", methods);
      if (allowHeaders !== undefined) {
        c.setHeader("Access-Control-Allow-Headers", allowHeaders);
      } else if (reflectHeaders) {
        // Reflect the browser's own request-header list (hono parity): the
        // answer depends on it, so shared caches must key on the header.
        const requested = c.header("access-control-request-headers");
        const reflected =
          requested.length > 0
            ? requested
                .split(",")
                .map((header) => header.trim())
                .filter((header) => header.length > 0)
                .join(", ")
            : "";
        if (reflected.length > 0) {
          c.setHeader("Access-Control-Allow-Headers", reflected);
          addVary(c, "Access-Control-Request-Headers");
        }
      }
      if (options.allowCredentials === true)
        c.setHeader("Access-Control-Allow-Credentials", "true");
      if (maxAge !== undefined) c.setHeader("Access-Control-Max-Age", String(Math.trunc(maxAge)));
      // Preflight answers carry no body and never cookies.
      if (varyOrigin) addVary(c, "Origin");
      return new Response(null, { status: 204 });
    }

    if (origin.length > 0 && !allowed) {
      // Same invariant as above: a rejection is an origin-dependent answer.
      // (Written BEFORE a custom reject() Response is returned, so the staged
      // Vary rides along onto the committed answer.)
      if (varyOrigin) addVary(c, "Origin");
      if (options.reject !== undefined) return options.reject(origin);
      return c.text(statusMessage(403), 403);
    }

    await next();

    if (varyOrigin) {
      // Append semantics AFTER the handler: its own `Vary` values must never
      // erase Origin (cache poisoning surface on reflected ACAO responses).
      // resHeader reads through to the committed Response's headers once one
      // exists, so the handler's tokens join the combined set.
      addVary(c, "Origin");
    }
    if (allowed) {
      c.setHeader("Access-Control-Allow-Origin", wildcard ? "*" : origin);
      if (exposeHeaders !== undefined) c.setHeader("Access-Control-Expose-Headers", exposeHeaders);
      if (options.allowCredentials === true)
        c.setHeader("Access-Control-Allow-Credentials", "true");
    }
  };
};

export interface CsrfOptions {
  /**
   * Exemption hook, consulted BEFORE the Origin/Referer validation.
   * Returning true skips the check entirely (`next()` directly) — the
   * escape hatch for callers browsers never impersonate: direct API
   * clients (curl, service-to-service) that authenticate by some other
   * means, e.g. `allow: (c) => c.header("authorization").length > 0`.
   * The exemption must NOT rest on request properties an attacker's
   * browser page can set.
   */
  allow?: (c: Context) => boolean | Promise<boolean>;
}

/**
 * CSRF — Origin/Referer validation for state-changing requests (no tokens).
 *
 * Safe methods (GET/HEAD/OPTIONS) and same-origin requests pass; anything
 * else answers 403. Requests without BOTH Origin and Referer are rejected:
 * browsers always send one on cross-site state changes. An optional `allow`
 * hook (see CsrfOptions) exempts non-browser callers before validation.
 */
export const csrf = (options: CsrfOptions = {}): RouteHandler => {
  const SAFE = new Set(["GET", "HEAD", "OPTIONS", "TRACE"]);
  const allow = options.allow;
  return async (c, next) => {
    if (SAFE.has(c.method)) return next();
    if (allow !== undefined && Boolean(await allow(c))) return next();
    const originHeader = c.header("origin");
    const source = originHeader.length > 0 ? originHeader : c.header("referer");
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
