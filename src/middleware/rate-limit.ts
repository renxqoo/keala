/**
 * rateLimit — fixed-window per-key request limiting (429).
 *
 * Zero dependencies, per-app-instance state by default (a shared store is
 * pluggable for multi-process deployments). Distinct from the R4.6 overload
 * admission: overload protects the SERVER's own capacity (concurrency slots,
 * pre-context, transport-wide), rateLimit protects a ROUTE's fairness
 * (requests per window per client key, runs in the onion, composes with
 * middleware).
 */

import { createError } from "../http/errors.ts";
import type { Context } from "../core/context/context.ts";
import type { RouteHandler } from "../router/router.ts";

export interface RateLimitOptions {
  /** Requests allowed per window per key. Default 100. */
  limit?: number;
  /** Window length in ms. Default 60_000. */
  windowMs?: number;
  /**
   * Client key. Default: `c.ip`. Return a constant (e.g. "global") for a
   * shared budget, or compose user/tenant identity.
   */
  key?: (c: Context) => string;
  /** `Retry-After` seconds on 429 (0 disables the header). Default 1. */
  retryAfterSeconds?: number;
  /** Emit `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset`. */
  headers?: boolean;
  /**
   * Shared store for multi-process deployments: any object with get/set of
   * `{ count, resetAt }` (a Map by default; wire Redis/cmd-backed adapter
   * upstream of every worker).
   */
  store?: Map<string, { count: number; resetAt: number }>;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export const rateLimit = (options: RateLimitOptions = {}): RouteHandler => {
  const limit = options.limit ?? 100;
  const windowMs = options.windowMs ?? 60_000;
  const retryAfter = options.retryAfterSeconds ?? 1;
  const keyOf = options.key ?? ((c: Context) => c.ip);
  const emitHeaders = options.headers === true;
  const buckets = options.store ?? new Map<string, Bucket>();
  if (!Number.isFinite(limit) || limit < 1) {
    throw new TypeError("rateLimit() requires a positive limit");
  }
  if (!Number.isFinite(windowMs) || windowMs < 1) {
    throw new TypeError("rateLimit() requires a positive windowMs");
  }
  return (c, next) => {
    const now = Date.now();
    const key = keyOf(c);
    const bucket = buckets.get(key);
    // Lazily evict expired buckets on touch; the map never grows past the
    // distinct-key count an attacker can produce within one window.
    if (bucket === undefined || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      if (emitHeaders) {
        c.set("RateLimit-Limit", String(limit));
        c.set("RateLimit-Remaining", String(limit - 1));
        c.set("RateLimit-Reset", String(Math.ceil(windowMs / 1000)));
      }
      return next();
    }
    if (bucket.count >= limit) {
      const retrySeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      throw createError(429, "Too Many Requests", {
        expose: true,
        code: "rate_limited",
        headers: {
          ...(retryAfter > 0 ? { "retry-after": String(Math.max(retrySeconds, retryAfter)) } : {}),
          ...(emitHeaders
            ? { "rate-limit-limit": String(limit), "rate-limit-remaining": "0" }
            : {}),
        },
      });
    }
    bucket.count++;
    if (emitHeaders) {
      c.set("RateLimit-Limit", String(limit));
      c.set("RateLimit-Remaining", String(limit - bucket.count));
      c.set("RateLimit-Reset", String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
    }
    return next();
  };
};
