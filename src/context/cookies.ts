/**
 * Cookies: RFC 6265 parsing/serialization, HMAC-SHA256 signing with key
 * rotation (Keygrip-compatible `value.signature` format) and the per-request
 * cookie facade used by `ctx.cookies`.
 */

import type { HeaderMap } from "../types.ts";
import { nodeCrypto } from "../utils/node-lazy.ts";
import { hasCrlf, isValidCookieName, isValidCookieValue } from "../utils/text.ts";

export interface CookieOptions {
  maxAge?: number;
  expires?: Date;
  path?: string;
  domain?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: boolean | "strict" | "lax" | "none";
  signed?: boolean;
  overwrite?: boolean;
  partitioned?: boolean;
  priority?: "low" | "medium" | "high";
}

export type SigningKeys = (string | Uint8Array)[];

const base64Url = (input: Uint8Array): string => Buffer.from(input).toString("base64url");

// The crypto bridge loads with the first signed cookie — unsigned apps never
// pay for it.
const hmac = (key: string | Uint8Array, value: string): Uint8Array => {
  const { createHmac } = nodeCrypto();
  return createHmac("sha256", key).update(value).digest();
};

/** Sign a value with the first key: `value.base64url(hmac(key, value))`. */
export const sign = (value: string, key: string | Uint8Array): string =>
  `${value}.${base64Url(hmac(key, value))}`;

/** Verify a signed value against any key; returns the original value or `false`. */
export const unsign = (signed: string, keys: SigningKeys): string | false => {
  const dot = signed.lastIndexOf(".");
  if (dot === -1) return false;
  const value = signed.slice(0, dot);
  const digest = Buffer.from(signed.slice(dot + 1), "base64url");
  const { timingSafeEqual } = nodeCrypto();
  for (const key of keys) {
    const expected = hmac(key, value);
    if (digest.length === expected.length && timingSafeEqual(digest, expected)) {
      return value;
    }
  }
  return false;
};

/** Parse a `Cookie` request header into a null-prototype map. */
export const parseCookies = (header: string | null): Record<string, string> => {
  const out: Record<string, string> = Object.create(null);
  if (header == null || header.length === 0) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    const name = eq === -1 ? part.trim() : part.slice(0, eq).trim();
    if (name.length === 0 || !isValidCookieName(name)) continue;
    const raw = eq === -1 ? "" : part.slice(eq + 1).trim();
    if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
      out[name] = tryDecode(raw.slice(1, -1));
      continue;
    }
    out[name] = tryDecode(raw);
  }
  return out;
};

const tryDecode = (input: string): string => {
  try {
    return decodeURIComponent(input);
  } catch {
    return input;
  }
};

/** Serialize a Set-Cookie header value. Throws on names/values that could smuggle headers. */
export const serializeCookie = (
  name: string,
  value: string,
  options: CookieOptions = {},
): string => {
  if (!isValidCookieName(name)) {
    throw new TypeError(`Invalid cookie name: ${JSON.stringify(name)}`);
  }
  if (!isValidCookieValue(value)) {
    throw new TypeError(
      `Invalid cookie value for "${name}": CTL, comma, semicolon, quote and backslash are not allowed`,
    );
  }
  let header = `${name}=${value}`;
  if (options.maxAge !== undefined) {
    if (!Number.isFinite(options.maxAge)) {
      throw new TypeError("cookie maxAge must be a finite number");
    }
    header += `; Max-Age=${Math.trunc(options.maxAge)}`;
  }
  if (options.expires !== undefined) {
    if (!(options.expires instanceof Date)) {
      throw new TypeError("cookie expires must be a Date");
    }
    header += `; Expires=${options.expires.toUTCString()}`;
  }
  if (options.domain !== undefined) {
    assertHeaderSafe("cookie domain", options.domain);
    header += `; Domain=${options.domain}`;
  }
  if (options.path !== undefined) {
    assertHeaderSafe("cookie path", options.path);
    header += `; Path=${options.path}`;
  }
  if (options.priority !== undefined) {
    const prio = String(options.priority).toLowerCase();
    if (prio !== "low" && prio !== "medium" && prio !== "high") {
      throw new TypeError(`Invalid cookie option priority: ${JSON.stringify(options.priority)}`);
    }
    header += `; Priority=${prio.charAt(0).toUpperCase()}${prio.slice(1)}`;
  }
  if (options.sameSite !== undefined) {
    const mode = options.sameSite === true ? "strict" : options.sameSite;
    if (mode !== false) {
      const site = String(mode).toLowerCase();
      // Whitelisted tokens only: an arbitrary string here would smuggle extra
      // attributes (`; Path=...`) or CR/LF into the Set-Cookie value.
      if (site !== "strict" && site !== "lax" && site !== "none") {
        throw new TypeError(`Invalid cookie option sameSite: ${JSON.stringify(options.sameSite)}`);
      }
      header += `; SameSite=${site.charAt(0).toUpperCase()}${site.slice(1)}`;
    }
  }
  if (options.partitioned === true) header += "; Partitioned";
  if (options.secure === true) header += "; Secure";
  if (options.httpOnly === true) header += "; HttpOnly";
  return header;
};

const assertHeaderSafe = (what: string, value: string): void => {
  if (hasCrlf(value) || value.includes(";")) {
    throw new TypeError(`Invalid ${what}: ${JSON.stringify(value)}`);
  }
};

export interface CookiesFacade {
  get(name: string, options?: { signed?: boolean }): string | undefined;
  set(name: string, value: string, options?: CookieOptions): void;
}

export interface CookiesHost {
  /** Request `Cookie` header (null when absent). */
  readonly cookieHeader: string | null;
  /** App signing keys (may be undefined for unsigned apps). */
  readonly keys: SigningKeys | undefined;
  /** Response header map receiving `Set-Cookie` values. */
  readonly responseHeaders: HeaderMap;
}

/** Create the per-request cookie facade. The parse result is computed lazily once. */
export const createCookies = (host: CookiesHost): CookiesFacade => {
  let jar: Record<string, string> | null = null;
  const jarOf = (): Record<string, string> => (jar ??= parseCookies(host.cookieHeader));

  return {
    get(name, options) {
      const raw = jarOf()[name];
      if (raw === undefined) return undefined;
      if (options?.signed !== false) {
        const keys = host.keys;
        if (keys === undefined || keys.length === 0) {
          // Fail closed like the `cookies` package: an explicit signed read
          // without configured keys is a misconfiguration, never raw trust.
          if (options?.signed === true) throw new Error(".keys required for signed cookies");
          return raw;
        }
        const unsigned = unsign(raw, keys);
        return unsigned === false ? undefined : unsigned;
      }
      return raw;
    },
    set(name, value, options = {}) {
      const keys = host.keys;
      const wantsSign = options.signed !== false && keys !== undefined && keys.length > 0;
      const serialized = serializeCookie(
        name,
        wantsSign ? sign(value, keys[0] as string | Uint8Array) : value,
        options,
      );
      const existing = host.responseHeaders["set-cookie"];
      if (options.overwrite === true || existing === undefined) {
        const next: string[] =
          options.overwrite === true && Array.isArray(existing)
            ? existing.filter((entry) => !entry.startsWith(`${name}=`))
            : Array.isArray(existing)
              ? [...existing]
              : existing === undefined
                ? []
                : [existing];
        next.push(serialized);
        host.responseHeaders["set-cookie"] = next;
        return;
      }
      const list = Array.isArray(existing) ? existing : [existing];
      if (list.some((entry) => entry.startsWith(`${name}=`))) return;
      list.push(serialized);
      host.responseHeaders["set-cookie"] = list;
    },
  };
};
