/**
 * Finalizer: turns the context's accumulated state into a web `Response`,
 * exactly once, after the handler chain settles.
 *
 * Fast paths, in order of cheapness: committed Response returned as-is; bare
 * `new Response(body)` (hono-consistent content-type behavior); `Response.json`
 * for objects; init with a `Headers` instance (cheaper than a record); flattened
 * [name, value] pairs when multi-value headers exist.
 *
 * 0.7 commit contract: a committed Response is returned verbatim unless the
 * request staged headers BEFORE the commit (`c.setHeader(...)` followed by
 * `return new Response(...)`) — those merge straight onto the committed
 * headers in place, with a rebuild fallback for immutable guards. There is
 * no post-commit body/status rewrite machinery: the accessors throw instead
 * (docs/KEALA-NATIVE-API.md §3).
 *
 * Inherited response contracts (docs/MIGRATION.md §3): empty-status header
 * cleanup, HEAD Content-Length for state-mode bodies and sugar HEAD returns
 * (computed from the would-be body value — committed bodies are never read),
 * and the set-cookie/multi-value precondition for the fast paths.
 */

import type { Application } from "./app.ts";
import type { Context } from "./context/context.ts";
import { byteLengthOf } from "../utils/url.ts";
import { isEmptyStatus, statusMessage } from "../http/status.ts";
import type { HeaderMap } from "../types.ts";
import { ALLOW_ORDER, KNOWN_METHODS } from "../router/router.ts";
import { TEXT_PLAIN } from "./context/sugar.ts";
import { createPlannedResponse } from "./response-plan.ts";
import { isNativeRequestSource } from "./request-source.ts";
import { repumpStream } from "../utils/streams.ts";

/** Body-describing headers a 204/304 must not carry (RFC 9110 §8.6). */
const CONTENT_HEADERS = ["content-type", "content-length", "transfer-encoding"] as const;

/**
 * Shared init.headers for the JSON fast paths (PERF-4, 0.6.2 review): a
 * record init re-allocates and re-validates per response; the fetch
 * Response constructor only READS init.headers (both runtimes copy entries
 * into the new Response's own header list and never retain or mutate the
 * source), so one frozen-shape instance serves every JSON response —
 * measured 189ns record init vs 127ns shared Headers on the review matrix.
 */
const JSON_HEADERS = new Headers({ "content-type": "application/json" });

type HeaderEntries = [string, string][];

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

const untouched = (c: Context): boolean => (c.flags & 1) === 0 && c.bodyValue === null;

/**
 * 405/501/OPTIONS for a matched path whose method has no handler — evaluated
 * only when the middleware layer left the response untouched (koa-router
 * semantics via allowedMethods). 0.7: the answers carry `Allow` and NO body.
 */
const methodNotAllowed = (c: Context): Response | null => {
  const allowed = c.allowedValue;
  if (allowed === null || allowed.size === 0) return null;
  const allowHeader = ALLOW_ORDER.filter((m) => allowed.has(m)).join(", ");
  const method = c.method.toUpperCase();
  const headers: HeaderMap = { allow: allowHeader };
  // Post-next observers (logging, metrics by exact code) read c.status —
  // the synthesized answer must be visible there, not only on the wire.
  if (!KNOWN_METHODS.has(method)) {
    // koa-router answers 501; unknownMethodAs404 opts into 404 instead.
    if (c.appValue.unknownMethodAs404) return null;
    c.statusValue = 501;
    return new Response(null, { status: 501, headers });
  }
  if (method === "OPTIONS") {
    // koa-router: OPTIONS answers 200 with an empty body and Allow.
    c.statusValue = 200;
    return new Response(null, { status: 200, headers });
  }
  if (!allowed.has(method)) {
    c.statusValue = 405;
    return new Response(null, { status: 405, headers });
  }
  return null;
};

/** Copy one header map onto a fresh `Headers`, set-cookie joined additively. */
const headersWith = (res: Response, record: HeaderMap): Headers => {
  const headers = new Headers();
  for (const [key, value] of res.headers.entries()) {
    if (key === "set-cookie") continue; // appended individually below
    headers.set(key, value);
  }
  for (const cookie of res.headers.getSetCookie()) headers.append("set-cookie", cookie);
  for (const key of Object.keys(record)) {
    const value = record[key] as string | string[];
    if (key === "set-cookie") {
      // Set-Cookie is add-only on the wire: staged cookies JOIN the ones the
      // response already carries (a late c.cookies.set adds a cookie, never
      // replaces the ones the handler already sent).
      if (Array.isArray(value)) {
        for (const item of value) headers.append(key, item);
      } else {
        headers.append(key, value);
      }
      continue;
    }
    headers.delete(key);
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }
  return headers;
};

/**
 * Merge the headers staged BEFORE a commit onto the committed Response —
 * in place for the ordinary (locally built, mutable) case. An immutable
 * guard (a fetched/redirected Response someone returned while headers were
 * staged) rebuilds through a local Response instead: the one construction
 * that can carry them. The body is passed by reference, never read.
 */
const applyStagedHeaders = (res: Response, record: HeaderMap): Response => {
  try {
    const headers = res.headers;
    for (const key of Object.keys(record)) {
      const value = record[key] as string | string[];
      if (key === "set-cookie") {
        if (Array.isArray(value)) {
          for (const item of value) headers.append(key, item);
        } else {
          headers.append(key, value);
        }
        continue;
      }
      headers.delete(key);
      if (Array.isArray(value)) {
        for (const item of value) headers.append(key, item);
      } else {
        headers.set(key, value);
      }
    }
    return res;
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: headersWith(res, record),
    });
  }
};

/**
 * Drop the body of a Response while keeping its headers verbatim — the HEAD
 * view of a committed/notFound Response. Content-Length is NOT backfilled
 * from a body read: koa computes it from the would-be body VALUE, which the
 * sugar helpers attach at construction for HEAD; a hand-built Response
 * exposes only what its own headers say, and an open stream has no knowable
 * finite length.
 */
export const stripBody = (res: Response): Response =>
  new Response(null, { status: res.status, statusText: res.statusText, headers: res.headers });

type BodyData = string | Uint8Array | ReadableStream | Blob | null;

const isStreaming = (body: unknown): body is ReadableStream | Blob =>
  body instanceof ReadableStream || body instanceof Blob;

/** Serialize per body kind: objects through native JSON, the rest verbatim. */
const bodyInitOf = (body: Context["bodyValue"]): BodyData => {
  if (body === null || body === undefined) return null; // empty bodies stay empty
  if (typeof body === "string" || body instanceof Uint8Array) return body;
  if (isStreaming(body)) return body as BodyData;
  return JSON.stringify(body) ?? "null";
};

/** JSON text of an object body, memoized on the context (one stringify). */
const jsonTextOf = (c: Context, body: unknown): string =>
  c.bodySerializedValue ?? (c.bodySerializedValue = JSON.stringify(body) ?? "null");

const isContextBoundBody = (body: Context["bodyValue"]): boolean => body instanceof ReadableStream;

/** Build the Response from response state (`head` backfills CL, drops body). */
const buildFromState = (c: Context, head: boolean): Response => {
  const status = c.statusValue;
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
      body = statusMessage(status) || String(status);
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
        length = byteLengthOf(jsonTextOf(c, body));
      }
      if (length !== undefined) {
        record ??= c.headersRecord = {};
        record["content-length"] = String(length);
      }
    }
    body = null;
  }

  // Opt-in error observation for streaming bodies (see AppOptions).
  const streamHook = c.appValue.onStreamError;
  if (body instanceof ReadableStream && streamHook !== undefined) {
    body = repumpStream(body, {
      onReadError: (error) =>
        streamHook(error instanceof Error ? error : new Error(String(error)), c),
    });
  }

  const multiValue =
    (c.flags & 4) !== 0 || (record !== null && Array.isArray(record["set-cookie"]));
  const hasRecord = record !== null && countOf(record) > 0;
  const isObject = body !== null && typeof body === "object" && !(body instanceof Uint8Array);

  // Bare fast path: default status, no custom headers — the runtime provides
  // content-type/length.
  if (!multiValue && !hasRecord && status === 200) {
    if (isObject && !isStreaming(body)) {
      if (isNativeRequestSource(c.rawRequest)) {
        const json = jsonTextOf(c, body);
        return createPlannedResponse(json, {}, "application/json");
      }
      // Memo-text construction: undici's Response.json would re-stringify
      // the object the etag middleware (or the HEAD backfill) already
      // serialized — the memo is the single stringify for the request.
      return new Response(jsonTextOf(c, body), { headers: JSON_HEADERS });
    }
    if (
      isNativeRequestSource(c.rawRequest) &&
      (typeof body === "string" || body instanceof Uint8Array)
    ) {
      return createPlannedResponse(body, {}, typeof body === "string" ? TEXT_PLAIN : undefined);
    }
    return new Response(bodyInitOf(body));
  }

  if (multiValue) {
    const flat = record === null ? [] : flattenHeaders(record);
    return new Response(bodyInitOf(body), { status, headers: flat });
  }
  if (!hasRecord) {
    // Status-only — the cheap init shape.
    if (isObject && !isStreaming(body)) {
      if (isNativeRequestSource(c.rawRequest)) {
        const json = jsonTextOf(c, body);
        return createPlannedResponse(json, { status }, "application/json");
      }
      return new Response(jsonTextOf(c, body), { status, headers: JSON_HEADERS });
    }
    if (
      isNativeRequestSource(c.rawRequest) &&
      (typeof body === "string" || body instanceof Uint8Array)
    ) {
      return createPlannedResponse(
        body,
        { status },
        typeof body === "string" ? TEXT_PLAIN : undefined,
      );
    }
    return new Response(bodyInitOf(body), { status });
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
  if (isObject && !isStreaming(body)) {
    if (isNativeRequestSource(c.rawRequest)) {
      const json = jsonTextOf(c, body);
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
      return createPlannedResponse(json, { status, headers });
    }
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    return new Response(jsonTextOf(c, body), { status, headers });
  }
  if (
    isNativeRequestSource(c.rawRequest) &&
    (typeof body === "string" || body instanceof Uint8Array)
  ) {
    return createPlannedResponse(
      body,
      { status, headers },
      typeof body === "string" ? TEXT_PLAIN : undefined,
    );
  }
  return new Response(bodyInitOf(body), { status, headers });
};

const fromState = (c: Context, head: boolean): Response => {
  const response = buildFromState(c, head);
  if (!isContextBoundBody(c.bodyValue)) c.directBodyResponseValue = response;
  return response;
};

/**
 * Terminal conversion — can never throw past `app.handle` (the app wraps this
 * in a try/catch that falls back to a static 500).
 */
/**
 * RFC 9110 §8.6: 204/304 MUST NOT carry a body. Bun constructs bodied
 * empty-status Responses (undici refuses); drop the body and the headers
 * describing it. Shared by the committed path and the R4.3 takeover path.
 */
export const sanitizeEmptyStatus = (res: Response): Response => {
  const headers = new Headers(res.headers);
  headers.delete("content-type");
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  return new Response(null, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
};

export const finalize = (app: Application, c: Context): Response | Promise<Response> => {
  const committed = c._res;
  if (committed !== undefined) {
    // Headers staged BEFORE the commit merge onto the committed Response;
    // post-commit header writes already landed there directly. The merge
    // runs BEFORE empty-status sanitation (BUG-6, 0.6.2 review): a bodied
    // 204/304 used to early-return through the sanitizer and skip the
    // merge entirely. Merge-first is the semantically correct order — the
    // sanitizer then drops exactly the content-DESCRIBING names (they
    // describe a body the empty status forbids) while staged protocol and
    // security headers reach the wire.
    const record = c.headersRecord;
    const merged =
      record !== null && countOf(record) > 0 ? applyStagedHeaders(committed, record) : committed;
    // RFC 9110 §8.6: a 204/304 MUST NOT carry a body. A handler returning a
    // bodied Response with an empty status is sanitized exactly like the
    // state-mode path (undici refuses the construction; Bun allows it).
    if (isEmptyStatus(merged.status) && merged.body !== null) {
      return sanitizeEmptyStatus(merged);
    }
    // HEAD drops the body on every path.
    if (c.method === "HEAD" && merged.body !== null) return stripBody(merged);
    return merged;
  }
  const head = c.method === "HEAD";
  if (untouched(c)) {
    const record = c.headersRecord;
    const staged = record !== null && countOf(record) > 0;
    const rejected = methodNotAllowed(c);
    if (rejected !== null) {
      // Global-middleware headers must reach synthesized 405/501/OPTIONS
      // answers too (the koa contract: middleware output is never dropped).
      if (!staged) return head ? stripBody(rejected) : rejected;
      const merged = applyStagedHeaders(rejected, record as HeaderMap);
      return head ? stripBody(merged) : merged;
    }
    const notFound = app.notFoundHandler(c);
    if (notFound instanceof Response) {
      // …and a notFound handler's Response is not exempt from them either.
      if (!staged) {
        return head && notFound.body !== null ? stripBody(notFound) : notFound;
      }
      const merged = applyStagedHeaders(notFound, record as HeaderMap);
      return head && merged.body !== null ? stripBody(merged) : merged;
    }
  }
  return fromState(c, head);
};
