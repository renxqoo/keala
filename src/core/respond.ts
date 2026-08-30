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
import { byteLengthOf } from "./context/response.ts";
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

/** Rule 4: headers written after a committed Response merge into it. */
const mergeIntoCommitted = (res: Response, record: HeaderMap): Response => {
  const headers = new Headers();
  for (const [key, value] of res.headers.entries()) {
    if (key === "set-cookie") continue; // appended individually below
    headers.set(key, value);
  }
  for (const cookie of res.headers.getSetCookie()) headers.append("set-cookie", cookie);
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

/**
 * Drop the body of a committed/notFound Response for HEAD requests,
 * backfilling Content-Length from the would-be body (koa contract).
 */
const stripBody = (res: Response): Response =>
  new Response(null, { status: res.status, statusText: res.statusText, headers: res.headers });

/** Content-Length of a committed body when cheaply computable. */
const committedLength = async (res: Response): Promise<number | null> => {
  if (res.headers.get("content-length") !== null) return null;
  try {
    return byteLengthOf(await res.clone().text());
  } catch {
    return null;
  }
};

/** HEAD view of a committed Response: no body, Content-Length backfilled. */
const committedHead = async (res: Response): Promise<Response> => {
  const length = await committedLength(res);
  const headers = new Headers(res.headers);
  if (length !== null) headers.set("content-length", String(length));
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
      if (length !== undefined)
        (record ?? (c.headersRecord = {}))["content-length"] = String(length);
    }
    body = null;
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
  for (const key of Object.keys(record)) {
    const value = record[key] as string | string[];
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
export const finalize = async (app: Application, c: Context): Promise<Response> => {
  const committed = c._res;
  if (committed !== undefined) {
    const record = c.headersRecord;
    if (record !== null && countOf(record) > 0) return mergeIntoCommitted(committed, record);
    if (c.method === "HEAD" && committed.body !== null) return committedHead(committed);
    return committed;
  }
  const head = c.method === "HEAD";
  if (untouched(c)) {
    const rejected = methodNotAllowed(c);
    if (rejected !== null) return head ? stripBody(rejected) : rejected;
    const notFound = app.notFoundHandler(c);
    if (notFound instanceof Response)
      return head && notFound.body !== null ? stripBody(notFound) : notFound;
  }
  return fromState(c, head);
};
