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

/** Validate a header field name per RFC 7230 `token` rules. */
export const validateHeaderName = (name: string): void => {
  if (name.length === 0 || FORBIDDEN_NAMES.has(name) || !TOKEN_RE.test(name)) {
    throw new TypeError(`Invalid header field name: ${JSON.stringify(name)}`);
  }
};

/**
 * Validate a header value: reject CR/LF/NUL anywhere (response splitting
 * guard) and any code unit above 0xFF — fetch `Headers` values are ByteStrings
 * (and node:http enforces latin-1), so a wider value throws at Response
 * construction. Rejecting at the WRITE site surfaces the bug where the
 * developer wrote it, instead of inside the finalizer.
 */
export const validateHeaderValue = (name: string, value: string): void => {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 13 || code === 10 || code === 0) {
      throw new TypeError(
        `Invalid character in header content of "${name}": CR/LF/NUL are not allowed`,
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
