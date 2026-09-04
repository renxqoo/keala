/**
 * responseCache — route-level response caching (opt-in).
 *
 * `app.get("/heavy", cache({ ttl: 60_000 }), handler)` — the middleware
 * captures eligible responses and replays them as FRESH `Response` objects
 * per hit. Response INSTANCES are never reused: a fetch body consumes once,
 * so the cache stores the body text/bytes plus header pairs and rebuilds.
 *
 * Eligibility is deliberately conservative and hardcoded: GET, status 200,
 * an explicit TEXTUAL content-type, framework-built snapshot bodies (sugar
 * or state mode — finite by construction; streamed and hand-built Response
 * bodies are never captured: consuming an unknown stream inside the onion
 * would park the response on the producer and can never be bounded), no
 * set-cookie/vary, no cache-control private/no-store, cookies untouched by
 * the handler, no Authorization on the request. Memory is bounded TWICE:
 * an entry-count LRU (`max`) and a total byte budget (`maxBytes`) — a
 * count-only budget let a few dozen 4MB pages retain a process-sized heap.
 */

import type { RouteHandler } from "../router/router.ts";
import type { Context } from "../core/context/context.ts";
import { finalize } from "../core/respond.ts";

export interface ResponseCacheOptions {
  /** Time to live in milliseconds. Default 60_000. */
  ttl?: number;
  /** Maximum cached entries (LRU). Default 128. */
  max?: number;
  /**
   * Total byte budget for stored bodies (LRU evicts beyond it).
   * Default 64MiB — a count-only budget let ~128 large pages retain
   * hundreds of megabytes.
   */
  maxBytes?: number;
  /**
   * Largest single entry worth capturing. Default 4MiB — one monster
   * response must not evict the whole budget on its own.
   */
  maxEntryBytes?: number;
  /** Include the query string in the cache key. Default false. */
  includeQuery?: boolean;
}

interface CacheEntry {
  expires: number;
  body: string | Uint8Array;
  headers: [string, string][];
  /** Stored body size in bytes (HEAD replay Content-Length source). */
  sizeBytes: number;
}

// A response that must be revalidated before reuse must not enter a cache
// with no validator support (RFC 9111 §5.2.2.4) — bare `no-cache` and
// `max-age=0` both demand exactly that. Directives are case-insensitive
// (RFC 9111 §5.2), like every other regex here.
const NO_REVALIDATE = /(?:^|,)\s*(?:no-cache|no-store|private)\s*(?:,|$)/i;
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

/**
 * Capture the replayable body: text for plain textual representations, RAW
 * BYTES when a content-encoding is present — decoding an encoded payload as
 * `.text()` corrupts it (invalid UTF-8 becomes U+FFFD and re-encodes
 * differently), so an encoded representation must round-trip byte-exactly.
 * The caller has already proven the body finite (framework snapshot).
 */
const captureBody = (res: Response): Promise<string | Uint8Array | null> => {
  const clone = res.clone();
  if (res.headers.get("content-encoding") !== null) {
    return clone
      .arrayBuffer()
      .then((buf) => new Uint8Array(buf))
      .catch(() => null);
  }
  return clone.text().catch(() => null);
};

/**
 * A state-mode body is only capturable when it is inherently textual. A bare
 * Uint8Array/stream/Blob carries no framework content-type and its bytes
 * need not be valid UTF-8 — the `.text()` capture round-trip would corrupt
 * them on replay.
 */
const isTextualStateBody = (body: Context["bodyValue"]): boolean => {
  if (typeof body === "string") return true;
  return (
    body !== null &&
    typeof body === "object" &&
    !(body instanceof Uint8Array) &&
    !(body instanceof ReadableStream) &&
    !(body instanceof Blob)
  );
};

export const cache = (options: ResponseCacheOptions = {}): RouteHandler => {
  const ttl = options.ttl ?? 60_000;
  const max = options.max ?? 128;
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  const maxEntryBytes = Math.min(options.maxEntryBytes ?? 4 * 1024 * 1024, maxBytes);
  const includeQuery = options.includeQuery === true;
  const store = new Map<string, CacheEntry>();
  let totalBytes = 0;
  let warnedVary = false;

  const keyOf = (c: Context): string => {
    // HEAD shares the GET entry (same representation). The request authority
    // is part of the primary key (RFC 9111): one app serving several hosts
    // must never replay host A's answer to host B. The parts are joined with
    // "\n" — it can occur in neither a host header (fetch rejects CR/LF)
    // nor a serialized URL path — an undelimited `${host}${path}` let a
    // spoofed X-Forwarded-Host ("site/x" in proxy mode) forge ANOTHER
    // path's key and cross-path poison the store.
    const method = c.method === "HEAD" ? "GET" : c.method;
    const target = includeQuery ? `${c.path}?${c.querystring}` : c.path;
    return `${method}\n${c.host}\n${target}`;
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
    if (res.headers.get("vary") !== null) {
      // The common cause is ordering: compress() (or any Vary-appending
      // middleware) registered AFTER cache() marks every response variant
      // before cache() can look at it — silently disabling the cache.
      // Registering the transformer OUTSIDE cache() caches the clean
      // representation and transforms per hit instead.
      if (!warnedVary && c.app.env === "development") {
        warnedVary = true;
        console.warn(
          "keala(dev): cache() declined a Vary-carrying response — if compress()/cors() run after cache(), register them BEFORE cache() to cache the base representation",
        );
      }
      return false;
    }
    if (res.headers.getSetCookie().length > 0) return false;
    // A COMMITTED response must declare a textual content-type explicitly:
    // the D1 missing-CT-is-textual allowance exists for STATE-mode string
    // bodies (where the framework knows the kind), not for hand-built
    // Responses whose bytes need not be UTF-8 — capturing those as text
    // corrupted every replay.
    if (c._res !== undefined && !TEXTUAL.test(res.headers.get("content-type") ?? "")) {
      return false;
    }
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
      if (head.get("content-length") === null) {
        // The wire length of the STORED representation, recorded at capture
        // time — re-encoding the body per HEAD was a per-request cost.
        head.set("content-length", String(entry.sizeBytes));
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
      totalBytes -= cached.sizeBytes;
    }

    await next();

    if (!mayStore) return;
    // State-mode responses (the framework's koa-style API) commit only in the
    // finalizer, AFTER the onion. Decide capturability from the STATE first:
    // materializing (below) runs the same finalizer machinery the app uses,
    // which for a stream body wraps it in the onStreamError observer — that
    // locks the developer's stream with a getReader() the REAL finalizer then
    // trips over (a hard 500). Non-textual state bodies were never capturable
    // anyway; decline before touching anything.
    const stateMode = c._res === undefined;
    if (stateMode && !isTextualStateBody(c.bodyValue)) return;
    // Materialize the equivalent Response (without committing it) so
    // eligibility and capture see the same object the finalizer will build.
    // The discard is safe: nothing consumed the body (captureBody reads a
    // clone), and the finalizer re-derives an identical Response from the
    // untouched state.
    const res = c._res ?? (await finalize(c.app, c));
    if (!eligible(c, res)) return;
    // Only FRAMEWORK-BUILT snapshot bodies are capturable: the identity mark
    // (set by the sugar helpers and the state finalizer) proves the body is
    // a finite string/JSON text, so consuming the clone cannot park the
    // response on an open-ended producer. Streamed and hand-built Responses
    // carry no such proof — reading them here once deadlocked infinite
    // streams and buffered 2x their bytes before the client saw a byte.
    if (c.directBodyResponseValue !== res) return;
    const body = await captureBody(res);
    if (body === null || body.length === 0) return;
    const sizeBytes =
      typeof body === "string" ? encoder.encode(body).byteLength : body.byteLength;
    if (sizeBytes > maxEntryBytes) return;

    const headers: [string, string][] = [];
    for (const [name, value] of res.headers.entries()) {
      if (name === "x-cache") continue;
      headers.push([name, value]);
    }
    for (const cookie of res.headers.getSetCookie()) headers.push(["set-cookie", cookie]);

    // The TTL window starts when the REPRESENTATION was produced (after the
    // handler settled), not when the request began — a handler slower than
    // the ttl would otherwise mint entries that are born expired.
    store.set(key, { expires: Date.now() + ttl, body, headers, sizeBytes });
    totalBytes += sizeBytes;
    // LRU eviction keeps the freshest `max` entries within BOTH budgets —
    // a count-only budget let a few dozen large pages pin the heap.
    while (store.size > max || totalBytes > maxBytes) {
      const oldest = store.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const evicted = store.get(oldest);
      store.delete(oldest);
      totalBytes -= evicted?.sizeBytes ?? 0;
    }
  };
};
