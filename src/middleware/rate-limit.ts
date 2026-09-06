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

/** One fixed window's counter: hits so far, and when the window closes. */
export interface RateLimitBucket {
  count: number;
  resetAt: number;
}

/**
 * Shared store contract (0.8): admission is ONE `hit()` call that atomically
 * increments and lapses expired windows. A Redis adapter maps this directly
 * to `INCR` + `EXPIRE` (natively atomic), so two workers can never both read
 * count=99 and both admit — the failure mode the 0.7 Map get/set shape
 * invited once the store crossed a network boundary.
 */
export interface RateLimitStore {
  /**
   * Record one hit and return the bucket AFTER the increment: count 1 with a
   * fresh resetAt on a new or lapsed window, count+1 otherwise. `max` is the
   * window's request limit — adapters MAY use it (e.g. to cap counters); the
   * memory store does not need it.
   */
  hit(key: string, windowMs: number, max: number): RateLimitBucket;
  /** Read-only bucket lookup (Retry-After math, observability). */
  get(key: string): RateLimitBucket | undefined;
}

/**
 * The built-in Map-backed store (the rateLimit() default): hit() with
 * window-lapse reset and an insertion-order eviction bound — Map iteration
 * order puts the OLDEST entries first, so one pass evicts them. Expiry is
 * deliberately NOT consulted for eviction: the bound is a memory guarantee
 * and must hold even when every retained entry is still live (an expired
 * bucket is simply re-created on its next touch). A key flood cannot buy
 * more than `maxKeys` entries.
 */
export const memoryRateLimitStore = (maxKeys = 10_000): RateLimitStore => {
  const buckets = new Map<string, RateLimitBucket>();
  return {
    hit(key: string, windowMs: number): RateLimitBucket {
      const now = Date.now();
      const bucket = buckets.get(key);
      if (bucket !== undefined && bucket.resetAt > now) {
        bucket.count += 1;
        return bucket;
      }
      const fresh: RateLimitBucket = { count: 1, resetAt: now + windowMs };
      buckets.set(key, fresh);
      if (buckets.size > maxKeys) {
        let toDrop = buckets.size - maxKeys;
        for (const oldest of buckets.keys()) {
          if (toDrop <= 0) break;
          buckets.delete(oldest);
          toDrop--;
        }
      }
      return fresh;
    },
    get(key: string): RateLimitBucket | undefined {
      return buckets.get(key);
    },
  };
};

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
   * Shared store for multi-process deployments: a `{ hit, get }` object
   * (0.8 — a bare Map is NO LONGER accepted; its get/set read-modify-write
   * raced across workers). The default is `memoryRateLimitStore(maxKeys)`;
   * Redis adapters own their atomicity (INCR + EXPIRE is natively so).
   */
  store?: RateLimitStore;
  /**
   * Max distinct keys retained by the DEFAULT memory store (default 10_000).
   * Ignored when an explicit `store` is supplied — bounding that store is
   * the adapter's job.
   */
  maxKeys?: number;
}

export const rateLimit = (options: RateLimitOptions = {}): RouteHandler => {
  const limit = options.limit ?? 100;
  const windowMs = options.windowMs ?? 60_000;
  const retryAfter = options.retryAfterSeconds ?? 1;
  const keyOf = options.key ?? ((c: Context) => c.ip);
  const emitHeaders = options.headers === true;
  const maxKeys = options.maxKeys ?? 10_000;
  const store = options.store ?? memoryRateLimitStore(maxKeys);
  if (!Number.isFinite(limit) || limit < 1) {
    throw new TypeError("rateLimit() requires a positive limit");
  }
  if (!Number.isFinite(windowMs) || windowMs < 1) {
    throw new TypeError("rateLimit() requires a positive windowMs");
  }
  if (!Number.isFinite(maxKeys) || maxKeys < 1) {
    throw new TypeError("rateLimit() requires a positive maxKeys");
  }
  if (typeof store.hit !== "function" || typeof store.get !== "function") {
    throw new TypeError(
      "rateLimit({ store }) requires the 0.8 { hit, get } interface — a bare Map is no longer accepted (get/set read-modify-write races across workers); wrap one with memoryRateLimitStore(maxKeys), or adapt Redis via INCR + EXPIRE",
    );
  }
  return (c, next) => {
    const now = Date.now();
    const key = keyOf(c);
    // The single atomic admission call: hit() increments AND lapses expired
    // windows, so the count this request is judged on is the store's own
    // post-increment truth.
    const bucket = store.hit(key, windowMs, limit);
    if (bucket.count > limit) {
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
    if (emitHeaders) {
      c.setHeader("RateLimit-Limit", String(limit));
      c.setHeader("RateLimit-Remaining", String(Math.max(0, limit - bucket.count)));
      c.setHeader("RateLimit-Reset", String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
    }
    return next();
  };
};
