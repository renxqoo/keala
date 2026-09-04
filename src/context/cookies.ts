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

/** Browsers cap cookie lifetimes at 400 days — the serializer enforces it. */
const MAX_COOKIE_AGE_SECONDS = 400 * 24 * 60 * 60;
const MAX_COOKIE_AGE_MS = MAX_COOKIE_AGE_SECONDS * 1000;

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

/**
 * Trim ONLY header whitespace (SP/HTAB/CR/LF). JS `trim()` also strips
 * U+00A0 and other Unicode spaces — that collapsed `\u00a0dummy=evil` onto
 * `dummy` before name validation could reject it (silent cookie override).
 */
const trimHeaderWs = (value: string): string => value.replace(/^[\t\r\n ]+|[\t\r\n ]+$/g, "");

/** Parse a `Cookie` request header into a null-prototype map. */
export const parseCookies = (header: string | null): Record<string, string> => {
  const out: Record<string, string> = Object.create(null);
  if (header == null || header.length === 0) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    const name = eq === -1 ? trimHeaderWs(part) : trimHeaderWs(part.slice(0, eq));
    if (name.length === 0 || !isValidCookieName(name)) continue;
    const raw = eq === -1 ? "" : trimHeaderWs(part.slice(eq + 1));
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
  // Symmetric codec: values are percent-encoded on the wire and decoded by
  // parseCookies — a value carrying a literal "%2F" must survive the
  // browser's byte-for-byte echo verbatim (and a SIGNED cookie's HMAC must
  // be verifiable over the same string it was computed on). Validation runs
  // against the RAW value; the encoded form is always cookie-octet-safe.
  let header = `${name}=${encodeURIComponent(value)}`;
  if (options.maxAge !== undefined) {
    if (!Number.isFinite(options.maxAge)) {
      throw new TypeError("cookie maxAge must be a finite number");
    }
    // Browsers silently cap at 400 days — refuse instead of shipping a
    // cookie that will not survive with the configured lifetime.
    if (Math.abs(options.maxAge) > MAX_COOKIE_AGE_SECONDS) {
      throw new TypeError("cookie maxAge cannot exceed 400 days");
    }
    header += `; Max-Age=${Math.trunc(options.maxAge)}`;
  }
  if (options.expires !== undefined) {
    if (!(options.expires instanceof Date)) {
      throw new TypeError("cookie expires must be a Date");
    }
    // An invalid Date would ship the literal "Expires=Invalid Date" — reject
    // the same shape response.lastModified does.
    if (Number.isNaN(options.expires.getTime())) {
      throw new TypeError("cookie expires must be a valid Date");
    }
    if (options.expires.getTime() - Date.now() > MAX_COOKIE_AGE_MS) {
      throw new TypeError("cookie expires cannot exceed 400 days out");
    }
    header += `; Expires=${options.expires.toUTCString()}`;
  }
  if (options.domain !== undefined) {
    assertHeaderSafe("cookie domain", options.domain);
    header += `; Domain=${options.domain}`;
  }
  // Path defaults to "/" (the `cookies` package / koa behavior, R4.10):
  // RFC 6265's default-path scopes a cookie set at POST /api/auth/login to
  // /api/auth — silently NOT sent to /api/* and every other route. An
  // explicit path (including "") always wins.
  const path = options.path ?? "/";
  if (path.length > 0) {
    assertHeaderSafe("cookie path", path);
    header += `; Path=${path}`;
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
  if (options.partitioned === true) {
    // Partitioned cookies are CHIPS-required to be Secure; browsers drop
    // the pairing silently — refuse at serialization instead.
    if (options.secure !== true) {
      throw new TypeError("partitioned cookies require { secure: true }");
    }
    header += "; Partitioned";
  }
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
  /** Whether the request arrived over TLS (drives the derived `Secure`). */
  readonly requestSecure: boolean;
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
      // Fail CLOSED like the `cookies` package and like get() above: an
      // explicit signed SET without keys must throw, never silently ship an
      // unsigned cookie the app believes to be signed (forgeable sessions).
      if (options.signed === true && !wantsSign) {
        throw new Error(".keys required for signed cookies");
      }
      // Koa's "get secure from request": an unset `secure` follows the
      // request's TLS state instead of defaulting to insecure.
      const effective: CookieOptions =
        options.secure === undefined && host.requestSecure ? { ...options, secure: true } : options;
      const serialized = serializeCookie(
        name,
        wantsSign ? sign(value, keys[0] as string | Uint8Array) : value,
        effective,
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
