/**
 * Authentication components: `basicAuth` / `bearerAuth` middleware and
 * password hashing (`hashPassword` / `verifyPassword`).
 *
 * Password hashing rides `Bun.password` (argon2id by default; verification
 * auto-detects the stored algorithm, hashing runs off-thread) and falls
 * back to a node:crypto scrypt implementation with constant-time
 * comparison under Node. Both directions accept an injected hasher.
 *
 * Credential verification inside the middleware always delegates to the
 * caller's `verify` — never compare plaintext strings with `===`.
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import type { RouteHandler } from "../router/router.ts";

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
}

/** Bun.password: argon2id default, verification auto-detects the algorithm. */
const bunPassword = (): PasswordHasher | null => {
  if (typeof Bun === "undefined") return null;
  const password = (Bun as { password?: unknown }).password;
  if (typeof password !== "object" || password === null) return null;
  const { hash, verify } = password as {
    hash?: unknown;
    verify?: unknown;
  };
  if (typeof hash !== "function" || typeof verify !== "function") return null;
  return password as unknown as PasswordHasher;
};

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 } as const;

const scryptAsync = (password: string, salt: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      SCRYPT.keylen,
      { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p },
      (error, key) => (error === null ? resolve(key) : reject(error)),
    );
  });

/** `scrypt$<N>$<r>$<p>$<salt b64>$<key b64>` — the Node-runtime fallback. */
const scryptHasher = (): PasswordHasher => ({
  async hash(password) {
    const salt = randomBytes(16);
    const key = await scryptAsync(password, salt);
    return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
  },
  async verify(hash, password) {
    const parts = hash.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const [tag, n, r, p, saltB64, keyB64] = parts as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (tag !== "scrypt" || !/^\d+$/.test(n) || !/^\d+$/.test(r) || !/^\d+$/.test(p)) return false;
    const expected = Buffer.from(keyB64, "base64");
    const salt = Buffer.from(saltB64, "base64");
    if (expected.length === 0 || salt.length === 0) return false;
    const actual = await scryptAsync(password, salt).catch(() => null);
    if (actual === null || actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  },
});

const defaultHasher = (): PasswordHasher => bunPassword() ?? scryptHasher();

export const hashPassword = async (password: string, hasher?: PasswordHasher): Promise<string> => {
  if (typeof password !== "string" || password.length === 0) {
    throw new TypeError("hashPassword() requires a non-empty password string");
  }
  if (password.length > 1024) {
    throw new TypeError("hashPassword() refuses passwords over 1024 bytes");
  }
  return (hasher ?? defaultHasher()).hash(password);
};

export const verifyPassword = async (
  hash: string,
  password: string,
  hasher?: PasswordHasher,
): Promise<boolean> => {
  if (typeof hash !== "string" || hash.length === 0) return Promise.resolve(false);
  if (typeof password !== "string" || password.length === 0) return Promise.resolve(false);
  if (hash.length > 512) return Promise.resolve(false);
  if (password.length > 1024) return Promise.resolve(false);
  if (hasher !== undefined) return hasher.verify(hash, password);
  // Our own scrypt format verifies everywhere. Otherwise the native
  // verifier is the authority (it fails closed on unknown formats); only
  // WITHOUT Bun.password does a non-PHC format mean corrupt data → false,
  // while a $argon2…/$2b… hash throws (unverifiable, not silently false).
  if (hash.startsWith("scrypt$")) return scryptHasher().verify(hash, password);
  const native = bunPassword();
  if (native !== null) return native.verify(hash, password);
  if (!hash.startsWith("$")) return false;
  throw new Error(
    `verifyPassword() cannot verify ${hash.slice(0, 8)}… hashes without Bun.password — pass an explicit hasher`,
  );
};

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
      c.set("WWW-Authenticate", challenge);
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
      c.set("WWW-Authenticate", challenge);
      return;
    }
    if (!(await options.verify(token))) {
      c.status = 401;
      // Present-but-rejected is `invalid_token` per RFC 6750 §3.
      c.set("WWW-Authenticate", `${challenge}, error="invalid_token"`);
      return;
    }
    await next();
  };
};
