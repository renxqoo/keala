const TYPE_SHORTHANDS: Readonly<Record<string, string>> = {
  html: "text/html",
  htm: "text/html",
  xml: "application/xml",
  json: "application/json",
  text: "text/plain",
  txt: "text/plain",
  csv: "text/csv",
  css: "text/css",
  js: "text/javascript",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  ico: "image/x-icon",
  pdf: "application/pdf",
  zip: "application/zip",
  wasm: "application/wasm",
  urlencoded: "application/x-www-form-urlencoded",
  multipart: "multipart/*",
  image: "image/*",
  audio: "audio/*",
  video: "video/*",
};

const EXT_TO_MIME: Readonly<Record<string, string>> = {
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  json: "application/json",
  txt: "text/plain",
  csv: "text/csv",
  xml: "application/xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  ico: "image/x-icon",
  pdf: "application/pdf",
  zip: "application/zip",
  gz: "application/gzip",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  wasm: "application/wasm",
};

/**
 * Map a user shorthand like `json` to a real MIME type, pass-through otherwise.
 * The `typeof` guard keeps prototype-chain keys (`__proto__`, `constructor`)
 * from being returned as the "type" — they must fall through, not leak
 * `Object.prototype` / the `Function` constructor into callers.
 */
export const expandShorthand = (type: string): string => {
  const expanded = TYPE_SHORTHANDS[type];
  return typeof expanded === "string" ? expanded : type;
};

/** Lowercase type with parameters stripped: `text/html; charset=utf-8` -> `text/html`. */
export const normalizeType = (type: string): string =>
  type.split(";")[0]?.trim().toLowerCase() ?? "";

export const mimeFromExtension = (filename: string): string | null => {
  const dot = filename.lastIndexOf(".");
  if (dot === -1) return null;
  const ext = filename.slice(dot + 1).toLowerCase();
  const mime = EXT_TO_MIME[ext];
  return typeof mime === "string" ? mime : null;
};

/**
 * Split a content type into its `;`-separated parameters (RFC 9110 grammar:
 * optional whitespace around `=`, quoted values that may contain `;` or even
 * a decoy `charset=`). Only parameters AFTER the type itself are yielded, so
 * a `charset=` inside another parameter's quoted value can never win.
 */
export const contentTypeParameters = function* (
  contentType: string,
): Generator<[name: string, value: string]> {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  let escaped = false;
  for (const ch of contentType) {
    if (escaped) {
      // Quoted-pair (`\"`): the escaped byte is payload — a `;` (or quote)
      // inside the pair must never act as a separator or toggle quotes.
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      current += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === ";" && !inQuotes) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  for (const part of parts.slice(1)) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim().toLowerCase();
    if (name.length === 0) continue;
    let value = part.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    yield [name, value];
  }
};
