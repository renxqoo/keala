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
}

const KIB = 1024;
const DEFAULT_JSON_LIMIT = KIB * KIB;
const DEFAULT_FORM_LIMIT = 10 * KIB * KIB;

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

  if (
    (options.jsonLimit !== undefined && options.jsonLimit < 0) ||
    (options.textLimit !== undefined && options.textLimit < 0) ||
    (options.formLimit !== undefined && options.formLimit < 0)
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
              try {
                return (await new Response(bytes, {
                  headers: {
                    "content-type": this.header("content-type") || "application/octet-stream",
                  },
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
