/**
 * etag — weak ETags for state-mode bodies with If-None-Match → 304.
 *
 * The hash uses Bun's native wyhash when available (fast, non-cryptographic
 * — ETags are not secrets) and a small FNV-1a fallback elsewhere. Only
 * string/Uint8Array/object state bodies are tagged; committed Responses and
 * streams pass through untouched.
 */

import { gzip as gzipCallback } from "node:zlib";

import type { RouteHandler } from "../router/router.ts";

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

const matches = (etag: string, header: string): boolean => {
  for (const candidate of header.split(",")) {
    let value = candidate.trim();
    if (value === "*") return true; // RFC 9110 §13.1.2 — matches any representation
    if (value.startsWith("W/")) value = value.slice(2);
    let expected = etag;
    if (expected.startsWith("W/")) expected = expected.slice(2);
    if (value === expected) return true;
  }
  return false;
};

export const etag = (): RouteHandler => {
  return async (c, next) => {
    await next();
    if (c._res !== undefined) return; // committed responses pass through
    const status = c.statusValue;
    if (status !== 200 && status !== 201) return;
    if (c.has("etag")) return;
    const tag = tagOf(c.bodyValue);
    if (tag === null) return;
    const noneMatch = c.get("if-none-match");
    if (noneMatch.length > 0 && matches(tag, noneMatch)) {
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
  /** Injectable gzip for tests; defaults to async node:zlib gzip (works on
   *  Bun and Node — Bun 1.4 ships only the synchronous Bun.gzipSync). */
  gzip?: (input: Uint8Array) => Promise<Uint8Array>;
}

const zlibGzip = (input: Uint8Array): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    gzipCallback(input, (error, output) => (error === null ? resolve(output) : reject(error)));
  });

/**
 * compress — gzip for state-mode string/JSON bodies.
 *
 * Streams and committed responses pass through (CompressionStream piping is
 * future work). The default gzip runs asynchronously — never the
 * synchronous variants (Bun.gzipSync / zlib.gzipSync), which block the
 * event loop.
 */
export const compress = (options: CompressOptions = {}): RouteHandler => {
  const gzip = options.gzip ?? zlibGzip;
  const accepts = (header: string): boolean => {
    for (const part of header.split(",")) {
      if (part.trim().split(";")[0]?.trim() === "gzip") return true;
    }
    return false;
  };
  return async (c, next) => {
    const encoding = c.get("accept-encoding");
    if (!accepts(encoding)) {
      await next();
      c.append("Vary", "Accept-Encoding");
      return;
    }
    await next();
    c.append("Vary", "Accept-Encoding");
    if (c._res !== undefined) return;
    if (c.has("content-encoding")) return;
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
    const packed = await gzip(bytes);
    if (packed.byteLength >= bytes.byteLength) return;
    c.bodyValue = packed;
    c.set("Content-Encoding", "gzip");
    c.remove("Content-Length");
  };
};
