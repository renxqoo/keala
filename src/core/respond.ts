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
 * Inherited response contracts (docs/MIGRATION.md §3): empty-status header
 * cleanup, HEAD Content-Length for state-mode bodies and sugar HEAD returns
 * (computed from the would-be body value — committed bodies are never read),
 * non-Latin-1 statusText fallback, and the set-cookie/multi-value
 * precondition for the fast paths.
 */

import type { Application } from "./app.ts";
import type { Context } from "./context/context.ts";
import { byteLengthOf } from "../utils/url.ts";
import { isEmptyStatus, statusMessage } from "../http/status.ts";
import { isStatusText } from "../utils/text.ts";
import type { HeaderMap } from "../types.ts";
import { ALLOW_ORDER, KNOWN_METHODS } from "../router/router.ts";
import { isImplicitTextResponse, TEXT_PLAIN } from "./context/sugar.ts";
import { FLAG_COMMITTED_HEADERS_APPLIED } from "./context/state.ts";
import { createPlannedResponse, inheritResponseFacts } from "./response-plan.ts";
import { isNativeRequestSource } from "./request-source.ts";

const CONTENT_HEADERS = ["content-type", "content-length", "transfer-encoding"] as const;

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
  // koa parity: 405/501 carry the status-message body (HEAD stays bodiless).
  const bodied = (status: number, fallback: string): Response =>
    (c.directBodyResponseValue = new Response(statusMessage(status) || fallback, {
      status,
      headers: { ...headers, "content-type": "text/plain; charset=utf-8" },
    }));
  if (!KNOWN_METHODS.has(method)) {
    if (method === "HEAD") return new Response(null, { status: 501, headers });
    return bodied(501, "Not Implemented");
  }
  if (method === "OPTIONS") {
    // koa-router: OPTIONS answers 200 with an empty body and Allow.
    return new Response(null, { status: 200, headers });
  }
  if (!allowed.has(method)) {
    if (method === "HEAD") return new Response(null, { status: 405, headers });
    return bodied(405, "Method Not Allowed");
  }
  return null;
};

/**
 * Rule 4: post-commit mutations rewrite the committed Response. Removals
 * drop their headers, staged writes REPLACE their headers wholesale (they
 * are the user's latest intent — arrays append as exact multi-values), and
 * post-commit `c.status`/`c.message`/`c.body` writes (flags 32/64/128 — set
 * by the accessors only when a Response is already committed) override the
 * status, reason phrase and body respectively. Pre-commit staging never
 * leaks in: the commit superseded it. The rebuild NEVER reads the committed
 * body — content-type/length metadata comes from what the Response itself
 * exposes, so an OPEN stream producer can never block the finalizer (a
 * body is the adapter's/client's to consume, not the framework's).
 */
const rebuildCommitted = (c: Context, res: Response): Response => {
  const headers = mergedResponseHeaders(res);
  // A post-commit body write (flag 128) REPLACES the committed body — the
  // committed Response's body-describing headers describe the OLD body and
  // must not ride along: a stale content-length desyncs the byte stream on
  // keep-alive/proxied connections (the error path does the same cleanup
  // for the same reason). Staged record headers still apply on top below.
  if ((c.flags & 128) !== 0) {
    headers.delete("content-length");
    headers.delete("transfer-encoding");
    headers.delete("content-encoding");
    headers.delete("content-type");
  }
  const removed = c.removedValue;
  let contentTypeRemoved = false;
  if (removed !== null) {
    for (const name of removed) {
      headers.delete(name);
      if (name === "content-type") contentTypeRemoved = true;
    }
  }
  const record = c.headersRecord;
  if (record !== null) {
    for (const key of Object.keys(record)) {
      const value = record[key] as string | string[];
      if (key === "set-cookie") {
        // Set-Cookie is add-only on the wire: staged cookies JOIN the
        // committed ones (a late c.cookies.set adds a cookie, never replaces
        // the ones the handler already sent). Removal goes through
        // c.remove("Set-Cookie") — the removal list above.
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
  }
  // A c.text() Response rebuilt from `res.body` no longer carries Bun's
  // internal string-body type: the body is now a ReadableStream and Bun.serve
  // emits application/octet-stream. Restore only that known implicit type;
  // an explicit removal or post-commit body replacement must still win.
  if (
    (c.flags & 128) === 0 &&
    !contentTypeRemoved &&
    !headers.has("content-type") &&
    isImplicitTextResponse(c, res)
  ) {
    headers.set("content-type", TEXT_PLAIN);
  }
  const statusOverridden = (c.flags & 32) !== 0;
  const status = statusOverridden ? c.statusValue : res.status;
  // Rule 4 as documented: a post-commit c.status OR c.message overrides the
  // reason phrase — but only writes made AFTER the commit count (64). A
  // message staged before the commit was superseded by the Response itself.
  const statusText =
    (c.flags & 64) !== 0 && isStatusText(c.messageValue) ? c.messageValue : res.statusText;
  // A post-commit body write (128) replaces the committed body — the user's
  // latest intent; anything staged before the commit rides the Response.
  const body = (c.flags & 128) !== 0 ? bodyInitOf(c.bodyValue) : res.body;
  if (isEmptyStatus(status)) {
    // RFC 9110 §8.6: a 204/304 MUST NOT carry content-describing headers —
    // the same cleanup the state-mode path applies.
    headers.delete("content-type");
    headers.delete("content-length");
    headers.delete("transfer-encoding");
    return new Response(null, { status, statusText, headers });
  }
  const rebuilt = new Response(body, { status, statusText, headers });
  if ((c.flags & 128) !== 0 && !isContextBoundBody(c.bodyValue)) {
    c.directBodyResponseValue = rebuilt;
    return rebuilt;
  }
  return (c.flags & 128) === 0 ? inheritResponseFacts(rebuilt, res) : rebuilt;
};

/** Response headers for a rebuild: the committed headers as-is — content-type
 *  inference stays whatever the Response itself carries. */
const mergedResponseHeaders = (res: Response): Headers => {
  const headers = new Headers();
  for (const [key, value] of res.headers.entries()) {
    if (key === "set-cookie") continue; // appended individually below
    headers.set(key, value);
  }
  for (const cookie of res.headers.getSetCookie()) headers.append("set-cookie", cookie);
  return headers;
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
 * The pump runs on `pull` — the source is only read as the consumer demands,
 * so backpressure passes straight through instead of buffering the whole
 * body the moment the wrapper is constructed.
 */
const observedStream = (
  body: ReadableStream,
  onError: (error: Error, c: Context) => void,
  c: Context,
): ReadableStream => {
  const reader = body.getReader();
  return new ReadableStream({
    async pull(controller) {
      // Only the READ may fail with a producer error — controller ops after a
      // consumer cancel/close throw benign TypeErrors that must never reach
      // the app hook (a client abort is not a producer failure).
      let read: IteratorResult<Uint8Array, undefined>;
      try {
        read = await reader.read();
      } catch (err) {
        onError(err instanceof Error ? err : new Error(String(err)), c);
        try {
          controller.error(err);
        } catch {
          // consumer already closed the stream
        }
        return;
      }
      if (read.done) {
        try {
          controller.close();
        } catch {
          // consumer already closed the stream
        }
        return;
      }
      try {
        controller.enqueue(read.value);
      } catch {
        // consumer already closed the stream
      }
    },
    cancel(reason) {
      void reader.cancel(reason).catch(() => undefined);
    },
  });
};

const isContextBoundBody = (body: Context["bodyValue"]): boolean =>
  body instanceof ReadableStream || body instanceof Response;

const buildFromState = (c: Context, head: boolean): Response => {
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
  const statusText = isStatusText(custom) ? custom : "";
  const reason = statusText.length > 0 ? statusText : undefined;
  const hasRecord = record !== null && countOf(record) > 0;
  const isObject = body !== null && typeof body === "object" && !(body instanceof Uint8Array);

  // Bare fast path: default status, no custom headers, no message — the
  // runtime provides content-type/length.
  if (!multiValue && !hasRecord && status === 200 && custom.length === 0) {
    if (isObject && !isStreaming(body)) {
      if (isNativeRequestSource(c.rawRequest)) {
        const json = JSON.stringify(body) ?? "null";
        return createPlannedResponse(json, {}, "application/json");
      }
      return Response.json(body);
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
    return new Response(bodyInitOf(body), { status, statusText: reason, headers: flat });
  }
  if (!hasRecord) {
    // Status/message only — the cheap init shape.
    if (isObject && !isStreaming(body)) {
      if (isNativeRequestSource(c.rawRequest)) {
        const json = JSON.stringify(body) ?? "null";
        return createPlannedResponse(json, { status, statusText: reason }, "application/json");
      }
      return jsonInit(body as object, { status, statusText: reason });
    }
    if (
      isNativeRequestSource(c.rawRequest) &&
      (typeof body === "string" || body instanceof Uint8Array)
    ) {
      return createPlannedResponse(
        body,
        { status, statusText: reason },
        typeof body === "string" ? TEXT_PLAIN : undefined,
      );
    }
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
  if (isObject && !isStreaming(body)) {
    if (isNativeRequestSource(c.rawRequest)) {
      const json = JSON.stringify(body) ?? "null";
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
      return createPlannedResponse(json, { status, statusText: reason, headers });
    }
    return jsonInit(body as object, { status, statusText: reason, headers });
  }
  if (
    isNativeRequestSource(c.rawRequest) &&
    (typeof body === "string" || body instanceof Uint8Array)
  ) {
    return createPlannedResponse(
      body,
      { status, statusText: reason, headers },
      typeof body === "string" ? TEXT_PLAIN : undefined,
    );
  }
  return new Response(bodyInitOf(body), { status, statusText: reason, headers });
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
    // RFC 9110 §8.6: a 204/304 MUST NOT carry a body. A handler returning a
    // bodied Response with an empty status is sanitized exactly like the
    // state-mode path (undici refuses the construction; Bun allows it).
    if (isEmptyStatus(committed.status) && committed.body !== null) {
      return sanitizeEmptyStatus(committed);
    }
    const record = c.headersRecord;
    // Rule 4: a committed Response with post-commit mutations (staged
    // headers, removals, a status/message override) is REBUILT; the common
    // untouched commit returns synchronously as-is. HEAD still drops the
    // body on every path.
    const applied = (c.flags & FLAG_COMMITTED_HEADERS_APPLIED) !== 0;
    const semanticOverride = (c.flags & (32 | 64 | 128)) !== 0;
    const dirty =
      semanticOverride ||
      ((c.flags & 16) !== 0 && !applied) ||
      (!applied && record !== null && countOf(record) > 0);
    if (dirty) {
      const merged = rebuildCommitted(c, committed);
      return c.method === "HEAD" && merged.body !== null ? stripBody(merged) : merged;
    }
    if (c.method === "HEAD" && committed.body !== null) return stripBody(committed);
    return committed;
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
      const merged = rebuildCommitted(c, rejected);
      return head ? stripBody(merged) : merged;
    }
    const notFound = app.notFoundHandler(c);
    if (notFound instanceof Response) {
      // …and a notFound handler's Response is not exempt from them either.
      if (!staged) {
        return head && notFound.body !== null ? stripBody(notFound) : notFound;
      }
      const merged = rebuildCommitted(c, notFound);
      return head && merged.body !== null ? stripBody(merged) : merged;
    }
  }
  return fromState(c, head);
};
