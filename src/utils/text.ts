/**
 * Text helpers: HTML escaping for redirect fallback bodies and strict header
 * name/value validation that closes response-splitting (CRLF injection).
 */

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export const escapeHtml = (input: string): string =>
  input.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);

export const hasCrlf = (value: string): boolean => {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 13 || code === 10 || code === 0) return true;
  }
  return false;
};

/** Names that must never become header fields (prototype hazards). */
const FORBIDDEN_NAMES = new Set(["__proto__", "constructor", "prototype"]);

/** RFC 7230 `token` characters as one precompiled class (fast path). */
const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Validate a header field name per RFC 7230 `token` rules. */
export const validateHeaderName = (name: string): void => {
  if (name.length === 0 || FORBIDDEN_NAMES.has(name) || !TOKEN_RE.test(name)) {
    throw new TypeError(`Invalid header field name: ${JSON.stringify(name)}`);
  }
};

/** Validate a header value: reject CR/LF/NUL anywhere (response splitting guard). */
export const validateHeaderValue = (name: string, value: string): void => {
  if (hasCrlf(value)) {
    throw new TypeError(
      `Invalid character in header content of "${name}": CR/LF/NUL are not allowed`,
    );
  }
};

/** RFC 6265 cookie-name = token */
export const isValidCookieName = (name: string): boolean =>
  /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name);

/** RFC 6265 cookie-octet visible range, excluding DQUOTE, comma, semicolon, backslash. */
export const isValidCookieValue = (value: string): boolean => {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const isCtl = code <= 0x20 || code >= 0x7f;
    const isExcluded = code === 0x22 || code === 0x2c || code === 0x3b || code === 0x5c;
    if (isCtl || isExcluded) return false;
  }
  return true;
};

/** Build a `Content-Disposition` header with RFC 5987 encoded filename. */
export const contentDisposition = (
  filename: string,
  fallback?: string | false,
  type = "attachment",
): string => {
  const isAscii = /^[\x20-\x7e]*$/.test(filename);
  let asciiName = "";
  if (fallback === undefined) {
    // Koa/content-disposition default: mask non-ASCII characters with `?`.
    asciiName = isAscii ? filename : filename.replace(/[^\x20-\x7e]/g, "?");
  } else if (fallback !== false) {
    if (fallback.includes("/") || fallback.includes("\\")) {
      throw new TypeError("fallback cannot contain path separators");
    }
    if (!/^[\x20-\x7e]*$/.test(fallback)) {
      throw new TypeError("fallback must be ASCII");
    }
    asciiName = isAscii ? filename : fallback;
  }
  let header = type;
  if (asciiName.length > 0) {
    header += `; filename="${asciiName.replace(/(["\\])/g, "\\$1")}"`;
  }
  if (isAscii && asciiName.length > 0) return header;
  const encoded = encodeURIComponent(filename).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${header}; filename*=UTF-8''${encoded}`;
};
