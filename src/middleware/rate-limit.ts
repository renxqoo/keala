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
   * Client key. Default: `c.ip` — with `proxy: true` this reads the
   * attacker-controllable X-Forwarded-For, so proxy deployments should
   * supply a trusted key (or put the limiter behind a trusted proxy).
   * Return a constant (e.g. "global") for a shared budget.
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
  /**
   * Max distinct keys retained (default 10_000). The store is swept on
   * touch: expired entries beyond this bound are evicted oldest-first, so
   * key-flooding attackers cannot grow memory unboundedly.
   */
  maxKeys?: number;
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
  const maxKeys = options.maxKeys ?? 10_000;
  const buckets = options.store ?? new Map<string, Bucket>();
  if (!Number.isFinite(limit) || limit < 1) {
    throw new TypeError("rateLimit() requires a positive limit");
  }
  if (!Number.isFinite(windowMs) || windowMs < 1) {
    throw new TypeError("rateLimit() requires a positive windowMs");
  }
  if (!Number.isFinite(maxKeys) || maxKeys < 1) {
    throw new TypeError("rateLimit() requires a positive maxKeys");
  }
  const takeSlot = (): void => {
    // Map iteration is insertion order: the OLDEST entries sit in front,
    // so a single pass evicts them first. Live (unexpired) entries near
    // the bound are evicted oldest-first too — a flood cannot buy more
    // memory than `maxKeys` entries.
    if (buckets.size <= maxKeys) return;
    const now = Date.now();
    let toDrop = buckets.size - maxKeys;
    for (const [k, bucket] of buckets) {
      if (toDrop <= 0) break;
      if (bucket.resetAt <= now || toDrop > 0) {
        buckets.delete(k);
        toDrop--;
      }
    }
  };
  return (c, next) => {
    const now = Date.now();
    const key = keyOf(c);
    const bucket = buckets.get(key);
    if (bucket === undefined || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      takeSlot();
      if (emitHeaders) {
        c.setHeader("RateLimit-Limit", String(limit));
        c.setHeader("RateLimit-Remaining", String(limit - 1));
        c.setHeader("RateLimit-Reset", String(Math.ceil(windowMs / 1000)));
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
            ? {
                "ratelimit-limit": String(limit),
                "ratelimit-remaining": "0",
                "ratelimit-reset": String(retrySeconds),
              }
            : {}),
        },
      });
    }
    bucket.count++;
    if (emitHeaders) {
      c.setHeader("RateLimit-Limit", String(limit));
      c.setHeader("RateLimit-Remaining", String(limit - bucket.count));
      c.setHeader("RateLimit-Reset", String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
    }
    return next();
  };
};
