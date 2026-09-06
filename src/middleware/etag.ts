/**
 * etag — weak ETags for state-mode bodies with If-None-Match → 304.
 *
 * The hash uses Bun's native wyhash when available (fast, non-cryptographic
 * — ETags are not secrets) and a small FNV-1a fallback elsewhere. Only
 * string/Uint8Array/object state bodies are tagged; committed Responses and
 * streams pass through untouched.
 */

import type { RouteHandler } from "../router/router.ts";
import type { Context } from "../core/context/context.ts";
import { nodeZlib } from "../utils/node-lazy.ts";
import { acceptsGzip } from "../negotiation/accepts.ts";
import { etagMatches } from "../http/conditional.ts";

const wyhash = (
  globalThis as unknown as {
    Bun?: { hash?: { wyhash?: (input: string | Uint8Array) => bigint } };
  }
).Bun?.hash?.wyhash;

/** wyhash over the STRING itself — no TextEncoder pass, no byte copy. */
const wyhashTextOf = (text: string): string | null =>
  typeof wyhash === "function" ? wyhash(text).toString(16) : null;

/** FNV-1a over char codes, two per round — the no-native-module lane. */
const fnv1aText = (text: string): string => {
  const n = text.length;
  let a = 0x811c9dc5;
  let b = 0x01000193;
  let i = 0;
  const limit = n - (n % 2);
  for (; i < limit; i += 2) {
    a = Math.imul(a ^ text.charCodeAt(i), 0x01000193) >>> 0;
    b = Math.imul(b ^ text.charCodeAt(i + 1), 0x01000193) >>> 0;
  }
  let h = (a ^ b) >>> 0;
  if (i < n) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
};

const crc32Of = (bytes: Uint8Array): string | null => {
  const crc32 =
    (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node ===
    undefined
      ? undefined
      : nodeZlib().crc32;
  return typeof crc32 === "function" ? (crc32(bytes) >>> 0).toString(16) : null;
};

const encoder = new TextEncoder();

const textTagOf = (text: string): string => {
  const native = wyhashTextOf(text);
  if (native !== null) return `W/"${native}"`;
  const crc = crc32Of(encoder.encode(text));
  if (crc !== null) return `W/"${crc}"`;
  return `W/"${text.length.toString(16)}${fnv1aText(text)}"`;
};

/** RFC 9110 §15.4.5: a 304 SHOULD send these if they'd accompany the 200. */
const RETAINED_304_HEADERS = [
  "cache-control",
  "content-location",
  "date",
  "expires",
  "vary",
] as const;

export const etag = (): RouteHandler => {
  return async (c, next) => {
    await next();
    const committed = c._res;
    // Transformation gate (§2.3-5): only snapshot-identity bodies — sugar
    // products the framework built are branded directBodyResponseValue at
    // construction. Hand-built Responses, streams, SSE and native planned
    // responses pass through: their bodies may be live, locked or consumed.
    if (committed === undefined || c.directBodyResponseValue !== committed) return;
    // Validators only negotiate safe methods — a 304 for POST would tell
    // the client a state change "already happened" (hono corpus lock).
    if (c.method !== "GET" && c.method !== "HEAD") return;
    const status = committed.status;
    if (status !== 200 && status !== 201) return;
    // A handler-preset validator participates in negotiation too (the
    // middleware's primary value): if the response already carries an etag,
    // use IT for the If-None-Match check instead of computing our own.
    const presetTag = committed.headers.get("etag");
    const tag = presetTag !== null ? presetTag : await tagOfResponse(c, committed);
    if (tag === null) return;
    const noneMatch = c.header("if-none-match");
    if (noneMatch.length > 0 && etagMatches(tag, noneMatch)) {
      // 304 short-circuit: rebuilt CLEAN — no body, no content-describing
      // headers (§2.3-2) — with the validator and the RFC 9110 §15.4.5
      // retained headers (the ones that would accompany the 200); staged
      // headers (security) merge onto it at finalize. Returning it replaces
      // the committed answer (last-committer-wins).
      const headers = new Headers({ etag: tag });
      for (const name of RETAINED_304_HEADERS) {
        const value = committed.headers.get(name);
        if (value !== null) headers.set(name, value);
      }
      return new Response(null, { status: 304, headers });
    }
    // Post-commit header writes land directly on the committed Response.
    committed.headers.set("etag", tag);
  };
};

/**
 * Hash the snapshot body of a sugar-built Response. The JSON lane reuses the
 * request's serialization memo (R4.10: one stringify per request); the text
 * lane reads a CLONE — the committed body itself must stay unconsumed for
 * the wire. Byte bodies never reach here (the sugar surface is text/json).
 */
const tagOfResponse = async (c: Context, res: Response): Promise<string | null> => {
  const memo = c.bodySerializedValue;
  if (memo !== undefined) return textTagOf(memo);
  const text = await res.clone().text();
  return textTagOf(text);
};

export interface CompressOptions {
  /** Injectable gzip for tests; defaults to the Web-standard
   *  CompressionStream("gzip") — measured on Bun 1.4 at 4–5x the throughput
   *  of node:zlib's async callback path (5.7µs vs 25.3µs per 10KB body,
   *  2–4x under 200-way concurrency) and it drops the node:zlib module
   *  bridge (~1.2MB idle RSS). On Node it is ~50% slower than node:zlib
   *  async (37.6µs vs 24.8µs) — still microseconds; Bun is the target. */
  gzip?: (input: Uint8Array) => Promise<Uint8Array>;
}

/**
 * One-shot gzip over the Web-standard CompressionStream. The stream
 * plumbing is fire-and-forget with catch handlers (a rejecting write/close
 * promise must never become an unhandledRejection); failures surface
 * through the awaited reader instead. Single-chunk output passes through
 * without a copy; multi-chunk output is reassembled once.
 */
const webGzip = async (input: Uint8Array): Promise<Uint8Array> => {
  const stream = new CompressionStream("gzip");
  const writer = stream.writable.getWriter();
  void writer.write(input).catch(() => undefined);
  void writer.close().catch(() => undefined);
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  if (chunks.length === 1) return chunks[0] as Uint8Array;
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
};

/**
 * compress — gzip for state-mode string/JSON bodies.
 *
 * Streams and committed responses pass through. The default gzip is the
 * Web-standard CompressionStream — asynchronous (never the blocking
 * Bun.gzipSync / zlib.gzipSync) and, on Bun, several times faster than the
 * node:zlib callback bridge it replaced.
 */

/**
 * q-aware gzip acceptance lives in negotiation/accepts.ts (acceptsGzip):
 * it carries the lone-token and memoized fast lanes that keep compress()'s
 * per-request gate off the full preference parse on the decline path.
 */

const VARY_ACCEPT_ENCODING = "Accept-Encoding";

/**
 * Stage `Vary: Accept-Encoding` without append's allocation tax: when
 * nothing else has claimed Vary yet (the overwhelmingly common case) a
 * plain SET is observably identical — append with no existing value stages
 * the same single string, just through an extra array. A response that
 * already varies (handler or another middleware) keeps the append join so
 * their tokens survive.
 */
const varyAcceptEncoding = (c: Context): void => {
  if (c.has("vary")) c.append("Vary", VARY_ACCEPT_ENCODING);
  else c.setHeader("Vary", VARY_ACCEPT_ENCODING);
};

/**
 * Inherently-compressed payload types — re-compressing wastes CPU. Matched
 * against the media type with parameters (`application/gzip; q=…`), so the
 * token must end at ";" or end-of-string; the full MIME spellings of the
 * archive formats (R4.10: `application/gzip` never matched the bare `gz`
 * token) join the extension forms.
 */
const COMPRESSED_TYPE =
  /(?:^|\/)(?:png|jpe?g|gif|webp|avif|woff2?|zstd|br|zip|gz|gzip|x-gzip|x-tar|mp4|webm|mp3|ogg|wav|pdf)(?:;|$)/;

export const compress = (options: CompressOptions = {}): RouteHandler => {
  const gzip = options.gzip ?? webGzip;
  return async (c, next) => {
    const encoding = c.header("accept-encoding");
    if (!acceptsGzip(encoding)) {
      await next();
      varyAcceptEncoding(c);
      return;
    }
    await next();
    varyAcceptEncoding(c);
    const committed = c._res;
    // Same transformation gate as etag (§2.3-5): snapshot-identity sugar
    // products only — streams and hand-built Responses pass through.
    if (committed === undefined || c.directBodyResponseValue !== committed) return;
    if (committed.headers.has("content-encoding")) return;
    // no-transform is the origin's explicit instruction to intermediaries.
    const cacheControl = committed.headers.get("cache-control") ?? "";
    if (/(?:^|,)\s*no-transform\s*(?:,|$)/i.test(cacheControl)) return;
    // Partial content has range semantics — re-encoding breaks them.
    if (committed.status === 206) return;
    // Empty-status answers carry no body to encode.
    if (committed.body === null) return;
    const contentType = committed.headers.get("content-type") ?? "";
    if (COMPRESSED_TYPE.test(contentType.toLowerCase())) return;
    // Snapshot bytes: the JSON lane reuses the request's serialization memo
    // (R4.10); the text lane reads a CLONE so the wire body stays unconsumed
    // — and memoizes the ORIGINAL text it read: an outer etag() then hashes
    // the pre-compression representation (what clients compare If-None-Match
    // against), never the packed bytes (adversarial review).
    const memo = c.bodySerializedValue;
    const text = memo !== undefined ? memo : await committed.clone().text();
    if (memo === undefined) c.bodySerializedValue = text;
    const bytes = encoder.encode(text);
    if (bytes.byteLength < 200) return; // tiny bodies grow
    const packed = await gzip(bytes);
    if (packed.byteLength >= bytes.byteLength) return;
    // Replace with a NEW Response (last-committer-wins): the original
    // headers ride along, content-length describes the now-stale body and
    // is dropped, content-encoding lands. Vary was staged above and merges
    // at finalize.
    const headers = new Headers(committed.headers);
    headers.set("content-encoding", "gzip");
    headers.delete("content-length");
    // RFC 9110 §8.8.3: a strong ETag is a promise about byte-identical
    // representations — content-encoding changed it, so the validator
    // weakens (W/"..." → stays; "..." → W/"...").
    const existingTag = headers.get("etag");
    if (existingTag !== null && !existingTag.startsWith("W/")) {
      headers.set("etag", `W/${existingTag}`);
    }
    const replacement = new Response(packed, { status: committed.status, headers });
    // Re-brand the replacement (adversarial review): packed bytes are as
    // context-independent a snapshot as the original, and an OUTER etag()
    // (app.use(etag()); app.use(compress())) must still see a branded body to
    // negotiate — bodySerializedValue still carries the ORIGINAL text, so the
    // validator hashes the pre-compression representation, which is what
    // clients compare If-None-Match against.
    c.directBodyResponseValue = replacement;
    return replacement;
  };
};
