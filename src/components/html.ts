/**
 * html — the tagged-template escape protocol.
 *
 * Interpolations are HTML-escaped by default; `raw()` marks pre-escaped or
 * trusted fragments. This is the XSS-safe way to build `c.html()` bodies —
 * a bare template string into `c.html()` is on the author.
 */

const ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (ch) => ESCAPE[ch] as string);

/** Mark a fragment as trusted — interpolated verbatim by `html`. */
/** Unforgeable trust marker (Symbols never survive JSON or cloning). */
const RAW = Symbol("bk-raw");

/** Mark a fragment as trusted — interpolated verbatim by `html`. */
export const raw = (value: string): { readonly [RAW]: string } => ({ [RAW]: value });

interface RawValue {
  [RAW]: string;
}

const isRaw = (value: unknown): value is RawValue =>
  typeof value === "object" && value !== null && typeof (value as RawValue)[RAW] === "string";

const renderValue = (value: unknown): string => {
  if (isRaw(value)) return value[RAW];
  if (typeof value === "string") return escapeHtml(value);
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(renderValue).join("");
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return escapeHtml(String(value));
  }
  // Plain objects (JSON bodies and friends) render as escaped JSON — a
  // forged `__raw` key is data here, never a trust marker.
  return escapeHtml(JSON.stringify(value) ?? "null");
};

export const html = (strings: TemplateStringsArray, ...values: unknown[]): string => {
  let out = "";
  for (let i = 0; i < strings.length; i++) {
    out += strings[i];
    if (i < values.length) out += renderValue(values[i]);
  }
  return out;
};
