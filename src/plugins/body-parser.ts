/**
 * bodyParser — the request-body plugin.
 *
 * `app.use(bodyParser())` — a PLUGIN (install protocol) — installs a lazy `c.req` facade with json/text/
 * formData/arrayBuffer/blob readers, reached through the typed `bodyOf(c)`
 * accessor. The raw body is read ONCE (bounded by
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
import { isNativeRequestSource, sourceBody, sourceBytes } from "../core/request-source.ts";

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
    // Same native indexOf scan the multipart branch uses (R4.10): the
    // per-byte JS loop cost ~10.6ms of synchronous CPU on a 10MB body.
    const parts = bytes.length === 0 ? 0 : countOccurrences(bytes, "&") + 1;
    // An EMPTY body holds zero parts — `separators + 1` would invent one and
    // reject the empty form against a zero budget.
    if (parts > limit) tooManyParts(parts);
  }
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

interface BodyReaderConfig {
  readonly jsonLimit: number;
  readonly textLimit: number;
  readonly formLimit: number;
  readonly formPartLimit: number;
}

interface RareReaderState {
  text: Promise<string> | null;
  arrayBuffer: Promise<Uint8Array> | null;
  formData: Promise<FormData> | null;
  blob: Promise<Blob> | null;
}

const bodyTooLarge = (limit: number, declared?: number): Error =>
  createError(
    413,
    declared === undefined
      ? `request body exceeds the ${limit} byte limit`
      : `request body of ${declared} bytes exceeds the ${limit} byte limit`,
    { expose: true, code: "payload_too_large" },
  );

/**
 * One allocation owns both the public facade and every request-body memo.
 * Methods live on the prototype: the common JSON-only request avoids the old
 * cache object, facade object, local read closure and five method closures.
 *
 * `rawBytes` is deliberately private-by-module and never returned without a
 * limit check. Keeping the native read promise one level below reader memos
 * lets JSON perform actual-byte validation + decode + parse in ONE
 * continuation while every reader still shares one body consumption.
 */
class BodyReaderState implements RequestBodyFacade {
  readonly context: Context;
  config: BodyReaderConfig | null;
  // Cold memo fields are shape-lazy: JSON-only requests create raw/json,
  // while text/form/blob/validator state does not occupy or initialize slots.
  declare rawBytes?: Promise<Uint8Array>;
  declare bytes?: Promise<Uint8Array>;
  declare bytesLimit?: number;
  declare jsonValue?: Promise<unknown>;
  declare rare?: RareReaderState;

  constructor(context: Context, config: BodyReaderConfig | null) {
    this.context = context;
    this.config = config;
  }

  /** Start exactly one native/streamed read and remember the first budget. */
  raw(limit: number): Promise<Uint8Array> {
    if (this.rawBytes !== undefined) return this.rawBytes;
    this.bytesLimit = limit;
    const c = this.context;
    const source = c.rawRequest;
    const native = isNativeRequestSource(source);
    let declared: number | undefined;
    if (native) {
      declared = c.reqLength;
    } else {
      const value = (source as Request).headers.get("content-length");
      if (value !== null && value.length > 0) {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isNaN(parsed)) declared = parsed;
      }
    }
    if (declared !== undefined && declared > limit) {
      return (this.rawBytes = Promise.reject(bodyTooLarge(limit, declared)));
    }
    if (native) {
      return (this.rawBytes = sourceBytes(source, limit));
    }
    if (declared !== undefined) {
      // The common path: the native promise stays internal. Every public
      // reader validates its actual byteLength before exposing/decoding it.
      return (this.rawBytes = (source as Request & { bytes(): Promise<Uint8Array> }).bytes());
    }
    const body = sourceBody(source);
    if (body === null) return (this.rawBytes = Promise.resolve(new Uint8Array(0)));
    return (this.rawBytes = this.readStream(body, limit));
  }

  /** Enforce both the first consumer's budget and this reader's budget. */
  checked(bytes: Uint8Array, limit: number): Uint8Array {
    const firstLimit = this.bytesLimit as number;
    const effective = limit < firstLimit ? limit : firstLimit;
    if (bytes.byteLength > effective) throw bodyTooLarge(effective);
    return bytes;
  }

  /** Memoized guarded bytes used by validator()/arrayBuffer(). */
  read(limit: number): Promise<Uint8Array> {
    if (this.bytes !== undefined) {
      if (limit >= (this.bytesLimit as number)) return this.bytes;
      return this.bytes.then((bytes) => this.checked(bytes, limit));
    }
    const raw = this.raw(limit);
    return (this.bytes = raw.then((bytes) => this.checked(bytes, limit)));
  }

  json(): Promise<unknown> {
    if (this.jsonValue !== undefined) return this.jsonValue;
    const limit = (this.config as BodyReaderConfig).jsonLimit;
    return (this.jsonValue = this.raw(limit).then((raw) => {
      // JSON is the dominant reader. Inline its actual-byte guard so the
      // native-read continuation proceeds directly into decode/parse.
      const firstLimit = this.bytesLimit as number;
      const effective = limit < firstLimit ? limit : firstLimit;
      if (raw.byteLength > effective) throw bodyTooLarge(effective);
      const bytes = raw;
      if (bytes.byteLength === 0) return null;
      try {
        return JSON.parse(decoder.decode(bytes)) as unknown;
      } catch {
        throw createError(400, "request body is not valid JSON", {
          expose: true,
          code: "invalid_json",
        });
      }
    }));
  }

  text(): Promise<string> {
    const state = this.rareState();
    if (state.text !== null) return state.text;
    const limit = (this.config as BodyReaderConfig).textLimit;
    return (state.text = this.raw(limit).then((bytes) =>
      decoder.decode(this.checked(bytes, limit)),
    ));
  }

  arrayBuffer(): Promise<Uint8Array> {
    const state = this.rareState();
    if (state.arrayBuffer !== null) return state.arrayBuffer;
    // formLimit, not jsonLimit (R4.10): raw-byte reads are upload-shaped —
    // a user who raised only formLimit used to get a 413 naming "the
    // 1048576 byte limit" for a body formData() accepts.
    return (state.arrayBuffer = this.read((this.config as BodyReaderConfig).formLimit));
  }

  blob(): Promise<Blob> {
    const state = this.rareState();
    if (state.blob !== null) return state.blob;
    // formLimit for the same upload-shape reason as arrayBuffer().
    const limit = (this.config as BodyReaderConfig).formLimit;
    return (state.blob = this.raw(limit).then((bytes) => new Blob([this.checked(bytes, limit)])));
  }

  formData(): Promise<FormData> {
    const state = this.rareState();
    if (state.formData !== null) return state.formData;
    const config = this.config as BodyReaderConfig;
    const limit = config.formLimit;
    const contentType = this.context.header("content-type") || "application/octet-stream";
    return (state.formData = this.raw(limit).then((raw) => {
      const bytes = this.checked(raw, limit);
      assertFormPartBudget(bytes, contentType, config.formPartLimit);
      return new Response(bytes, { headers: { "content-type": contentType } })
        .formData()
        .catch(() => {
          throw createError(400, "request body is not decodable form data", { expose: true });
        }) as unknown as Promise<FormData>;
    }));
  }

  private rareState(): RareReaderState {
    return (this.rare ??= {
      text: null,
      arrayBuffer: null,
      formData: null,
      blob: null,
    });
  }

  private async readStream(body: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw bodyTooLarge(limit);
      }
      chunks.push(value);
    }
    if (chunks.length === 1) return chunks[0] as Uint8Array;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }
}

const stateOf = (c: Context, config: BodyReaderConfig | null = null): BodyReaderState => {
  const holder = c as { bodyCache?: BodyReaderState };
  const state = (holder.bodyCache ??= new BodyReaderState(c, config));
  if (state.config === null && config !== null) state.config = config;
  return state;
};

/**
 * Read the request body once, bounded. Content-Length above the limit fails
 * fast; streamed reads count bytes and abort at the boundary.
 */
export const readBodyLimited = (c: Context, limit: number): Promise<Uint8Array> =>
  stateOf(c).read(limit);

/**
 * Typed accessor for the plugin's `c.req` facade (R411 Fix 1):
 * `await bodyOf(c).json()` instead of `(c as ContextWithBody).req.json()`.
 * The library's one and only cast lives here. When the plugin is not
 * installed the facade is absent — failing loud with the fix beats
 * `undefined.req` blowing up deep in a handler with zero guidance.
 */
export const bodyOf = (c: Context): RequestBodyFacade => {
  const facade = (c as Context & { req?: RequestBodyFacade }).req;
  if (facade === undefined) {
    throw new TypeError(
      "bodyOf(c): body readers require the bodyParser plugin — " +
        "app.use(createBodyParser({ jsonLimit, formLimit, … })) first",
    );
  }
  return facade;
};

const assertLimit = (name: string, value: number | undefined): void => {
  if (value === undefined) return;
  // NaN compares false against every bound and would silently disarm the
  // limit; Infinity is a misconfiguration, not "unlimited" — pass a large
  // finite number when you really mean that.
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`bodyParser ${name} must be a non-negative finite number`);
  }
};

export const createBodyParser = (options: BodyParserOptions = {}): Plugin => {
  const jsonLimit = options.jsonLimit ?? DEFAULT_JSON_LIMIT;
  const textLimit = options.textLimit ?? options.jsonLimit ?? DEFAULT_JSON_LIMIT;
  const formLimit = options.formLimit ?? DEFAULT_FORM_LIMIT;
  const formPartLimit = options.formPartLimit ?? DEFAULT_PART_LIMIT;
  const config: BodyReaderConfig = { jsonLimit, textLimit, formLimit, formPartLimit };

  assertLimit("jsonLimit", options.jsonLimit);
  assertLimit("textLimit", options.textLimit);
  assertLimit("formLimit", options.formLimit);
  assertLimit("formPartLimit", options.formPartLimit);
  return {
    name: "bodyParser",
    install(app: Application): void {
      // The effective json limit, published so co-installed readers (the
      // validator) enforce exactly what the app configured.
      app.decorate("bodyJsonLimit", jsonLimit);
      app.decorateLazy("req", function (this: Context): RequestBodyFacade {
        return stateOf(this, config);
      });
    },
  };
};
