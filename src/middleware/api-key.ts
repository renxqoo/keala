/**
 * API-key authentication — the `X-API-Key` request guard.
 *
 * Static keys compare with `timingSafeEqual` (M7) — never `===` on
 * plaintext; dynamic validation delegates to the caller's `verify` (the
 * database-lookup shape). Challenge responses follow the same three-way
 * split as bearerAuth (RFC 6750 §3.1): a MISSING header is a plain 401
 * challenge, a PRESENT-but-malformed key is 400 `invalid_request`, and a
 * well-formed key that fails verification is 401 `invalid_token`.
 */

import { hasWhitespaceOrControl, realmPayload, timingSafeEqual } from "./auth.ts";
import { statusMessage } from "../http/status.ts";
import type { RouteHandler } from "../router/router.ts";

export interface ApiKeyAuthOptions {
  /**
   * Accept the key; compare hashes, never plaintext with `===`. The result
   * is judged strictly — only a resolved `true` admits; any other value
   * (false, undefined, a truthy non-boolean) rejects. A `verify` that
   * accidentally returns a record/string cannot grant access.
   */
  verify?(key: string): boolean | Promise<boolean>;
  /** Static key(s) — timing-safe comparison (no `verify` needed). */
  keys?: string | string[];
  /** Header carrying the key. Default "x-api-key" (case-insensitive). */
  header?: string;
  /** Protection space label. Default "Restricted". */
  realm?: string;
}

/** Same cap as bearerAuth's tokens — a longer key is malformed, not slow. */
const MAX_KEY_LENGTH = 8192;

export const apiKeyAuth = (options: ApiKeyAuthOptions): RouteHandler => {
  const keysOption = options.keys;
  const hasKeys = keysOption !== undefined;
  const keys: string[] = Array.isArray(keysOption)
    ? keysOption
    : keysOption !== undefined
      ? [keysOption]
      : [];
  // Setup-time validation, once: exactly one of { keys, verify } must be
  // given — both makes `verify` dead code, neither rejects everything.
  if (hasKeys && typeof options?.verify === "function") {
    throw new TypeError("apiKeyAuth: provide either { keys } or { verify }, not both");
  }
  if (!hasKeys && typeof options?.verify !== "function") {
    throw new TypeError("apiKeyAuth requires { verify } or { keys }");
  }
  const headerName = options.header ?? "x-api-key";
  if (headerName.length === 0) {
    throw new TypeError("apiKeyAuth: header must be a non-empty header name");
  }
  const challenge = `ApiKey realm="${realmPayload("apiKeyAuth", options.realm)}"`;
  // The per-request credential check, resolved at setup: static keys go
  // through timingSafeEqual, dynamic ones through the caller's verify.
  const check = hasKeys
    ? (key: string): boolean => keys.some((k) => timingSafeEqual(k, key))
    : (options.verify as (key: string) => boolean | Promise<boolean>);
  return async (c, next) => {
    const raw = c.header(headerName);
    // fetch headers cannot distinguish an absent header from an empty one —
    // both are "no credential presented" (401), never a 400.
    if (raw.length === 0) {
      return c.text(statusMessage(401), 401, { "www-authenticate": challenge });
    }
    const key = raw.trim();
    // PRESENT but malformed (blank, internal whitespace/control bytes,
    // oversized) is invalid_request (400) — the RFC 6750 §3.1 split.
    if (key.length === 0 || key.length > MAX_KEY_LENGTH || hasWhitespaceOrControl(key)) {
      return c.text(statusMessage(400), 400, {
        "www-authenticate": `${challenge}, error="invalid_request"`,
      });
    }
    // Strict truth: only a resolved `true` from verify() admits.
    if ((await check(key)) !== true) {
      return c.text(statusMessage(401), 401, {
        "www-authenticate": `${challenge}, error="invalid_token"`,
      });
    }
    await next();
  };
};
