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
  /**
   * Non-q parameters on the range ("level=1"), normalized `name=value` with
   * a lowercase name — null when absent (the hot path). Media negotiation
   * requires every parameter to be present-and-equal on the server type
   * (negotiator's specify()); provided values are bare types, so any range
   * carrying parameters is inapplicable to them.
   */
  params: readonly string[] | null;
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
 * Parse a preference header into entries (header order preserved).
 * Unlike `parsePreferences`, q=0 entries are KEPT — explicit-refusal
 * detection (`identity;q=0`, `gzip;q=0`) needs them.
 */
export const parsePreferenceEntries = (header: string | null): Preference[] => {
  if (header == null || header.length === 0) return [];
  const out: Preference[] = [];
  for (const part of splitHeader(header)) {
    const segments = part.split(";");
    const value = (segments[0] ?? "").trim().toLowerCase();
    if (value.length === 0) continue;
    let q = 1;
    let params: string[] | null = null;
    for (let i = 1; i < segments.length; i++) {
      const param = (segments[i] ?? "").trim();
      if (param.startsWith("q=") || param.startsWith("Q=")) {
        const parsed = Number.parseFloat(param.slice(2));
        if (!Number.isNaN(parsed)) q = Math.min(Math.max(parsed, 0), 1);
        continue;
      }
      const eq = param.indexOf("=");
      if (eq === -1) continue;
      const name = param.slice(0, eq).trim().toLowerCase();
      if (name.length === 0) continue;
      (params ??= []).push(`${name}=${param.slice(eq + 1).trim()}`);
    }
    out.push({ value, q, order: out.length, params });
  }
  return out;
};

/**
 * Parse a preference header into q-sorted entries (best first).
 * Entries with q=0 are dropped: they are explicitly "not acceptable".
 */
export const parsePreferences = (header: string | null): Preference[] =>
  parsePreferenceEntries(header)
    .filter((pref) => pref.q > 0)
    .sort((a, b) => b.q - a.q || a.order - b.order);

/**
 * Score a client media range against a concrete server type (0 = no match).
 * A range carrying parameters never matches a bare server type.
 */
const mediaScore = (pref: Preference, server: string): number => {
  if (pref.params !== null) return 0;
  const client = pref.value;
  if (client === "*" || client === "*/*") return 1;
  if (client.endsWith("/*")) {
    return client.slice(0, -2) === server.split("/")[0] ? 2 : 0;
  }
  if (client.startsWith("*/")) {
    // `*/subtype` — wildcard type, concrete subtype (negotiator semantics).
    return client.slice(2) === server.split("/")[1] ? 2 : 0;
  }
  return client === server ? 3 : 0;
};

/** Score an encoding/charset token (exact or wildcard). */
const tokenScore = (pref: Preference, server: string): number => {
  const client = pref.value;
  if (client === "*") return 1;
  return client === server ? 3 : 0;
};

/** Score a language range: exact > prefix > wildcard. */
const languageScore = (pref: Preference, server: string): number => {
  const client = pref.value;
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
  score: (pref: Preference, target: string) => number;
}

/**
 * Pick the best provided value for a preference header (negotiator
 * semantics): each provided value's quality is defined by its MOST SPECIFIC
 * matching range (RFC 7231 §5.3.2 — an exact range outranks a wildcard
 * however their q compare), and among EQUALLY specific matches the one with
 * the HIGHEST q defines it (negotiator's specify: duplicate ranges collapse
 * to their best q, regardless of order). A winning range with q=0 is an
 * EXPLICIT refusal — the value is unavailable even though a wildcard would
 * accept it. The provided values then compete on that quality, tying out on
 * match specificity, then header order, finally provided order.
 */
export const pickPreference = ({
  header,
  provided,
  normalize,
  score,
}: PickOptions): string | false => {
  // No header at all: the server's own preference wins. A header whose
  // entries are all q=0 leaves no candidate and must yield `false`.
  if (header == null || header.length === 0) return provided[0] ?? false;
  // The specificity scan runs over the UNFILTERED entries — dropping q=0
  // up front would let an exact `name;q=0` refusal be overridden by a
  // wildcard (negotiator keeps them for exactly this reason).
  const prefs = parsePreferenceEntries(header);
  let bestIndex = -1;
  let bestQ = 0;
  let bestScore = 0;
  let bestOrder = Number.POSITIVE_INFINITY;
  for (let i = 0; i < provided.length; i++) {
    const target = normalize(provided[i] ?? "");
    if (target.length === 0) continue;
    // The most specific matching range defines this value's quality — NOT
    // the highest-q range that happens to match. Among equally specific
    // matches, the highest q wins (earliest entry on ties).
    let match: Preference | undefined;
    let matchScore = 0;
    for (const pref of prefs) {
      const s = score(pref, target);
      if (s > matchScore || (s === matchScore && s > 0 && pref.q > (match?.q ?? -1))) {
        matchScore = s;
        match = pref;
      }
    }
    if (match === undefined || match.q <= 0) continue;
    if (
      match.q > bestQ ||
      (match.q === bestQ && matchScore > bestScore) ||
      (match.q === bestQ && matchScore === bestScore && match.order < bestOrder)
    ) {
      bestIndex = i;
      bestQ = match.q;
      bestScore = matchScore;
      bestOrder = match.order;
    }
  }
  return bestIndex === -1 ? false : (provided[bestIndex] ?? false);
};

/** Values the client accepts, best-first (used when ctx.accepts() has no args). */
export const acceptableValues = (header: string | null): string[] =>
  parsePreferences(header).map((pref) => pref.value);

/** Media-type negotiation: `ctx.accepts(['html', 'json'])`. */
export const acceptsType = (header: string | null, provided: readonly string[]): string | false =>
  pickPreference({ header, provided, normalize: expand, score: mediaScore });

/**
 * Encoding negotiation: `ctx.acceptsEncodings(['gzip', 'br'])`.
 * Per RFC 7231 §5.3.4, `identity` stays acceptable unless explicitly refused.
 * An absent/empty header means the client understands NO content codings —
 * only identity (negotiator's answer), not "the server's first provided".
 */
export const acceptsEncoding = (
  header: string | null,
  provided: readonly string[],
): string | false => {
  if (header == null || header.length === 0) {
    return provided.includes("identity") ? "identity" : false;
  }
  const picked = pickPreference({ header, provided, normalize: identity, score: tokenScore });
  if (picked !== false) return picked;
  if (provided.includes("identity")) {
    return isIdentityRefused(header) ? false : "identity";
  }
  return false;
};

/**
 * Identity is refused when an `identity` (or wildcard `*`) entry carries
 * q=0 — in ANY spelling (`q=0.000`) and at ANY parameter position. Parsed
 * numerically from the full entry list (which keeps q=0), never from
 * string-matched parameter slots.
 */
const isIdentityRefused = (header: string): boolean => {
  for (const entry of parsePreferenceEntries(header)) {
    if (entry.value !== "identity" && entry.value !== "*") continue;
    if (entry.q === 0) return true;
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
