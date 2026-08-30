/**
 * Finalizer: turns the context's accumulated state into a web `Response`,
 * exactly once, after the handler chain settles.
 *
 * Fast paths, in order of cheapness:
 *  - committed Response (dual-mode return style) returned as-is
 *  - bare `new Response(body)` — no init object at all (hono-consistent
 *    content-type behavior; the runtime adds `text/plain` / handles binary)
 *  - `Response.json(body)` for plain-object bodies (native serialization +
 *    `application/json`)
 *  - init with a `Headers` instance (measurably cheaper than a record init)
 *  - flattened [name, value] pairs when multi-value headers exist
 *
 * Inherited response contracts (docs/v2-MIGRATION.md §3): empty-status header
 * cleanup, HEAD Content-Length backfill (computed from the would-be body,
 * exactly like koa), non-Latin-1 statusText fallback, and the
 * set-cookie/multi-value precondition for the fast paths.
 */

import type { Application } from "./app.ts";
import type { Context } from "./context/context.ts";
import { byteLengthOf } from "../utils/url.ts";
import { isEmptyStatus, statusMessage } from "../http/status.ts";
import type { HeaderMap } from "../types.ts";
import { ALLOW_ORDER, KNOWN_METHODS } from "../router/router.ts";

const CONTENT_HEADERS = ["content-type", "content-length", "transfer-encoding"] as const;

type HeaderEntries = string[][];

const isLatin1 = (value: string): boolean => {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 255) return false;
  }
  return true;
};

const countOf = (record: HeaderMap): number => {
  let n = 0;
  for (const _ in record) n++;
  return n;
};

/**
 * Flatten the header map into [name, value] pairs. Duplicate names (only
 * `set-cookie` in practice) are emitted as separate pairs, which the fetch
 * `Headers` constructor preserves as distinct values.
 */
export const flattenHeaders = (record: HeaderMap): HeaderEntries => {
  const entries: HeaderEntries = [];
  for (const key of Object.keys(record)) {
    const value = record[key] as string | string[];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item.length > 0) entries.push([key, item]);
      }
      continue;
    }
    entries.push([key, value]);
  }
  return entries;
};

/** Response untouched: status never set explicitly and no body written. */
const untouched = (c: Context): boolean => (c.flags & 1) === 0 && c.bodyValue === null;

/**
 * 405/501/OPTIONS for a matched path whose method has no handler — evaluated
 * only when the middleware layer left the response untouched (koa-router
 * semantics via allowedMethods).
 */
const methodNotAllowed = (c: Context): Response | null => {
  const allowed = c.allowedValue;
  if (allowed === null || allowed.size === 0) return null;
  const allowHeader = ALLOW_ORDER.filter((m) => allowed.has(m)).join(", ");
  const method = c.method.toUpperCase();
  const headers: HeaderMap = { allow: allowHeader };
  if (!KNOWN_METHODS.has(method)) {
    return new Response(null, { status: 501, headers });
  }
  if (method === "OPTIONS") {
    // koa-router: OPTIONS answers 200 with an empty body and Allow.
    return new Response(null, { status: 200, headers });
  }
  if (!allowed.has(method)) {
    return new Response(null, { status: 405, headers });
  }
  return null;
};

/**
 * Rule 4: headers written after a committed Response merge into it. The
 * rebuild feeds `res.body` (a stream) to the constructor, which loses the
 * runtime's body-type content-type inference — restore it by sniffing the
 * payload when no content-type survives anywhere.
 */
const mergeIntoCommitted = async (res: Response, record: HeaderMap): Promise<Response> => {
  const headers = await mergedResponseHeaders(res);
  // Deferred writes win on collision — they are the user's latest intent.
  for (const key of Object.keys(record)) {
    const value = record[key] as string | string[];
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
};

/** Response headers for a rebuild; sniffs a text body when content-type is absent. */
const mergedResponseHeaders = async (res: Response): Promise<Headers> => {
  const headers = new Headers();
  for (const [key, value] of res.headers.entries()) {
    if (key === "set-cookie") continue; // appended individually below
    headers.set(key, value);
  }
  for (const cookie of res.headers.getSetCookie()) headers.append("set-cookie", cookie);
  if (headers.get("content-type") === null) {
    const sniffed = await sniffContentType(res);
    if (sniffed !== null) headers.set("content-type", sniffed);
  }
  return headers;
};

/**
 * A bare `new Response(string)` gets `text/plain` from the runtime only while
 * the body is still a string; rebuilding from the stream turns it into
 * `application/octet-stream`. Sniff a bounded PREFIX to decide (rare path —
 * only post-commit header writes land here). A prefix is enough: sniffing
 * exists to catch binary payloads, and buffering whole multi-MB bodies for a
 * header decision is a memory-amplification vector.
 */
const SNIFF_BUDGET = 8192;
/** HEAD Content-Length backfill budget — larger bodies simply omit the header. */
const HEAD_LENGTH_BUDGET = 1 << 20;

const boundedRead = async (
  res: Response,
  budget: number,
): Promise<{ bytes: Uint8Array; truncated: boolean } | null> => {
  try {
    const reader = res.clone().body?.getReader();
    if (reader === undefined) return null;
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
      if (total > budget) {
        truncated = true;
        // NEVER await cancel(): on a cloned (teed) body under undici the
        // cancel promise never settles — awaiting it hangs the request.
        void reader.cancel().catch(() => undefined);
        break;
      }
    }
    const merged = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      merged.set(chunk, at);
      at += chunk.byteLength;
    }
    return { bytes: merged, truncated };
  } catch {
    return null; // unreadable body — let the runtime decide
  }
};

const sniffContentType = async (res: Response): Promise<string | null> => {
  const read = await boundedRead(res, SNIFF_BUDGET);
  if (read === null) return null;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(read.bytes);
  return text.includes("\uFFFD") ? "application/octet-stream" : "text/plain; charset=utf-8";
};

/**
 * Drop the body of a committed/notFound Response for HEAD requests,
 * backfilling Content-Length from the would-be body (koa contract).
 */
const stripBody = (res: Response): Response =>
  new Response(null, { status: res.status, statusText: res.statusText, headers: res.headers });

/** Exact Content-Length of a committed body, bounded — no whole-body reads. */
const committedLength = async (res: Response): Promise<number | null> => {
  if (res.headers.get("content-length") !== null) return null;
  const read = await boundedRead(res, HEAD_LENGTH_BUDGET);
  if (read === null || read.truncated) return null;
  return read.bytes.byteLength;
};

/** HEAD view of a committed Response: no body, Content-Length backfilled. */
const committedHead = async (res: Response): Promise<Response> => {
  const length = await committedLength(res);
  const headers = new Headers(res.headers);
  if (length !== null) headers.set("content-length", String(length));
  if (headers.get("content-type") === null) {
    // Rebuilding from the stream loses the runtime's text inference (see
    // mergeIntoCommitted) — HEAD responses deserve the same content-type the
    // GET body would have carried.
    const sniffed = await sniffContentType(res);
    if (sniffed !== null) headers.set("content-type", sniffed);
  }
  return new Response(null, { status: res.status, statusText: res.statusText, headers });
};

type BodyData = string | Uint8Array | ReadableStream | Blob | null;

const isStreaming = (body: unknown): body is ReadableStream | Blob | Response =>
  body instanceof ReadableStream || body instanceof Blob || body instanceof Response;

/** Serialize per body kind: objects through native JSON, the rest verbatim. */
const bodyInitOf = (body: Context["bodyValue"]): BodyData => {
  if (body === null || body === undefined) return null; // empty bodies stay empty
  if (typeof body === "string" || body instanceof Uint8Array) return body;
  if (isStreaming(body)) return body as BodyData;
  return JSON.stringify(body) ?? "null";
};

/** Response construction that needs the JSON static (objects + init). */
const jsonInit = (body: object, init: ResponseInit): Response =>
  "headers" in init || init.status !== undefined || init.statusText !== undefined
    ? (Response.json(body, init) as Response)
    : Response.json(body);

/**
 * Build the Response from response state. `head` drops the body after
 * backfilling Content-Length — koa computes it from the would-be body.
 */
/**
 * Opt-in stream error observation: re-pump the body through a guard so a
 * producer failure reaches the app hook (the client just sees the stream end).
 */
const observedStream = (
  body: ReadableStream,
  onError: (error: Error, c: Context) => void,
  c: Context,
): ReadableStream =>
  new ReadableStream({
    async start(controller) {
      try {
        const reader = body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
        controller.close();
      } catch (err) {
        onError(err instanceof Error ? err : new Error(String(err)), c);
        try {
          controller.error(err);
        } catch {
          // consumer already closed the stream
        }
      }
    },
    cancel(reason) {
      void body.cancel(reason);
    },
  });

const fromState = (c: Context, head: boolean): Response => {
  const status = c.statusValue;
  const custom = c.messageValue;
  let body: Context["bodyValue"] = c.bodyValue;
  let record = c.headersRecord;

  if (isEmptyStatus(status)) {
    if (record !== null) {
      for (const header of CONTENT_HEADERS) delete record[header];
    }
    body = null;
  }

  if (body === null || body === undefined) {
    if ((c.flags & 2) === 0 && !isEmptyStatus(status)) {
      // koa: a null body falls back to the status message text.
      body = custom.length > 0 ? custom : statusMessage(status) || String(status);
    } else {
      body = null;
      if (record !== null) {
        delete record["content-length"];
        delete record["content-type"];
      }
    }
  }

  if (head) {
    // Backfill Content-Length from the would-be body, then drop it.
    if (record?.["content-length"] === undefined) {
      let length: number | undefined;
      if (typeof body === "string") length = byteLengthOf(body);
      else if (body instanceof Uint8Array) length = body.byteLength;
      else if (body !== null && typeof body === "object" && !isStreaming(body)) {
        length = byteLengthOf(JSON.stringify(body) ?? "null");
      }
      if (length !== undefined) {
        record ??= c.headersRecord = {};
        record["content-length"] = String(length);
      }
    }
    body = null;
  }

  // Opt-in error observation for streaming bodies (see AppOptions).
  if (body instanceof ReadableStream && c.appValue.onStreamError !== undefined) {
    body = observedStream(body, c.appValue.onStreamError, c);
  }

  const multiValue =
    (c.flags & 4) !== 0 || (record !== null && Array.isArray(record["set-cookie"]));
  const statusText = isLatin1(custom) ? custom : "";
  const reason = statusText.length > 0 ? statusText : undefined;
  const hasRecord = record !== null && countOf(record) > 0;
  const isObject = body !== null && typeof body === "object" && !(body instanceof Uint8Array);

  // Bare fast path: default status, no custom headers, no message — the
  // runtime provides content-type/length.
  if (!multiValue && !hasRecord && status === 200 && custom.length === 0) {
    if (isObject && !isStreaming(body)) return Response.json(body);
    return new Response(bodyInitOf(body));
  }

  if (multiValue) {
    const flat = record === null ? [] : flattenHeaders(record);
    return new Response(bodyInitOf(body), { status, statusText: reason, headers: flat });
  }
  if (!hasRecord) {
    // Status/message only — the cheap init shape.
    if (isObject && !isStreaming(body))
      return jsonInit(body as object, { status, statusText: reason });
    return new Response(bodyInitOf(body), { status, statusText: reason });
  }
  // Headers-instance init (faster than a record init by ~60ns).
  const headers = new Headers();
  const entries = record as HeaderMap;
  for (const key of Object.keys(entries)) {
    const value = entries[key] as string | string[];
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }
  if (isObject && !isStreaming(body))
    return jsonInit(body as object, { status, statusText: reason, headers });
  return new Response(bodyInitOf(body), { status, statusText: reason, headers });
};

/**
 * Terminal conversion — can never throw past `app.handle` (the app wraps this
 * in a try/catch that falls back to a static 500).
 */
export const finalize = (app: Application, c: Context): Response | Promise<Response> => {
  const committed = c._res;
  if (committed !== undefined) {
    const record = c.headersRecord;
    // Late c.set() writes merge into the committed Response (rule 4) — and a
    // HEAD request still drops the body with a backfilled Content-Length.
    // Rare paths (post-commit header writes, committed HEAD) go async; the
    // common committed case returns synchronously.
    if (record !== null && countOf(record) > 0) {
      const head = c.method === "HEAD";
      return mergeIntoCommitted(committed, record).then((merged) =>
        head && merged.body !== null ? committedHead(merged) : merged,
      );
    }
    if (c.method === "HEAD" && committed.body !== null) return committedHead(committed);
    return committed;
  }
  const head = c.method === "HEAD";
  if (untouched(c)) {
    const rejected = methodNotAllowed(c);
    if (rejected !== null) return head ? stripBody(rejected) : rejected;
    const notFound = app.notFoundHandler(c);
    if (notFound instanceof Response)
      return head && notFound.body !== null ? committedHead(notFound) : notFound;
  }
  return fromState(c, head);
};
