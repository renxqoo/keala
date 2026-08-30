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
export const raw = (value: string): { readonly __raw: string } => ({ __raw: value });

const isRaw = (value: unknown): value is { __raw: string } =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { __raw?: unknown }).__raw === "string";

const renderValue = (value: unknown): string => {
  if (isRaw(value)) return value.__raw;
  if (typeof value === "string") return escapeHtml(value);
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(renderValue).join("");
  return escapeHtml(String(value));
};

export const html = (strings: TemplateStringsArray, ...values: unknown[]): string => {
  let out = "";
  for (let i = 0; i < strings.length; i++) {
    out += strings[i];
    if (i < values.length) out += renderValue(values[i]);
  }
  return out;
};
