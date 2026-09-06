/**
 * jwks — remote JWKS key source for OIDC-style JWT verification (N5).
 *
 * The IdP publishes its public keys at a well-known JWKS endpoint
 * (RFC 7517); this middleware fetches that document on a TTL, imports the
 * RSA/EC public keys once, and answers `verify(token)` by matching the
 * token header's `kid` against the cached set. Signature checking itself
 * is `verifyJWT` from the jwt tier — the same whitelist and claims rules
 * as any other keala-verified token.
 *
 * Operational contract:
 * - kid-indexed cache with a TTL (default 5 min); a kid MISS re-checks the
 *   endpoint once (key rotation at the IdP) but no oftener than the TTL, and
 *   a HIT never fetches
 * - single-flight refresh: concurrent cold verifies share one fetch
 * - a network/endpoint failure serves the STALE cache rather than an empty
 *   one (and backs off one TTL before retrying); only a cold cache that
 *   cannot fetch answers false
 * - `warmup()` is a middleware: the first request loads the key set, a
 *   failure is swallowed so startup is never blocked — the next key need
 *   retries in the background
 * - `kty: "oct"` (an HMAC secret) never belongs in a JWKS and is skipped,
 *   as is any unsupported kty/curve; one malformed key entry cannot sink
 *   the rest of the set
 *
 * ```ts
 * const keys = jwks({ url: "https://auth/.well-known/jwks.json", cache: 300_000 });
 * app.use(keys.warmup());
 * const ok = await keys.verify(bearerToken); // boolean, never throws
 * ```
 */

import { verifyJWT } from "./jwt.ts";
import type { webcrypto } from "node:crypto";
import type { RouteHandler } from "../router/router.ts";

/** One public key exactly as the JWKS document publishes it (RFC 7517 §5). */
export interface JwkKey {
  /** Key family: "RSA" | "EC" here (anything else is skipped). */
  kty: string;
  /** Key id — the join key against JWT header `kid`. */
  kid?: string;
  /** Intended algorithm, e.g. "RS256"; an alg-less RSA key defaults to RS256. */
  alg?: string;
  /** Intended use; published for information, not re-enforced here. */
  use?: string;
  /** RSA modulus (base64url). */
  n?: string;
  /** RSA public exponent (base64url). */
  e?: string;
  /** EC curve: P-256 | P-384 | P-521. */
  crv?: string;
  /** EC x coordinate (base64url). */
  x?: string;
  /** EC y coordinate (base64url). */
  y?: string;
  [member: string]: unknown;
}

export interface JwksOptions {
  /** The IdP's JWKS endpoint, e.g. `https://auth.example.com/.well-known/jwks.json`. */
  url: string;
  /** Cache TTL in milliseconds. Default 300_000 (5 minutes). */
  cache?: number;
}

/** The fetched-and-imported key source returned by `jwks()`. */
export interface JwksKeys {
  /** Middleware: loads the key set on the first request, never blocks on failure. */
  warmup(): RouteHandler;
  /**
   * Verify a JWT against the cached key matching its header `kid`. Resolves
   * false for every failure (unknown kid, bad signature, expired claims,
   * endpoint down with a cold cache) — it never rejects.
   */
  verify(token: string): Promise<boolean>;
  /** Force a re-fetch now, TTL notwithstanding. Rejects on network failure. */
  refresh(): Promise<void>;
  /** The currently cached key set (re-fetching first when stale). */
  keys(): Promise<JwkKey[]>;
}

const DEFAULT_CACHE_MS = 300_000;
/** RS* → import hash; an alg-less RSA JWK imports as RS256. */
const RSA_HASH_OF_ALG: Readonly<Record<string, string>> = {
  RS256: "SHA-256",
  RS384: "SHA-384",
  RS512: "SHA-512",
};
/** EC curve → import hash (P-521 is the ES512 curve — WebCrypto spells it 521). */
const EC_HASH_OF_CURVE: Readonly<Record<string, string>> = {
  "P-256": "SHA-256",
  "P-384": "SHA-384",
  "P-521": "SHA-512",
};

/** Import parameters for a supported public JWK, or null for anything the
 * WebCrypto verify path cannot take (oct, unknown kty, unknown curve/alg). */
const importParams = (
  jwk: JwkKey,
):
  | webcrypto.RsaHashedImportParams
  | (webcrypto.EcdsaParams & webcrypto.EcKeyImportParams)
  | null => {
  if (jwk.kty === "RSA") {
    const hash = jwk.alg === undefined ? "SHA-256" : RSA_HASH_OF_ALG[jwk.alg];
    // An RSA key pinned to a non-RS* alg (PS256…) is not importable as a
    // PKCS#1 v1.5 verify key — skip it rather than mis-verify.
    return hash === undefined ? null : { name: "RSASSA-PKCS1-v1_5", hash };
  }
  if (jwk.kty === "EC" && typeof jwk.crv === "string") {
    const hash = EC_HASH_OF_CURVE[jwk.crv];
    if (hash === undefined) return null;
    return { name: "ECDSA", namedCurve: jwk.crv, hash };
  }
  // An HMAC secret ("oct") in a JWKS is a publisher bug, not a key we trust.
  return null;
};

/** The `kid` of a JWT header, or undefined for any malformed/absent shape. */
const kidOf = (token: string): string | undefined => {
  const dot = token.indexOf(".");
  if (dot <= 0) return undefined;
  try {
    const header = JSON.parse(Buffer.from(token.slice(0, dot), "base64url").toString()) as {
      kid?: unknown;
    };
    return typeof header.kid === "string" ? header.kid : undefined;
  } catch {
    return undefined;
  }
};

export const jwks = (options: JwksOptions): JwksKeys => {
  if (typeof options?.url !== "string" || options.url.length === 0) {
    throw new TypeError("jwks({ url }) requires the IdP's JWKS endpoint");
  }
  const ttl = options.cache ?? DEFAULT_CACHE_MS;
  if (typeof ttl !== "number" || !Number.isFinite(ttl) || ttl < 0) {
    throw new TypeError("jwks({ cache }) must be a non-negative number of milliseconds");
  }

  interface CachedKey {
    key: CryptoKey;
    jwk: JwkKey;
  }
  let cached = new Map<string, CachedKey>();
  let fetchedAt = 0;
  let missCheckedAt = 0; // last unknown-kid re-check — the miss-cooldown clock
  let flight: Promise<void> | null = null;

  const fresh = (): boolean => Date.now() - fetchedAt < ttl;

  /** Fetch + import the whole key set. On failure with a warm cache the stale
   * set stays and the timestamp advances (one TTL of backoff) — then the
   * error propagates so an explicit `refresh()` caller still sees it. */
  const refresh = async (): Promise<void> => {
    if (flight !== null) return flight; // single flight: concurrent callers share
    flight = (async () => {
      try {
        const res = await fetch(options.url);
        if (!res.ok) throw new Error(`jwks: ${options.url} answered ${res.status}`);
        const doc = (await res.json()) as { keys?: unknown };
        if (typeof doc !== "object" || doc === null || !Array.isArray(doc.keys)) {
          throw new TypeError("jwks: document is not { keys: [...] }");
        }
        const next = new Map<string, CachedKey>();
        for (const entry of doc.keys) {
          if (typeof entry !== "object" || entry === null) continue;
          const jwk = entry as JwkKey;
          const params = importParams(jwk);
          if (params === null) continue;
          try {
            next.set(jwk.kid ?? "", {
              key: await crypto.subtle.importKey("jwk", jwk, params, false, ["verify"]),
              jwk,
            });
          } catch {
            // One unimportable entry is skipped — the rest of the set serves.
          }
        }
        cached = next;
        fetchedAt = Date.now();
      } catch (err) {
        // Stale-serving: keep answering with the last good set, and back off
        // one full TTL before the next automatic retry.
        if (cached.size > 0) fetchedAt = Date.now();
        throw err;
      } finally {
        flight = null;
      }
    })();
    return flight;
  };

  /** Refresh when stale; swallow the failure while a stale set can serve. */
  const ensureFresh = async (): Promise<void> => {
    if (fresh()) return;
    try {
      await refresh();
    } catch (err) {
      if (cached.size === 0) throw err; // nothing to serve — let the caller decide
    }
  };

  const lookup = (kid: string | undefined): CachedKey | undefined => {
    if (kid !== undefined) return cached.get(kid);
    // A kid-less token against a single-key set: that one key is the match.
    if (cached.size !== 1) return undefined;
    return cached.values().next().value ?? undefined;
  };

  let warmed = false;
  const warmup = (): RouteHandler => {
    return async (_c, next) => {
      if (!warmed) {
        warmed = true;
        // First fetch failure must never block the request or the boot — the
        // next key need retries in the background.
        try {
          await ensureFresh();
        } catch {
          /* cold and unreachable: verify() keeps answering false */
        }
      }
      await next();
    };
  };

  const verify = async (token: string): Promise<boolean> => {
    if (typeof token !== "string") return false;
    try {
      await ensureFresh();
    } catch {
      return false; // cold cache and the endpoint is down
    }
    const kid = kidOf(token);
    let entry = lookup(kid);
    if (entry === undefined) {
      // Unknown kid: the IdP may have rotated since our last fetch — re-check
      // the endpoint once, but no oftener than the TTL (a hostile kid storm
      // must not turn every request into an IdP fetch).
      if (Date.now() - missCheckedAt >= ttl) {
        missCheckedAt = Date.now();
        try {
          await refresh();
        } catch {
          return false;
        }
        entry = lookup(kid);
      }
      if (entry === undefined) return false;
    }
    try {
      await verifyJWT(token, entry.key);
      return true;
    } catch {
      return false; // shape, algorithm, signature or claims failure
    }
  };

  const keys = async (): Promise<JwkKey[]> => {
    await ensureFresh();
    const list: JwkKey[] = [];
    for (const entry of cached.values()) list.push(entry.jwk);
    return list;
  };

  return { warmup, verify, refresh, keys };
};
