/**
 * Password hashing utilities — the default is WebCrypto PBKDF2-SHA-256
 * (600k iterations, 16-byte salt, constant-time comparison) that works
 * identically under Bun and Node (Bun 1.4.0's `node:crypto.scrypt` rejects
 * with `undefined` and its `Bun.password.verify` throws
 * `UnsupportedAlgorithm` even for its own argon2id/bcrypt hashes on some
 * platforms; neither is defaultable). `bunPasswordHasher()` opts into
 * argon2id explicitly where it works.
 *
 * Called INSIDE handlers (login/signup routes) — helper layer, not
 * middleware; the request guards live in `middleware/auth.ts`.
 */

import { nodeCrypto } from "../utils/node-lazy.ts";

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
    return nodeCrypto().timingSafeEqual(actual, expected);
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
