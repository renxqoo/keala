/**
 * Fast URL path/search extraction.
 *
 * Bun hands the fetch handler a fully-qualified `Request.url`. Allocating a
 * full `URL` object per request just to read the path is expensive; these
 * helpers slice the path and query string out with plain string scanning
 * (the same trick Hono uses, minus the URL object when it is not needed).
 */

/** Extract the absolute-path portion of a URL (no origin, no query, no fragment). */
export const getPath = (url: string): string => {
  let start = 0;
  if (url.charCodeAt(0) !== 47 /* "/" */) {
    // Absolute URL: skip "scheme://authority".
    const scheme = url.indexOf("://");
    start = scheme === -1 ? 0 : url.indexOf("/", scheme + 3);
    if (start === -1) return "/";
  }
  let end = url.length;
  for (let i = start; i < end; i++) {
    const code = url.charCodeAt(i);
    if (code === 63 /* "?" */ || code === 35 /* "#" */) {
      end = i;
      break;
    }
  }
  const path = url.slice(start, end);
  return path.length === 0 ? "/" : path;
};

/** Extract the query string including the leading "?" ("" when absent). */
export const getSearch = (url: string): string => {
  const hash = url.indexOf("#");
  const limit = hash === -1 ? url.length : hash;
  const query = url.indexOf("?");
  if (query === -1 || query > limit) return "";
  return url.slice(query, limit);
};

/** Lazily build (and cache) a full URL object; only used by rarely-hit getters. */
export const toURL = (absolute: string): URL | null => {
  try {
    return new URL(absolute);
  } catch {
    return null;
  }
};

/** Parse "host[:port]" honoring bracketed IPv6 literals. */
export const parseHostHeader = (host: string): { hostname: string; port: string } => {
  if (host.length === 0) return { hostname: "", port: "" };
  if (host.charCodeAt(0) === 91 /* "[" */) {
    const close = host.indexOf("]");
    if (close === -1) return { hostname: host, port: "" };
    const port = host.slice(close + 2); // skip "]:"
    return { hostname: host.slice(1, close), port };
  }
  const colon = host.lastIndexOf(":");
  if (colon === -1) return { hostname: host, port: "" };
  return { hostname: host.slice(0, colon), port: host.slice(colon + 1) };
};

/**
 * Koa's `encodeurl`, UTF-8 correct: percent-encode characters unsafe in a
 * Location header (non-ASCII, controls, space, `"`, `'`, `<`, `>`, `` ` ``)
 * as their UTF-8 BYTE sequence (code-point iteration — encoding UTF-16
 * code units would emit latin-1 `%E9` and malformed surrogate escapes)
 * while leaving existing percent-escapes untouched.
 */

const urlEncoder = new TextEncoder();

export const encodeUrlValue = (url: string): string => {
  let out = "";
  for (let i = 0; i < url.length;) {
    if (url.charCodeAt(i) === 37 && /[0-9a-fA-F]{2}/.test(url.slice(i + 1, i + 3))) {
      out += url.slice(i, i + 3);
      i += 3;
      continue;
    }
    const point = url.codePointAt(i) as number;
    const ch = String.fromCodePoint(point);
    const unsafe =
      point > 0x7e ||
      point < 0x21 ||
      ch === '"' ||
      ch === "'" ||
      ch === "<" ||
      ch === ">" ||
      ch === "`";
    if (unsafe) {
      for (const byte of urlEncoder.encode(ch)) {
        out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
      }
    } else {
      out += ch;
    }
    i += point > 0xffff ? 2 : 1;
  }
  return out;
};

/** UTF-8 byte length with an ASCII fast path. */
export const byteLengthOf = (value: string): number => {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 0x7f) return Buffer.byteLength(value);
  }
  return value.length;
};
