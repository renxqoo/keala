/**
 * Authentication components: `basicAuth` / `bearerAuth` middleware and
 * password hashing (`hashPassword` / `verifyPassword`).
 *
 * The default hasher is WebCrypto PBKDF2-SHA-256 (600k iterations, 16-byte
 * salt, constant-time comparison) — it works identically under Bun and
 * Node (Bun 1.4.0's `node:crypto.scrypt` rejects with `undefined` and its
 * `Bun.password.verify` throws `UnsupportedAlgorithm` even for its own
 * argon2id/bcrypt hashes on some platforms; neither is defaultable).
 * `bunPasswordHasher()` opts into argon2id explicitly where it works.
 *
 * Credential verification inside the middleware always delegates to the
 * caller's `verify` — never compare plaintext strings with `===`.
 */

import { timingSafeEqual } from "node:crypto";
import type { RouteHandler } from "../router/router.ts";

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
}

/** Bun.password (argon2id/bcrypt) — explicit opt-in, see the module header. */
export const bunPasswordHasher = (): PasswordHasher => {
  if (typeof Bun === "undefined") {
    throw new Error("bunPasswordHasher() requires the Bun runtime");
  }
  const password = (Bun as { password?: unknown }).password;
  if (typeof password !== "object" || password === null) {
    throw new Error("bunPasswordHasher() requires Bun.password (Bun >= 1.1.14)");
  }
  const { hash, verify } = password as {
    hash?: unknown;
    verify?: unknown;
  };
  if (typeof hash !== "function" || typeof verify !== "function") {
    throw new Error("bunPasswordHasher() found a malformed Bun.password shape");
  }
  return password as unknown as PasswordHasher;
};

/** PBKDF2 iteration count (OWASP 2023 guidance for PBKDF2-HMAC-SHA-256). */
const ITERATIONS = 600_000;
/** Verification bounds: a hostile hash string must not turn verify into a CPU bomb. */
const MIN_ITERATIONS = 1_000;
const MAX_ITERATIONS = 5_000_000;
const KEY_BITS = 256;

const encoder = new TextEncoder();

const derive = async (
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> => {
  const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations },
      material,
      KEY_BITS,
    ),
  );
};

/**
 * The default hasher: `pbkdf2$<iterations>$<salt b64>$<key b64>`, WebCrypto
 * PBKDF2-SHA-256 with constant-time comparison. Runs on Bun and Node alike.
 */
export const pbkdf2PasswordHasher = (): PasswordHasher => ({
  async hash(password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await derive(password, salt, ITERATIONS);
    return `pbkdf2$${ITERATIONS}$${Buffer.from(salt).toString("base64")}$${Buffer.from(key).toString("base64")}`;
  },
  async verify(hash, password) {
    const parts = hash.split("$");
    if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
    const [, iterationsText, saltB64, keyB64] = parts as [string, string, string, string];
    if (!/^\d+$/.test(iterationsText)) return false;
    const iterations = Number(iterationsText);
    if (iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) return false;
    const salt = new Uint8Array(Buffer.from(saltB64, "base64"));
    const expected = new Uint8Array(Buffer.from(keyB64, "base64"));
    if (salt.length === 0 || expected.length === 0) return false;
    const actual = await derive(password, salt, iterations).catch(() => null);
    if (actual === null || actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  },
});

const defaultHasher = pbkdf2PasswordHasher;

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
  // Our own pbkdf2 format verifies everywhere and is the default output.
  if (hash.startsWith("pbkdf2$")) return pbkdf2PasswordHasher().verify(hash, password);
  // PHC formats ($argon2…, $2b…) need an explicit hasher — Bun 1.4.0's
  // native verify is unreliable (see module header), so defaulting to it
  // would flip between working and throwing per platform. Refuse loudly.
  if (hash.startsWith("$")) {
    throw new Error(
      `verifyPassword() cannot verify ${hash.slice(0, 8)}… hashes by default — pass bunPasswordHasher() (or your own hasher) explicitly`,
    );
  }
  // Anything else is corrupt data: fail CLOSED, not with an exception.
  return false;
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
