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

/** Latin-1 check for statusText candidacy (the fetch API rejects the rest). */
export const isLatin1 = (value: string): boolean => {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 255) return false;
  }
  return true;
};

/**
 * Eligibility of a custom message as a fetch `statusText`: latin-1, and no
 * control bytes beyond HTAB (undici rejects every other C0 control and DEL
 * at Response construction — an ineligible message falls back to the
 * standard reason phrase instead of costing the whole response).
 */
export const isStatusText = (value: string): boolean => {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code > 255) return false;
    if (code < 0x20 && code !== 0x09 /* HTAB */) return false;
    if (code === 0x7f /* DEL */) return false;
  }
  return true;
};

/** Names that must never become header fields (prototype hazards). */
const FORBIDDEN_NAMES = new Set(["__proto__", "constructor", "prototype"]);

/** RFC 7230 `token` characters as one precompiled class (fast path). */
const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Memoized RFC 7230 `token` validation: returns the LOWERCASE field name,
 * throwing on invalid input. Header names repeat per route on the hot path
 * (every staged write validates), so a Map hit replaces the toLowerCase +
 * forbidden-set + regex chain entirely. The memo is capped — dynamic name
 * sprawl falls back to the validating path without unbounded growth.
 */
const VALIDATED_NAMES = new Map<string, string>();
const VALIDATED_NAMES_MAX = 512;

export const validateHeaderName = (name: string): string => {
  const memo = VALIDATED_NAMES.get(name);
  if (memo !== undefined) return memo;
  if (name.length === 0 || FORBIDDEN_NAMES.has(name) || !TOKEN_RE.test(name)) {
    throw new TypeError(`Invalid header field name: ${JSON.stringify(name)}`);
  }
  const lower = name.toLowerCase();
  if (VALIDATED_NAMES.size < VALIDATED_NAMES_MAX) VALIDATED_NAMES.set(name, lower);
  return lower;
};

/**
 * Validate a header value per RFC 9110 field-content: allowed are HTAB, SP,
 * visible bytes and obs-text (0x80-0xFF). Everything else is rejected at the
 * WRITE site — CR/LF/NUL guard response splitting, the remaining C0 controls
 * and DEL are protocol-invalid exactly as node:http's ERR_INVALID_CHAR
 * enforces, and code units above 0xFF cannot be ByteStrings. Surfacing the
 * bug where the developer wrote it beats throwing inside the finalizer.
 */
export const validateHeaderValue = (name: string, value: string): void => {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 13 || code === 10 || code === 0) {
      throw new TypeError(
        `Invalid character in header content of "${name}": CR/LF/NUL are not allowed`,
      );
    }
    if ((code < 0x20 && code !== 9) || code === 0x7f) {
      throw new TypeError(
        `Invalid character in header content of "${name}": control bytes are not field-content`,
      );
    }
    if (code > 0xff) {
      throw new TypeError(
        `Invalid character in header content of "${name}": values must be latin-1 (percent-encode the value instead)`,
      );
    }
  }
};

/** RFC 6265 cookie-name = token */
export const isValidCookieName = (name: string): boolean =>
  /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name);

/**
 * RAW cookie-value validation. The serializer percent-encodes the value
 * (encodeURIComponent), so the WIRE form is always cookie-octet-safe no
 * matter the input — validation only needs to reject what could smuggle
 * header syntax through the encoding itself: CR/LF/NUL (header splitting)
 * and the stray high control band. Space, quotes, commas, semicolons,
 * backslashes and non-ASCII all encode cleanly and are accepted (R4.10:
 * the encoder could never legally receive anything it would have to
 * reject, which made spaces and non-ASCII hard errors for nothing).
 */
export const isValidCookieValue = (value: string): boolean => {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (
      code === 13 ||
      code === 10 ||
      code === 0 ||
      (code >= 1 && code <= 8) ||
      (code >= 14 && code <= 31)
    ) {
      return false;
    }
  }
  return true;
};

/**
 * Build a `Content-Disposition` header with RFC 5987 encoded filename,
 * following the `content-disposition` package's algorithm (the koa-linked
 * reference) exactly on:
 *  - latin-1 printable names (\x20-\x7e\x80-\xff) ship whole in the quoted
 *    `filename=` with NO `filename*` (the masked fallback equals the name);
 *  - a name carrying a `%XX` escape forces BOTH parameters (a legacy client
 *    must not URL-decode the quoted form into a different name);
 *  - an explicit string fallback ALWAYS becomes the legacy name and forces
 *    `filename*` to carry the real one.
 * Divergence (locked by test): a fallback containing path separators throws
 * where the package would basename it.
 */
// Latin-1 printable text — the quoted-string-compatible subset.
const CD_TEXT = /^[\x20-\x7e\x80-\xff]+$/;
// Anything outside latin-1 printable gets masked to "?" in the fallback name.
const CD_NON_LATIN1 = /[^\x20-\x7e\xa0-\xff]/g;
// A percent-escape inside the name — forces the extended parameter.
const CD_HEX_ESCAPE = /%[0-9A-Fa-f]{2}/;

export const contentDisposition = (
  filename: string,
  fallback?: string | false,
  type = "attachment",
): string => {
  const isLatin1Text = CD_TEXT.test(filename);
  let fallbackName: string | false;
  if (fallback === undefined) {
    fallbackName = isLatin1Text ? filename : filename.replace(CD_NON_LATIN1, "?");
  } else if (fallback !== false) {
    if (fallback.includes("/") || fallback.includes("\\")) {
      throw new TypeError("fallback cannot contain path separators");
    }
    if (!/^[\x20-\x7e]*$/.test(fallback)) {
      throw new TypeError("fallback must be ASCII");
    }
    fallbackName = fallback;
  } else {
    // fallback:false suppresses the generated legacy NAME only — a filename
    // that is already latin-1 text IS its own `filename=` value (dropping it
    // leaves legacy clients, which ignore filename*, with no name at all).
    fallbackName = isLatin1Text ? filename : false;
  }
  const hasFallback = fallbackName !== false && fallbackName !== filename;
  const needsExtended = hasFallback || !isLatin1Text || CD_HEX_ESCAPE.test(filename);
  let header = type;
  if (fallbackName !== false) {
    header += `; filename="${fallbackName.replace(/(["\\])/g, "\\$1")}"`;
  }
  if (!needsExtended) return header;
  const encoded = encodeURIComponent(filename).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${header}; filename*=UTF-8''${encoded}`;
};
