/**
 * responseCache — route-level response caching (STATE REBUILD, opt-in).
 *
 * `app.get("/heavy", cache({ ttl: 60_000 }), handler)` — the middleware
 * captures eligible responses (via `clone()`, never touching the original)
 * and replays them as FRESH `Response` objects per hit. Response INSTANCES
 * are never reused: Bun consumes a body once (ERR_BODY_ALREADY_USED), so the
 * cache stores the body string/bytes plus header pairs and rebuilds.
 *
 * Eligibility is deliberately conservative and hardcoded: GET, status 200,
 * text-ish bodies, no set-cookie/vary, no cache-control private/no-store,
 * cookies untouched by the handler, no Authorization on the request. Anything
 * else always computes fresh.
 */

import type { RouteHandler } from "../router/router.ts";
import type { Context } from "../core/context/context.ts";

export interface ResponseCacheOptions {
  /** Time to live in milliseconds. Default 60_000. */
  ttl?: number;
  /** Maximum cached entries (LRU). Default 128. */
  max?: number;
  /** Include the query string in the cache key. Default false. */
  includeQuery?: boolean;
}

interface CacheEntry {
  expires: number;
  body: string | Uint8Array;
  headers: [string, string][];
}

// A response that must be revalidated before reuse must not enter a cache
// with no validator support (RFC 9111 §5.2.2.4) — bare `no-cache` and
// `max-age=0` both demand exactly that.
const NO_REVALIDATE = /(?:^|,)\s*(?:no-cache|no-store|private)\s*(?:,|$)/;
const MAX_AGE_ZERO = /(?:^|,)\s*max-age\s*=\s*0\s*(?:,|$)/i;
// A field-specific no-cache names a header the response depends on —
// Set-Cookie responses must not be replayed from the framework cache.
const NO_CACHE_FIELD = /(?:^|,)\s*no-cache\s*=\s*"(?:set-cookie|\*)"\s*(?:,|$)/i;
const TEXTUAL = /^(?:text\/|application\/(?:json|javascript|xml|graphql))/;
const encoder = new TextEncoder();

/** Directives of a Cache-Control header, lowercased tokens (`no-cache="x"`
 * counts as its token). */
const cacheControlTokens = (header: string): Set<string> => {
  const tokens = new Set<string>();
  for (const raw of header.split(",")) {
    const token = raw.split("=")[0]?.trim().toLowerCase();
    if (token !== undefined && token.length > 0) tokens.add(token);
  }
  return tokens;
};

const textualBody = (res: Response): Promise<string | Uint8Array | null> => {
  const type = (res.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
  // A MISSING content-type is textual per D1: a bare string body carries no
  // framework CT at construction (Bun only sets text/plain at send time), so
  // requiring the header would silently disable caching on the Bun runtime.
  if (type !== "" && !TEXTUAL.test(type)) return Promise.resolve(null);
  return res
    .clone()
    .text()
    .catch(() => null);
};

export const cache = (options: ResponseCacheOptions = {}): RouteHandler => {
  const ttl = options.ttl ?? 60_000;
  const max = options.max ?? 128;
  const includeQuery = options.includeQuery === true;
  const store = new Map<string, CacheEntry>();

  const keyOf = (c: Context): string => {
    // HEAD shares the GET entry (same representation). The request authority
    // is part of the primary key (RFC 9111): one app serving several hosts
    // must never replay host A's answer to host B.
    const method = c.method === "HEAD" ? "GET" : c.method;
    return `${method}:${c.host}${c.path}${includeQuery ? `?${c.querystring}` : ""}`;
  };

  const eligible = (c: Context, res: Response): boolean => {
    if (c.method !== "GET" && c.method !== "HEAD") return false;
    if (res.status !== 200) return false;
    // Identity-bearing requests never seed entries: Authorization AND the
    // request Cookie header (a handler personalizing on the raw header —
    // never touching the c.cookies facade — would otherwise be replayed to
    // every other user of the same URL).
    if (c.get("authorization").length > 0) return false;
    if (c.get("cookie").length > 0) return false;
    if (c.cookiesValue !== null) return false; // handler touched cookies
    const control = res.headers.get("cache-control") ?? "";
    if (NO_REVALIDATE.test(control) || MAX_AGE_ZERO.test(control)) return false;
    if (NO_CACHE_FIELD.test(control)) return false;
    if (res.headers.get("vary") !== null) return false;
    if (res.headers.getSetCookie().length > 0) return false;
    return true;
  };

  const storeHit = (key: string, entry: CacheEntry, c: Context): Response => {
    // LRU touch: re-insert as most recently used.
    store.delete(key);
    store.set(key, entry);
    const headers = new Headers();
    for (const [name, value] of entry.headers) headers.append(name, value);
    headers.set("x-cache", "hit");
    if (c.method === "HEAD") {
      const head = new Headers(headers);
      if (head.get("content-length") === null && typeof entry.body === "string") {
        // UTF-8 byte length — .length would undercount non-ASCII bodies.
        head.set("content-length", String(encoder.encode(entry.body).byteLength));
      }
      return new Response(null, { status: 200, headers: head });
    }
    return new Response(entry.body, { status: 200, headers });
  };

  return async (c, next) => {
    // Without includeQuery, ANY query string bypasses the cache outright —
    // keying on the path alone would replay one query's answer to another.
    if (!includeQuery && c.querystring.length > 0) {
      await next();
      return;
    }
    // Request-side directives (RFC 9111 §5.2.1.4/§5.2.1.5): a no-cache
    // request must not be served from storage (this cache has no validators
    // to revalidate with); a no-store request must not seed one either.
    const requestDirectives = cacheControlTokens(c.get("cache-control"));
    const bypassStored = requestDirectives.has("no-cache");
    const mayStore = !requestDirectives.has("no-store");
    const key = keyOf(c);
    const now = Date.now();
    const cached = store.get(key);
    if (cached !== undefined) {
      if (cached.expires > now && !bypassStored) return storeHit(key, cached, c);
      store.delete(key); // expired (or a revalidation demand evicted it)
    }

    await next();

    const res = c._res;
    if (res === undefined) return; // state-mode bodies: no committed Response to clone
    if (!mayStore) return;
    if (!eligible(c, res)) return;
    const body = await textualBody(res);
    if (body === null || body.length === 0) return;

    const headers: [string, string][] = [];
    for (const [name, value] of res.headers.entries()) {
      if (name === "x-cache") continue;
      headers.push([name, value]);
    }
    for (const cookie of res.headers.getSetCookie()) headers.push(["set-cookie", cookie]);

    store.set(key, { expires: now + ttl, body, headers });
    // LRU eviction keeps the freshest `max` entries.
    while (store.size > max) {
      const oldest = store.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      store.delete(oldest);
    }
  };
};
