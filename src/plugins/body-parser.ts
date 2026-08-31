/**
 * bodyParser — the request-body plugin.
 *
 * `app.use(bodyParser())` — a PLUGIN (install protocol) — installs a lazy `c.req` facade with json/text/
 * formData/arrayBuffer/blob readers. The raw body is read ONCE (bounded by
 * the configured limits) and every reader derives from the memoized bytes —
 * middleware, validators and handlers can each call a reader safely.
 *
 * Limits default to json/text 1MB and formData 10MB; exceeding them throws
 * an exposed 413, malformed JSON an exposed 400 — both render as clean HTTP
 * error responses through the standard error path.
 */

import { createError } from "../http/errors.ts";
import { contentTypeParameters } from "../utils/mime.ts";
import type { Plugin } from "../types.ts";
import type { Application } from "../core/app.ts";
import type { Context } from "../core/context/context.ts";

export interface BodyParserOptions {
  /** Max bytes for json()/text(). Default 1MB. */
  jsonLimit?: number;
  /** Alias for jsonLimit applied to text(). */
  textLimit?: number;
  /** Max bytes for formData(). Default 10MB. */
  formLimit?: number;
  /**
   * Max parsed parts (fields + files) for formData(). Default 1000 — a byte
   * budget alone still admits hundreds of thousands of tiny parts, and every
   * part becomes its own entry object (memory amplification far past the
   * body size). Applies to multipart and urlencoded alike.
   */
  formPartLimit?: number;
}

const KIB = 1024;
const DEFAULT_JSON_LIMIT = KIB * KIB;
const DEFAULT_FORM_LIMIT = 10 * KIB * KIB;
const DEFAULT_PART_LIMIT = 1000;
/**
 * Scan budget for a boundary needle: RFC 2046 caps real boundaries at 70
 * chars, but parsers accept longer — the scan honors anything up to this
 * size. Beyond it the needle is not scanned: a boundary this long makes
 * every part cost ≥ its length in bytes, so the BYTE budget already caps the
 * part count at ~formLimit/1024 (≈10k entries on the 10MB default) — no
 * amplification vector remains.
 */
const MAX_BOUNDARY_LENGTH = 1024;

/**
 * Case-insensitive `boundary=` parameter of a content type, quoted or bare.
 * The VALUE is taken verbatim from the original header — RFC 2046 boundaries
 * are case-sensitive, and scanning for a lowercased delimiter would count
 * zero occurrences (the budget silently disarmed). Parsing is quote-aware:
 * a quoted boundary may itself contain ";" (`boundary="a;b"`), and a naive
 * `split(";")` would shred it into a needle that matches nothing — arming
 * the part budget off.
 */
const boundaryOf = (contentType: string): string | null => {
  for (const [name, value] of contentTypeParameters(contentType)) {
    if (name !== "boundary") continue;
    return value.length === 0 || value.length > MAX_BOUNDARY_LENGTH ? null : value;
  }
  return null;
};

/**
 * Non-overlapping occurrences of an ASCII needle in raw bytes. Built on
 * Buffer#indexOf — the runtime's native substring search (memmem-class,
 * linear) — because a hand-rolled byte loop is O(n·m): a crafted boundary
 * ("-"×1021+"C" against an all-dash body) mismatched only at the needle's
 * last byte, paying a full 1024-byte compare per position (~1.6s of
 * synchronous CPU per 1MB, ~16s at the 10MB default limit).
 */
const countOccurrences = (bytes: Uint8Array, needle: string): number => {
  const buffer = Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let count = 0;
  let at = buffer.indexOf(needle);
  while (at !== -1) {
    count++;
    at = buffer.indexOf(needle, at + needle.length);
  }
  return count;
};

const tooManyParts = (bytes: number): never => {
  throw createError(413, `form data exceeds the part budget (${bytes} parts)`, { expose: true });
};

/**
 * Reject form bodies whose PART count (not byte size) busts the budget,
 * before handing the bytes to the runtime's FormData parser. The scan can
 * only over-count (a boundary-looking value inside a part counts too), so it
 * fails closed: real delimiters are always counted, spurious ones only make
 * the rejection slightly eager.
 */
const assertFormPartBudget = (bytes: Uint8Array, contentType: string, limit: number): void => {
  const type = contentType.toLowerCase();
  if (type.startsWith("multipart/")) {
    // Boundary from the ORIGINAL header (case-sensitive value); absent or
    // empty → the runtime parser itself answers 400.
    const boundary = boundaryOf(contentType);
    if (boundary === null) return;
    // `--boundary` appears once per part opening plus once in the closing
    // `--boundary--` delimiter.
    const parts = countOccurrences(bytes, `--${boundary}`) - 1;
    if (parts > limit) tooManyParts(parts);
    return;
  }
  if (type.startsWith("application/x-www-form-urlencoded")) {
    const ampersand = 0x26; /* "&" */
    let separators = 0;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === ampersand) separators++;
    }
    const parts = separators + 1;
    if (parts > limit) tooManyParts(parts);
  }
};

interface BodyCacheState {
  bytes: Promise<Uint8Array> | null;
  facade: RequestBodyFacade | null;
}

const cacheOf = (c: Context): BodyCacheState =>
  ((c as { bodyCache?: BodyCacheState }).bodyCache ??= {
    bytes: null,
    facade: null,
  } as BodyCacheState);

/**
 * Read the request body once, bounded. Content-Length above the limit fails
 * fast; streamed reads count bytes and abort at the boundary.
 */
export const readBodyLimited = async (c: Context, limit: number): Promise<Uint8Array> => {
  const cache = cacheOf(c);
  if (cache.bytes !== null) {
    // The body is already consumed — but THIS reader's limit still applies.
    const bytes = await cache.bytes;
    if (bytes.byteLength > limit) {
      throw createError(413, `request body exceeds the ${limit} byte limit`, { expose: true });
    }
    return bytes;
  }
  const declared = c.reqLength;
  if (declared !== undefined && declared > limit) {
    throw createError(413, `request body of ${declared} bytes exceeds the ${limit} byte limit`, {
      expose: true,
    });
  }
  const read = (async () => {
    const reader = c.raw.body?.getReader();
    if (reader === undefined) return new Uint8Array(0);
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw createError(413, `request body exceeds the ${limit} byte limit`, { expose: true });
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  })();
  cache.bytes = read;
  return read;
};

/** Context extended with the installed `c.req` body facade. */
export type ContextWithBody = Context & { req: RequestBodyFacade };

export interface RequestBodyFacade {
  /** Parsed JSON body; malformed JSON throws an exposed 400. */
  json(): Promise<unknown>;
  /** UTF-8 decoded body. */
  text(): Promise<string>;
  /** Raw bytes. */
  arrayBuffer(): Promise<Uint8Array>;
  /** Body as a Blob. */
  blob(): Promise<Blob>;
  /** Multipart or urlencoded form data. */
  formData(): Promise<FormData>;
}

const decoder = new TextDecoder();

export const createBodyParser = (options: BodyParserOptions = {}): Plugin => {
  const jsonLimit = options.jsonLimit ?? DEFAULT_JSON_LIMIT;
  const textLimit = options.textLimit ?? options.jsonLimit ?? DEFAULT_JSON_LIMIT;
  const formLimit = options.formLimit ?? DEFAULT_FORM_LIMIT;
  const formPartLimit = options.formPartLimit ?? DEFAULT_PART_LIMIT;

  if (
    (options.jsonLimit !== undefined && options.jsonLimit < 0) ||
    (options.textLimit !== undefined && options.textLimit < 0) ||
    (options.formLimit !== undefined && options.formLimit < 0) ||
    (options.formPartLimit !== undefined && options.formPartLimit < 0)
  ) {
    throw new TypeError("bodyParser limits must be non-negative");
  }
  return {
    name: "bodyParser",
    install(app: Application): void {
      // The effective json limit, published so co-installed readers (the
      // validator) enforce exactly what the app configured.
      app.decorate("bodyJsonLimit", jsonLimit);
      app.decorate("req", {
        get(this: Context): RequestBodyFacade {
          const cache = cacheOf(this);
          if (cache.facade !== null) return cache.facade;
          const read = (limit: number): Promise<Uint8Array> => readBodyLimited(this, limit);
          cache.facade = {
            json: async () => {
              const bytes = await read(jsonLimit);
              if (bytes.byteLength === 0) return null;
              try {
                return JSON.parse(decoder.decode(bytes));
              } catch {
                throw createError(400, "request body is not valid JSON", { expose: true });
              }
            },
            text: async () => decoder.decode(await read(textLimit)),
            arrayBuffer: () => read(jsonLimit),
            blob: async () => new Blob([await read(jsonLimit)]),
            formData: async () => {
              const bytes = await read(formLimit);
              const contentType = this.header("content-type") || "application/octet-stream";
              assertFormPartBudget(bytes, contentType, formPartLimit);
              try {
                return (await new Response(bytes, {
                  headers: { "content-type": contentType },
                }).formData()) as FormData;
              } catch {
                throw createError(400, "request body is not decodable form data", {
                  expose: true,
                });
              }
            },
          };
          return cache.facade;
        },
      });
    },
  };
};
