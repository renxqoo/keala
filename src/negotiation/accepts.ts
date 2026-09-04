/**
 * Content negotiation: Accept / Accept-Encoding / Accept-Charset /
 * Accept-Language header parsing with q-values.
 *
 * Functional replacement for the `negotiator` + `accepts` packages used by
 * Koa, covering the same observable behavior: q-ordering, wildcards, language
 * prefix matching and server-preference fallback.
 */

import { contentTypeParameters, expandShorthand } from "../utils/mime.ts";

export interface Preference {
  value: string;
  q: number;
  order: number;
  /**
   * Media parameters on the range ("level=1"), normalized `name=value` with a
   * lowercase name — null when absent (the hot path). Only parameters seen
   * BEFORE the q weight count: later ones are accept-ext metadata. Media
   * negotiation requires every parameter to be present-and-equal on the
   * server type (negotiator's specify()), and provided values are parsed for
   * parameters the same way.
   */
  params: readonly string[] | null;
}

/** Split a (possibly multi-line joined) header on commas, trimming segments. */
const splitHeader = (header: string): string[] => {
  // Comma-free fast path: quoting only matters for comma detection, so a
  // header without one is a single part whatever it quotes — skip the
  // per-character scan entirely.
  if (header.indexOf(",") === -1) return [header];
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
 * detection (`identity;q=0`, `gzip;q=0`) needs them. Items whose q parameter
 * is not a valid qvalue are dropped entirely (negotiator semantics: NaN
 * quality never compares positive, so a `q=bogus` item must not fall back to
 * the q=1 default and outrank real preferences).
 */
export const parsePreferenceEntries = (header: string | null): Preference[] => {
  if (header == null || header.length === 0) return [];
  const out: Preference[] = [];
  for (const part of splitHeader(header)) {
    const segments = part.split(";");
    const value = (segments[0] ?? "").trim().toLowerCase();
    if (value.length === 0) continue;
    let q = 1;
    let weighted = false;
    let malformed = false;
    let params: string[] | null = null;
    for (let i = 1; i < segments.length; i++) {
      const param = (segments[i] ?? "").trim();
      if (!weighted && (param.startsWith("q=") || param.startsWith("Q="))) {
        weighted = true;
        const parsed = Number.parseFloat(param.slice(2));
        if (Number.isNaN(parsed)) {
          malformed = true;
          break;
        }
        q = Math.min(Math.max(parsed, 0), 1);
        continue;
      }
      if (weighted) continue; // accept-ext after the weight: metadata, not a media constraint
      const eq = param.indexOf("=");
      if (eq === -1) continue;
      const name = param.slice(0, eq).trim().toLowerCase();
      if (name.length === 0) continue;
      (params ??= []).push(`${name}=${param.slice(eq + 1).trim()}`);
    }
    if (!malformed) out.push({ value, q, order: out.length, params });
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
    .toSorted((a, b) => b.q - a.q || a.order - b.order);

/**
 * Split a PROVIDED media type into its type token and parameter map (values
 * compared lowercased — negotiator's specify()). Provided strings may legally
 * carry parameters ("text/html;level=1"), so the server side is parsed just
 * like the client ranges.
 */
const serverMediaOf = (server: string): { type: string; params: Map<string, string> } => {
  const semi = server.indexOf(";");
  const type = (semi === -1 ? server : server.slice(0, semi)).trim().toLowerCase();
  const params = new Map<string, string>();
  if (semi !== -1) {
    for (const [name, value] of contentTypeParameters(server)) {
      params.set(name, value.toLowerCase());
    }
  }
  return { type, params };
};

/**
 * Score a client media range against a concrete server type (0 = no match).
 * Client parameters ("level=1") constrain the representation: every one must
 * be present-and-equal on the server type, and a fully constrained EXACT
 * match outranks the bare exact match (negotiator's +1 params specificity).
 */
const mediaScore = (pref: Preference, server: string): number => {
  const { type, params: serverParams } = serverMediaOf(server);
  const client = pref.value;
  let score: number;
  if (client === "*" || client === "*/*") score = 1;
  else if (client.endsWith("/*")) score = client.slice(0, -2) === type.split("/")[0] ? 2 : 0;
  else if (client.startsWith("*/")) score = client.slice(2) === type.split("/")[1] ? 2 : 0;
  else score = client === type ? 3 : 0;
  if (score === 0) return 0;
  if (pref.params !== null) {
    for (const entry of pref.params) {
      const eq = entry.indexOf("=");
      const name = entry.slice(0, eq);
      const value = entry.slice(eq + 1).toLowerCase();
      if (serverParams.get(name) !== value) return 0;
    }
    if (score === 3) score += 1;
  }
  return score;
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

/**
 * q-aware gzip acceptance (RFC 9110 §12.5.3), the gate compress() runs on
 * EVERY request: an EXPLICIT `gzip;q=0` is a refusal no wildcard can
 * override (the named entry outranks `*`), `*;q>0` accepts anything, and
 * `gzip;q=0` alone refuses. Reference semantics:
 *
 *     explicit = q of the FIRST `gzip` entry, wildcard = q of the FIRST `*`
 *     entry; accept iff (explicit ?? wildcard) exists and is > 0.
 *
 * Two fast lanes answer the common shapes without touching the parser (the
 * parse was ~330ns per request on the decline path):
 *  - a LONE token ("gzip", "identity", "br" — no `,`/`;`/quote, ASCII token
 *    characters only) is decided by a charCode compare, zero allocation.
 *    Anything outside the token alphabet defers (JS `trim()` also strips
 *    U+00A0-class spaces a charCode scan would leave behind);
 *  - a bounded memo over the verbatim header string (the wireFormsCache
 *    pattern): browsers repeat the same Accept-Encoding spelling on every
 *    request, so the parse runs once per distinct header, then never again.
 *    Beyond the cap, hostile header sprawl falls back to parsing per call.
 */
const GZIP_MEMO_MAX = 64;
const gzipMemo = new Map<string, boolean>();

const isTokenChar = (code: number): boolean =>
  (code >= 97 && code <= 122) || // a-z
  (code >= 65 && code <= 90) || // A-Z
  (code >= 48 && code <= 57) || // 0-9
  (code >= 33 && code <= 46) || // !#$%&'*+,-. ("," and '"' were handled above)
  code === 94 || // ^
  code === 95 || // _
  code === 96 || // `
  code === 124 || // |
  code === 126; // ~

const lowerCode = (code: number): number => (code >= 65 && code <= 90 ? code + 32 : code);

/**
 * Verdict for a header that is exactly one token, or null when this lane
 * cannot decide (multi-entry, weighted, quoted, or non-token characters).
 * With no `;` every entry's q is the default 1, so acceptance reduces to:
 * the token IS gzip, or IS the wildcard.
 */
const loneTokenVerdict = (header: string): boolean | null => {
  let start = -1;
  let end = -1; // exclusive
  for (let i = 0; i < header.length; i++) {
    const code = header.charCodeAt(i);
    if (code === 44 || code === 59 || code === 34) return null; // , ; "
    if (code === 32 || code === 9) continue; // OWS around the token
    if (!isTokenChar(code)) return null;
    if (start === -1) start = i;
    end = i + 1;
  }
  if (start === -1) return false; // empty / all-OWS: no entry, no acceptance
  const len = end - start;
  if (len === 1) return header.charCodeAt(start) === 42; // "*"
  if (len !== 4) return false;
  return (
    lowerCode(header.charCodeAt(start)) === 103 /* g */ &&
    lowerCode(header.charCodeAt(start + 1)) === 122 /* z */ &&
    lowerCode(header.charCodeAt(start + 2)) === 105 /* i */ &&
    lowerCode(header.charCodeAt(start + 3)) === 112 /* p */
  );
};

/** The parser-backed reference verdict (also the memo-lane miss path). */
const parseGzipVerdict = (header: string): boolean => {
  let explicit: number | null = null;
  let wildcard: number | null = null;
  for (const pref of parsePreferenceEntries(header)) {
    if (pref.value === "gzip" && explicit === null) explicit = pref.q;
    else if (pref.value === "*" && wildcard === null) wildcard = pref.q;
  }
  const quality = explicit ?? wildcard;
  return quality !== null && quality > 0;
};

export const acceptsGzip = (header: string): boolean => {
  const lone = loneTokenVerdict(header);
  if (lone !== null) return lone;
  const memo = gzipMemo.get(header);
  if (memo !== undefined) return memo;
  const verdict = parseGzipVerdict(header);
  if (gzipMemo.size < GZIP_MEMO_MAX) gzipMemo.set(header, verdict);
  return verdict;
};

/**
 * Charset negotiation over an `Accept-Charset` header. Standalone helper by
 * design: koa's `c.acceptsCharsets()` accessor left the 0.7 context surface
 * (docs/KEALA-NATIVE-API.md §10) — read `c.header("accept-charset")` and
 * call this with the list you serve.
 */
export const acceptsCharset = (
  header: string | null,
  provided: readonly string[],
): string | false => pickPreference({ header, provided, normalize: identity, score: tokenScore });

/**
 * Language negotiation with prefix matching over an `Accept-Language`
 * header. Standalone helper, like acceptsCharset above: koa's
 * `c.acceptsLanguages()` is off the 0.7 context surface.
 */
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
