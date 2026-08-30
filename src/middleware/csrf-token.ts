/**
 * Signed CSRF tokens — the token-based companion to the Origin-checking
 * `csrf()` middleware (cookie-session browser flows need tokens).
 *
 * On Bun this rides `Bun.CSRF` natively (HMAC-signed, issue timestamp and
 * expiry baked in). On Node it falls back to an HMAC implementation with
 * the same semantics: a random nonce, the issue time, the TTL and the
 * session binding are all covered by the signature, and verification is
 * constant-time with both TTL and optional `maxAge` caps.
 *
 * The default secret Bun generates is per-thread and dies with the process
 * — production must pass an explicit shared `secret`.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createError } from "../http/errors.ts";
import type { Context } from "../core/context/context.ts";
import type { RouteHandler } from "../router/router.ts";

export type CsrfAlgorithm = "sha256" | "sha384" | "sha512";

export interface CsrfTokenOptions {
  /** HMAC secret (required — a per-process default does not survive restarts). */
  secret: string;
  /** Token lifetime in ms. Default 24h. */
  expiresIn?: number;
  /** Stricter verification cap in ms, independent of the token's own TTL. */
  maxAge?: number;
  /** HMAC algorithm. Default sha256. */
  algorithm?: CsrfAlgorithm;
}

export interface CsrfTokenService {
  /** Issue a token bound to `sessionId` (bind per visitor/session). */
  issue(sessionId?: string): string;
  /** Verify a token against the same `sessionId` it was issued with. */
  verify(token: string, sessionId?: string): boolean;
}

const DEFAULT_TTL = 86_400_000;
const MAX_TOKEN_LENGTH = 4096;

// t1.<nonce>.<issuedAtMs>.<ttlMs>.<mac> — every field except the format tag
// is covered by the MAC. The sessionId is base64url-encoded into the MAC
// input: it is caller-controlled, and a raw NUL in it could otherwise make
// two different (sessionId, nonce) splits produce the SAME MAC string
// (session-binding bypass). The "csrf1" domain separator keeps tokens
// useless to any other HMAC consumer sharing the same secret.
const sessionIdTag = (sessionId: string): string =>
  Buffer.from(sessionId, "utf8").toString("base64url");
const macInput = (sessionId: string, nonce: string, issuedAt: string, ttl: string): string =>
  `csrf1\u0000${sessionIdTag(sessionId)}\u0000${nonce}\u0000${issuedAt}\u0000${ttl}`;

interface NativeCsrf {
  generate(secret: string, options?: Record<string, unknown>): string;
  verify(token: string, options?: Record<string, unknown>): boolean;
}

const nativeCsrf = (): NativeCsrf | null => {
  if (typeof Bun === "undefined") return null;
  const csrf = (Bun as { CSRF?: unknown }).CSRF;
  if (typeof csrf !== "object" || csrf === null) return null;
  const { generate, verify } = csrf as { generate?: unknown; verify?: unknown };
  if (typeof generate !== "function" || typeof verify !== "function") return null;
  return csrf as unknown as NativeCsrf;
};

export const csrfToken = (options: CsrfTokenOptions): CsrfTokenService => {
  if (typeof options?.secret !== "string" || options.secret.length === 0) {
    throw new TypeError("csrfToken({ secret }) requires a non-empty secret");
  }
  if (options.secret.length > 1024) {
    throw new TypeError("csrfToken({ secret }) refuses secrets over 1024 bytes");
  }
  const ttl = options.expiresIn ?? DEFAULT_TTL;
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new TypeError("csrfToken({ expiresIn }) must be a positive number of ms");
  }
  const maxAge = options.maxAge;
  if (maxAge !== undefined && (!Number.isFinite(maxAge) || maxAge <= 0)) {
    throw new TypeError("csrfToken({ maxAge }) must be a positive number of ms");
  }
  const algorithm = options.algorithm ?? "sha256";
  const native = nativeCsrf();

  if (native !== null) {
    return {
      issue: (sessionId) =>
        native.generate(options.secret, {
          ...(sessionId !== undefined ? { sessionId } : {}),
          expiresIn: ttl,
          algorithm,
        }),
      verify: (token, sessionId) => {
        if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
          return false;
        }
        return native.verify(token, {
          secret: options.secret,
          ...(sessionId !== undefined ? { sessionId } : {}),
          ...(maxAge !== undefined ? { maxAge } : {}),
          algorithm,
        });
      },
    };
  }

  const sign = (value: string): Buffer =>
    createHmac(algorithm, options.secret).update(value).digest();

  return {
    issue(sessionId) {
      const nonce = randomBytes(16).toString("base64url");
      const issuedAt = Date.now().toString();
      const ttlText = ttl.toString();
      const mac = sign(macInput(sessionId ?? "", nonce, issuedAt, ttlText)).toString("base64url");
      return `t1.${nonce}.${issuedAt}.${ttlText}.${mac}`;
    },
    verify(token, sessionId) {
      if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
        return false;
      }
      // A literal NUL can only come from a delimiter-shifting forgery
      // attempt — real fields (base64url, digits) never contain one.
      if (token.includes("\0")) return false;
      const parts = token.split(".");
      if (parts.length !== 5 || parts[0] !== "t1") return false;
      const [tag, nonce, issuedAtText, ttlText, macText] = parts as [
        string,
        string,
        string,
        string,
        string,
      ];
      if (tag !== "t1" || !/^\d+$/.test(issuedAtText) || !/^\d+$/.test(ttlText)) return false;
      const issuedAt = Number(issuedAtText);
      const tokenTtl = Number(ttlText);
      if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(tokenTtl)) return false;
      if (tokenTtl <= 0) return false;
      const now = Date.now();
      // Future-issued tokens are forgeries; there is no clock skew allowance
      // because issuer and verifier share this process's clock.
      if (issuedAt > now) return false;
      const age = now - issuedAt;
      if (age > tokenTtl) return false;
      // Cap at THIS service's configured TTL too: a longer-TTL token minted
      // by another same-secret service must not outlive this policy.
      if (age > ttl) return false;
      if (maxAge !== undefined && age > maxAge) return false;
      const expected = sign(macInput(sessionId ?? "", nonce, issuedAtText, ttlText));
      const provided = Buffer.from(macText, "base64url");
      if (provided.length !== expected.length) return false;
      return timingSafeEqual(provided, expected);
    },
  };
};

// ---------------------------------------------------------------------------
// Guard middleware — header-based verification for state-changing requests
// ---------------------------------------------------------------------------

export interface CsrfTokenGuardOptions {
  service: CsrfTokenService;
  /**
   * Resolve the session a request belongs to; tokens are bound to it. A
   * resolver that yields undefined on an unsafe method is a rejection —
   * unbound tokens would be replayable across victims.
   */
  sessionId?: (c: Context) => string | undefined;
  /** Token header name. Default "x-csrf-token". */
  header?: string;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS", "TRACE"]);

export const csrfTokenGuard = (options: CsrfTokenGuardOptions): RouteHandler => {
  if (!options || typeof options.service !== "object") {
    throw new TypeError("csrfTokenGuard({ service }) requires a csrfToken() service");
  }
  const header = options.header ?? "x-csrf-token";
  const resolveSession = options.sessionId ?? ((): undefined => undefined);
  const requireSession = options.sessionId !== undefined;
  return async (c, next) => {
    if (SAFE_METHODS.has(c.method)) return next();
    const token = c.get(header);
    if (token.length === 0) {
      throw createError(403, "missing CSRF token", { expose: true });
    }
    const session = resolveSession(c);
    if (requireSession && session === undefined) {
      throw createError(403, "missing session for CSRF verification", { expose: true });
    }
    if (!options.service.verify(token, session)) {
      throw createError(403, "invalid CSRF token", { expose: true });
    }
    return next();
  };
};
