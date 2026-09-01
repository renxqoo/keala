/**
 * etag — weak ETags for state-mode bodies with If-None-Match → 304.
 *
 * The hash uses Bun's native wyhash when available (fast, non-cryptographic
 * — ETags are not secrets) and a small FNV-1a fallback elsewhere. Only
 * string/Uint8Array/object state bodies are tagged; committed Responses and
 * streams pass through untouched.
 */

import type { RouteHandler } from "../router/router.ts";
import { parsePreferenceEntries } from "../negotiation/accepts.ts";
import { etagMatches } from "../http/conditional.ts";

const wyhashOf = (bytes: Uint8Array): string | null => {
  const hash = (
    globalThis as unknown as { Bun?: { hash?: { wyhash?: (input: Uint8Array) => string } } }
  ).Bun?.hash?.wyhash;
  if (typeof hash !== "function") return null;
  return hash(bytes);
};

const fnv1a = (bytes: Uint8Array): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.byteLength; i++) {
    h ^= bytes[i] as number;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
};

const encoder = new TextEncoder();

const tagOf = (body: unknown): string | null => {
  let bytes: Uint8Array;
  if (typeof body === "string") bytes = encoder.encode(body);
  else if (body instanceof Uint8Array) bytes = body;
  else if (body !== null && typeof body === "object" && !(body instanceof ReadableStream)) {
    bytes = encoder.encode(JSON.stringify(body) ?? "null");
  } else {
    return null;
  }
  return `W/"${wyhashOf(bytes) ?? `${bytes.byteLength.toString(16)}${fnv1a(bytes)}`}"`;
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
    const tag = tagOf(c.bodyValue);
    if (tag === null) return;
    const noneMatch = c.get("if-none-match");
    if (noneMatch.length > 0 && etagMatches(tag, noneMatch)) {
      // 304 must not carry body or content headers (koan contract).
      c.status = 304;
      c.body = null;
      c.set("ETag", tag);
      return;
    }
    c.set("ETag", tag);
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
 * q-aware gzip acceptance (RFC 9110 §12.5.3): an EXPLICIT `gzip;q=0` is a
 * refusal no wildcard can override (the named entry outranks `*`), `*;q>0`
 * accepts anything, and `gzip;q=0` alone refuses.
 */
const acceptsGzip = (header: string): boolean => {
  let explicit: number | null = null;
  let wildcard: number | null = null;
  for (const pref of parsePreferenceEntries(header)) {
    if (pref.value === "gzip" && explicit === null) explicit = pref.q;
    else if (pref.value === "*" && wildcard === null) wildcard = pref.q;
  }
  const quality = explicit ?? wildcard;
  return quality !== null && quality > 0;
};

/** Extensions of inherently-compressed payloads — re-compressing wastes CPU. */
const COMPRESSED_TYPE =
  /(?:^|\/)(?:png|jpe?g|gif|webp|avif|woff2?|zstd|br|zip|gz|mp4|webm|mp3|ogg|wav|pdf)(?:;|$)/;

export const compress = (options: CompressOptions = {}): RouteHandler => {
  const gzip = options.gzip ?? webGzip;
  return async (c, next) => {
    const encoding = c.get("accept-encoding");
    if (!acceptsGzip(encoding)) {
      await next();
      c.append("Vary", "Accept-Encoding");
      return;
    }
    await next();
    c.append("Vary", "Accept-Encoding");
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
    c.set("Content-Encoding", "gzip");
    c.remove("Content-Length");
  };
};
