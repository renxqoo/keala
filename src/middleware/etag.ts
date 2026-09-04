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

/** wyhash over bytes (string inputs hash identically to their UTF-8 form). */
const wyhashOf = (bytes: Uint8Array): string | null =>
  typeof wyhash === "function" ? wyhash(bytes).toString(16) : null;

/** wyhash over the STRING itself — no TextEncoder pass, no byte copy. */
const wyhashTextOf = (text: string): string | null =>
  typeof wyhash === "function" ? wyhash(text).toString(16) : null;

/**
 * Node fallback: `zlib.crc32` over the UTF-8 bytes through the lazy bridge —
 * ~0.12ms per 3MB (the pure-JS per-byte FNV cost ~1ms/MB, and the string-
 * lane variant was no better under V8). Load-bearing laziness: importing
 * the framework pulls no native bridge until an etag actually hashes.
 */
const crc32Of = (bytes: Uint8Array): string | null => {
  const crc32 =
    (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node ===
    undefined
      ? undefined
      : nodeZlib().crc32;
  return typeof crc32 === "function" ? (crc32(bytes) >>> 0).toString(16) : null;
};

const encoder = new TextEncoder();

const tagOf = (c: Context, body: unknown): string | null => {
  // String-shaped bodies (and object bodies through the memoized JSON text)
  // hash natively without a byte copy where the runtime allows it (Bun's
  // wyhash takes strings; Node's crc32 takes the UTF-8 bytes). The
  // finalizer and sugar read the same serialization memo (R4.10: hashing a
  // 3MB JSON body used to double its stringify+encode cost).
  if (typeof body === "string") return textTagOf(body);
  if (body instanceof Uint8Array) return bytesTagOf(body);
  if (body !== null && typeof body === "object" && !(body instanceof ReadableStream)) {
    return textTagOf(
      c.bodySerializedValue ?? (c.bodySerializedValue = JSON.stringify(body) ?? "null"),
    );
  }
  return null;
};

const textTagOf = (text: string): string => {
  const native = wyhashTextOf(text);
  if (native !== null) return `W/"${native}"`;
  const crc = crc32Of(encoder.encode(text));
  if (crc !== null) return `W/"${crc}"`;
  return `W/"${text.length.toString(16)}${fnv1aText(text)}"`;
};

const bytesTagOf = (bytes: Uint8Array): string => {
  const native = wyhashOf(bytes);
  if (native !== null) return `W/"${native}"`;
  const crc = crc32Of(bytes);
  if (crc !== null) return `W/"${crc}"`;
  return `W/"${bytes.byteLength.toString(16)}${fnv1aBytes(bytes)}"`;
};

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

/** FNV-1a over bytes for the Uint8Array body lane, four lanes per round. */
const fnv1aBytes = (bytes: Uint8Array): string => {
  const n = bytes.byteLength;
  let a = 0x811c9dc5;
  let b = 0x01000193;
  let c = 0x811c9dc5;
  let d = 0x01000193;
  let i = 0;
  const limit = n - (n % 4);
  for (; i < limit; i += 4) {
    a = Math.imul(a ^ (bytes[i] as number), 0x01000193) >>> 0;
    b = Math.imul(b ^ (bytes[i + 1] as number), 0x01000193) >>> 0;
    c = Math.imul(c ^ (bytes[i + 2] as number), 0x01000193) >>> 0;
    d = Math.imul(d ^ (bytes[i + 3] as number), 0x01000193) >>> 0;
  }
  let h = (a ^ b ^ c ^ d) >>> 0;
  for (; i < n; i++) {
    h ^= bytes[i] as number;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
};

export const etag = (): RouteHandler => {
  return async (c, next) => {
    await next();
    if (c._res !== undefined) return; // committed responses pass through
    // Validators only negotiate safe methods — a 304 for POST would tell
    // the client a state change "already happened" (hono corpus lock).
    if (c.method !== "GET" && c.method !== "HEAD") return;
    const status = c.statusValue;
    if (status !== 200 && status !== 201) return;
    if (c.has("etag")) return;
    const tag = tagOf(c, c.bodyValue);
    if (tag === null) return;
    const noneMatch = c.header("if-none-match");
    if (noneMatch.length > 0 && etagMatches(tag, noneMatch)) {
      // 304 must not carry body or content headers (koan contract).
      c.status = 304;
      c.body = null;
      c.setHeader("ETag", tag);
      return;
    }
    c.setHeader("ETag", tag);
  };
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
    if (c._res !== undefined) return;
    if (c.has("content-encoding")) return;
    // no-transform is the origin's explicit instruction to intermediaries.
    const cacheControl = c.resHeader("Cache-Control") ?? "";
    if (/(?:^|,)\s*no-transform\s*(?:,|$)/i.test(cacheControl)) return;
    // Partial content has range semantics — re-encoding breaks them.
    if (c.statusValue === 206) return;
    const body = c.bodyValue;
    let bytes: Uint8Array | null = null;
    if (typeof body === "string") bytes = encoder.encode(body);
    else if (body !== null && typeof body === "object" && !(body instanceof Uint8Array)) {
      if (body instanceof ReadableStream || body instanceof Blob || body instanceof Response) {
        return;
      }
      bytes = encoder.encode(JSON.stringify(body) ?? "null");
    } else if (body instanceof Uint8Array) {
      bytes = body;
    }
    if (bytes === null || bytes.byteLength < 200) return; // tiny bodies grow
    const contentType = c.resHeader("Content-Type") ?? "";
    if (COMPRESSED_TYPE.test(contentType.toLowerCase())) return;
    const packed = await gzip(bytes);
    if (packed.byteLength >= bytes.byteLength) return;
    c.bodyValue = packed;
    c.setHeader("Content-Encoding", "gzip");
    c.remove("Content-Length");
  };
};
