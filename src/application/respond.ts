/**
 * Finalizer: turn the accumulated response state into a web `Response`.
 *
 * Called exactly once per request, after the middleware chain settles.
 */

import { byteLengthOf, responseStateOf, type ResponseFacade } from "../http/response.ts";
import { isEmptyStatus, statusMessage } from "../http/status.ts";
import type { ResponseBody } from "../types.ts";

const CONTENT_HEADERS = ["content-type", "content-length", "transfer-encoding"] as const;

export type StreamErrorHandler = (error: unknown) => void;

/** Wrap a stream so consumer-side failures reach the app error channel. */
const observeStream = (stream: ReadableStream, onError: StreamErrorHandler): ReadableStream =>
  new ReadableStream({
    async start(controller) {
      try {
        const reader = stream.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
        controller.close();
      } catch (err) {
        onError(err);
        try {
          controller.error(err);
        } catch {
          // controller already closed by the consumer
        }
      }
    },
    cancel(reason) {
      void stream.cancel(reason);
    },
  });

export const respond = (
  response: ResponseFacade,
  method: string,
  onStreamError?: StreamErrorHandler,
): Response => {
  const state = responseStateOf(response);
  const status = state._status;
  let body: ResponseBody = state._body;

  if (isEmptyStatus(status)) {
    for (const header of CONTENT_HEADERS) delete state._headers[header];
    body = null;
  }

  if (body === null || body === undefined) {
    if ((state._flags & 2) === 0 && !isEmptyStatus(status)) {
      const fallback = response.message || String(status);
      if (state._headers["content-type"] === undefined) {
        state._headers["content-type"] = "text/plain; charset=utf-8";
      }
      body = fallback;
    } else {
      body = null;
      delete state._headers["content-length"];
      delete state._headers["content-type"];
    }
  }

  if (method === "HEAD") {
    // The body is dropped, so the runtime cannot infer Content-Length — but
    // an explicitly set value wins (koa respond only fills the gap).
    if (state._headers["content-length"] === undefined) {
      if (typeof body === "string") state._headers["content-length"] = String(byteLengthOf(body));
      else if (body instanceof Uint8Array) {
        state._headers["content-length"] = String(body.byteLength);
      }
    }
    body = null;
  }

  let bodyInit = body as string | Uint8Array | ReadableStream | null;
  if (onStreamError !== undefined && bodyInit instanceof ReadableStream) {
    bodyInit = observeStream(bodyInit, onStreamError);
  }
  const headers = state._headers;
  // statusText must be a ByteString (Latin-1); custom non-ASCII messages
  // fall back to the standard reason phrase instead of throwing.
  const statusText = isLatin1(state._message) ? state._message : "";
  // fetch defaults statusText to "" — surface the standard phrase (koa look).
  const reason = statusText.length > 0 ? statusText : statusMessage(status);
  if ((state._flags & 4) === 0 && !Array.isArray(headers["set-cookie"])) {
    // Fast path: hand the flat map straight to Response — no pair array.
    if (status === 200 && state._message.length === 0) {
      return new Response(bodyInit, { headers });
    }
    return new Response(bodyInit, { status, statusText: reason, headers });
  }
  const flatHeaders = flattenHeaders(headers);
  return new Response(bodyInit, { status, statusText: reason, headers: flatHeaders });
};

type HeaderEntries = string[][];

const isLatin1 = (value: string): boolean => {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 255) return false;
  }
  return true;
};

/**
 * Flatten the header map into [name, value] pairs. Duplicate names (only
 * `set-cookie` in practice) are emitted as separate pairs, which the fetch
 * `Headers` constructor preserves as distinct values.
 */
export const flattenHeaders = (headers: Record<string, string | string[]>): HeaderEntries => {
  const entries: HeaderEntries = [];
  for (const key of Object.keys(headers)) {
    const value = headers[key] as string | string[];
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
