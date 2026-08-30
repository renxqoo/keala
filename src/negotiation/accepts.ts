/**
 * Content negotiation: Accept / Accept-Encoding / Accept-Charset /
 * Accept-Language header parsing with q-values.
 *
 * Functional replacement for the `negotiator` + `accepts` packages used by
 * Koa, covering the same observable behavior: q-ordering, wildcards, language
 * prefix matching and server-preference fallback.
 */

import { expandShorthand } from "../utils/mime.ts";

export interface Preference {
  value: string;
  q: number;
  order: number;
}

/** Split a (possibly multi-line joined) header on commas, trimming segments. */
const splitHeader = (header: string): string[] => {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < header.length; i++) {
    const ch = header[i];
    if (ch === undefined) continue;
    if (ch === '"') quoted = !quoted;
    if (ch === "," && !quoted) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
};

/**
 * Parse a preference header into q-sorted entries (best first).
 * Entries with q=0 are dropped: they are explicitly "not acceptable".
 */
export const parsePreferences = (header: string | null): Preference[] => {
  if (header == null || header.length === 0) return [];
  const out: Preference[] = [];
  for (const part of splitHeader(header)) {
    const segments = part.split(";");
    const value = (segments[0] ?? "").trim().toLowerCase();
    if (value.length === 0) continue;
    let q = 1;
    for (let i = 1; i < segments.length; i++) {
      const param = (segments[i] ?? "").trim();
      if (param.startsWith("q=") || param.startsWith("Q=")) {
        const parsed = Number.parseFloat(param.slice(2));
        if (!Number.isNaN(parsed)) q = Math.min(Math.max(parsed, 0), 1);
      }
    }
    if (q > 0) out.push({ value, q, order: out.length });
  }
  out.sort((a, b) => b.q - a.q || a.order - b.order);
  return out;
};

/** Score a client media range against a concrete server type (0 = no match). */
const mediaScore = (client: string, server: string): number => {
  if (client === "*" || client === "*/*") return 1;
  if (client.endsWith("/*")) {
    return client.slice(0, -2) === server.split("/")[0] ? 2 : 0;
  }
  return client === server ? 3 : 0;
};

/** Score an encoding/charset token (exact or wildcard). */
const tokenScore = (client: string, server: string): number => {
  if (client === "*") return 1;
  return client === server ? 3 : 0;
};

/** Score a language range: exact > prefix > wildcard. */
const languageScore = (client: string, server: string): number => {
  if (client === "*") return 1;
  if (client === server) return 3;
  if (client.length < server.length && server.startsWith(`${client}-`)) return 2;
  if (server.length < client.length && client.startsWith(`${server}-`)) return 2;
  return 0;
};

interface PickOptions {
  header: string | null;
  provided: readonly string[];
  normalize: (value: string) => string;
  score: (client: string, server: string) => number;
}

/**
 * Pick the best provided value for a preference header.
 * Client preferences are pre-sorted (q desc, then header order), so the first
 * preference that matches anything wins; within one preference the most
 * specific provided value is chosen.
 */
export const pickPreference = ({
  header,
  provided,
  normalize,
  score,
}: PickOptions): string | false => {
  // No header at all: the server's own preference wins. A header whose
  // entries are all q=0 leaves `prefs` empty and must yield `false`.
  if (header == null || header.length === 0) return provided[0] ?? false;
  const prefs = parsePreferences(header);
  for (const pref of prefs) {
    let bestIndex = -1;
    let bestScore = 0;
    for (let i = 0; i < provided.length; i++) {
      const target = normalize(provided[i] ?? "");
      if (target.length === 0) continue;
      const s = score(pref.value, target);
      if (s > bestScore) {
        bestScore = s;
        bestIndex = i;
      }
    }
    if (bestIndex !== -1) return provided[bestIndex] ?? false;
  }
  return false;
};

/** Values the client accepts, best-first (used when ctx.accepts() has no args). */
export const acceptableValues = (header: string | null): string[] =>
  parsePreferences(header).map((pref) => pref.value);

/** Media-type negotiation: `ctx.accepts(['html', 'json'])`. */
export const acceptsType = (header: string | null, provided: readonly string[]): string | false =>
  pickPreference({ header, provided, normalize: expand, score: mediaScore });

/**
 * Encoding negotiation: `ctx.acceptsEncodings(['gzip', 'br'])`.
 * Per RFC 7231, `identity` stays acceptable unless explicitly refused.
 */
export const acceptsEncoding = (
  header: string | null,
  provided: readonly string[],
): string | false => {
  const picked = pickPreference({ header, provided, normalize: identity, score: tokenScore });
  if (picked !== false) return picked;
  if (header !== null && header.length > 0 && provided.includes("identity")) {
    return isIdentityRefused(header) ? false : "identity";
  }
  return false;
};

const isIdentityRefused = (header: string): boolean => {
  for (const part of header.split(",")) {
    const segments = part.split(";");
    const value = (segments[0] ?? "").trim().toLowerCase();
    if (value !== "identity" && value !== "*") continue;
    const q = (segments[1] ?? "").trim();
    if (q === "q=0" || q === "q=0.0" || q === "q=0.00") return true;
  }
  return false;
};

/** Charset negotiation: `ctx.acceptsCharsets(['utf-8'])`. */
export const acceptsCharset = (
  header: string | null,
  provided: readonly string[],
): string | false => pickPreference({ header, provided, normalize: identity, score: tokenScore });

/** Language negotiation with prefix matching: `ctx.acceptsLanguages(['en', 'zh'])`. */
export const acceptsLanguage = (
  header: string | null,
  provided: readonly string[],
): string | false =>
  pickPreference({ header, provided, normalize: identity, score: languageScore });

/** Expand `json`-style shorthands (including extensions) to media types. */
const EXPAND_CACHE: Readonly<Record<string, string>> = {
  html: "text/html",
  json: "application/json",
  xml: "application/xml",
  text: "text/plain",
};

const expand = (value: string): string => {
  const lower = value.toLowerCase();
  const cached = EXPAND_CACHE[lower];
  // `typeof` guard: prototype-chain keys (`__proto__`, `constructor`) must
  // fall through to the passthrough below instead of being "expanded" into
  // objects that later crash string-only scoring functions.
  if (typeof cached === "string") return cached;
  return expandShorthand(lower);
};

const identity = (value: string): string => value.toLowerCase();
