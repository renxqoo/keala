/**
 * Request guards — HTTP authentication middleware (handlers layer).
 *
 * - basicAuth: RFC 7617 (case-insensitive scheme, UTF-8-fatal decode,
 *   NUL/whitespace/control rejection, length caps, escaped realm challenge)
 * - bearerAuth: RFC 6750 (opaque-token validation, error="invalid_token")
 *
 * Credential verification always delegates to the caller's `verify` —
 * never compare plaintext strings with `===`; pair with the password
 * helpers (`keala/helpers/password`) for PBKDF2/argon2 round-trips.
 */

import type { RouteHandler } from "../router/router.ts";

// ---------------------------------------------------------------------------
// Basic authentication (RFC 7617)
// ---------------------------------------------------------------------------

export interface BasicAuthOptions {
  /** Accept the credentials; compare hashes, never plaintext with `===`. */
  verify(username: string, password: string): boolean | Promise<boolean>;
  /** Protection space label. Default "Restricted". */
  realm?: string;
}

const MAX_CREDENTIAL_BYTES = 1024;

const decodeBasic = (encoded: string): { username: string; password: string } | null => {
  if (encoded.length === 0 || encoded.length > 2048) return null;
  try {
    // Whitespace is tolerated by some base64 decoders; strip it ourselves.
    const bytes = Buffer.from(encoded.replaceAll(/\s+/g, ""), "base64");
    if (bytes.length === 0 || bytes.length > MAX_CREDENTIAL_BYTES) return null;
    // Invalid UTF-8 credentials are a rejection, not a crash.
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (decoded.includes("\0")) return null;
    const colon = decoded.indexOf(":");
    if (colon <= 0) return null; // no colon, or empty username
    return { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
  } catch {
    return null;
  }
};

/** Split an Authorization header into (lowercased scheme, remainder). */
const authScheme = (header: string): { scheme: string; rest: string } => {
  const space = header.indexOf(" ");
  if (space === -1) return { scheme: header.toLowerCase(), rest: "" };
  return { scheme: header.slice(0, space).toLowerCase(), rest: header.slice(space + 1) };
};

export const basicAuth = (options: BasicAuthOptions): RouteHandler => {
  if (typeof options?.verify !== "function") {
    throw new TypeError("basicAuth({ verify }) requires a verify function");
  }
  const realm = (options.realm ?? "Restricted").replaceAll('"', "");
  const challenge = `Basic realm="${realm}", charset="UTF-8"`;
  return async (c, next) => {
    // The auth-scheme is case-insensitive per RFC 7617.
    const { scheme, rest } = authScheme(c.get("authorization"));
    let accepted = false;
    if (scheme === "basic") {
      const credentials = decodeBasic(rest.trim());
      if (credentials !== null) {
        accepted = await options.verify(credentials.username, credentials.password);
      }
    }
    if (!accepted) {
      c.status = 401;
      c.setHeader("WWW-Authenticate", challenge);
      return;
    }
    await next();
  };
};

// ---------------------------------------------------------------------------
// Bearer authentication (RFC 6750)
// ---------------------------------------------------------------------------

export interface BearerAuthOptions {
  /** Accept the token; compare hashes, never plaintext with `===`. */
  verify(token: string): boolean | Promise<boolean>;
  /** Protection space label. Default "Restricted". */
  realm?: string;
}

const MAX_TOKEN_BYTES = 8192;

/** True for any whitespace or C0 control byte — never valid inside a token. */
const hasWhitespaceOrControl = (value: string): boolean => {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
};

export const bearerAuth = (options: BearerAuthOptions): RouteHandler => {
  if (typeof options?.verify !== "function") {
    throw new TypeError("bearerAuth({ verify }) requires a verify function");
  }
  const realm = (options.realm ?? "Restricted").replaceAll('"', "");
  const challenge = `Bearer realm="${realm}"`;
  return async (c, next) => {
    const { scheme, rest } = authScheme(c.get("authorization"));
    let token: string | null = null;
    if (scheme === "bearer") {
      const candidate = rest.trim();
      // One opaque token — internal whitespace/control bytes are malformed.
      token =
        candidate.length > 0 &&
        candidate.length <= MAX_TOKEN_BYTES &&
        !hasWhitespaceOrControl(candidate)
          ? candidate
          : null;
    }
    if (token === null) {
      c.status = 401;
      c.setHeader("WWW-Authenticate", challenge);
      return;
    }
    if (!(await options.verify(token))) {
      c.status = 401;
      // Present-but-rejected is `invalid_token` per RFC 6750 §3.
      c.setHeader("WWW-Authenticate", `${challenge}, error="invalid_token"`);
      return;
    }
    await next();
  };
};
