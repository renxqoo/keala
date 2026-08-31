/**
 * Response sugar helpers — the hono-compatible `c.text()/c.json()/c.html()`
 * return-style constructors.
 *
 * The helpers CONSUME the staged headers: whatever c.set()/c.cookies wrote
 * before the return is delivered inside the built Response, and the staging
 * record is cleared so the finalizer does not merge it a second time. Only
 * writes staged AFTER the sugar return hit the rule-4 merge path.
 *
 * Null-body statuses (204/205/304) honor the same contract as the state-mode
 * finalizer: no body, no content headers — a 204-with-body Response cannot
 * even be constructed (it would escape as an opaque 500 otherwise).
 */

import type { HeaderValue } from "../../types.ts";
import { isEmptyStatus } from "../../http/status.ts";
import { isLatin1 } from "../../utils/text.ts";
import type { ContextState } from "./state.ts";

export const TEXT_PLAIN = "text/plain; charset=utf-8";
export const TEXT_HTML = "text/html; charset=utf-8";

/** Latin-1-safe statusText candidate from a staged c.message. */
const stagedStatusText = (c: ContextState): string | undefined => {
  const message = c.messageValue;
  return message.length > 0 && isLatin1(message) ? message : undefined;
};

/** Drop content-describing headers for a null-body status (204/205/304). */
const dropContentHeaders = (
  merged: Record<string, HeaderValue> | undefined,
): Record<string, HeaderValue> | undefined => {
  if (merged === undefined) return undefined;
  const clean: Record<string, HeaderValue> = { ...merged };
  delete clean["content-type"];
  delete clean["content-length"];
  delete clean["transfer-encoding"];
  return clean;
};

/**
 * Merge the context's state-mode headers with per-call headers for the sugar
 * helpers. Undefined when neither exists (the bare fast path).
 */
const mergedHeadersOf = (
  c: ContextState,
  headers: Record<string, HeaderValue> | undefined,
): Record<string, HeaderValue> | undefined => {
  const record = c.headersRecord;
  if (record === null && headers === undefined) return undefined;
  if (headers === undefined) return { ...record };
  if (record === null) return { ...headers };
  return { ...record, ...headers };
};

/**
 * A ResponseInit headers value that preserves array entries (multi-value
 * headers like set-cookie) — record inits would join them into one line.
 */
const headersInitOf = (
  merged: Record<string, HeaderValue>,
): Headers | Record<string, HeaderValue> => {
  let hasArray = false;
  for (const key of Object.keys(merged)) {
    if (Array.isArray(merged[key])) {
      hasArray = true;
      break;
    }
  }
  if (!hasArray) return merged;
  const headers = new Headers();
  for (const key of Object.keys(merged)) {
    const value = merged[key] as HeaderValue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }
  return headers;
};

/** Consume the staging record into the sugar Response's own init. */
const consumeStaged = (
  c: ContextState,
  headers: Record<string, HeaderValue> | undefined,
): Record<string, HeaderValue> | undefined => {
  const merged = mergedHeadersOf(c, headers);
  if (merged !== undefined && c.headersRecord !== null) c.headersRecord = null;
  return merged;
};

/** The empty-status Response shared by every sugar helper. */
const emptyStatusResponse = (
  st: number,
  statusText: string | undefined,
  clean: Record<string, HeaderValue> | undefined,
): Response =>
  new Response(null, {
    status: st,
    ...(statusText !== undefined ? { statusText } : {}),
    ...(clean !== undefined ? { headers: headersInitOf(clean) } : {}),
  });

export const sugarText = (
  c: ContextState,
  body: string,
  status?: number,
  headers?: Record<string, HeaderValue>,
): Response => {
  const merged = consumeStaged(c, headers);
  // An explicitly staged c.status wins over the default (hono parity).
  const staged = (c.flags & 1) !== 0 ? c.statusValue : undefined;
  const statusText = stagedStatusText(c);
  if (merged === undefined && status === undefined && staged === undefined) {
    // Bare path only when nothing is staged — a staged c.message must ride
    // along as statusText exactly like the state-mode finalizer.
    if (statusText === undefined) return new Response(body);
    return new Response(body, { statusText });
  }
  const st = status ?? staged ?? 200;
  if (isEmptyStatus(st)) return emptyStatusResponse(st, statusText, dropContentHeaders(merged));
  if (merged === undefined) {
    return new Response(body, { status: st, ...(statusText !== undefined ? { statusText } : {}) });
  }
  if (merged["content-type"] === undefined) merged["content-type"] = TEXT_PLAIN;
  return new Response(body, {
    status: st,
    ...(statusText !== undefined ? { statusText } : {}),
    headers: headersInitOf(merged),
  });
};

export const sugarJson = (
  c: ContextState,
  body: unknown,
  status?: number,
  headers?: Record<string, HeaderValue>,
): Response => {
  // `undefined` is not JSON-serializable (Response.json would throw a raw
  // TypeError → 500). A handler doing c.json(findUser()) on a miss gets
  // the same graceful "null" JSON.stringify produces for absent values.
  const payload = body === undefined ? null : body;
  const merged = consumeStaged(c, headers);
  // Response.json sets `application/json` and serializes natively — 74ns
  // cheaper than stringify + record init (see docs/AUDIT.md).
  const staged = (c.flags & 1) !== 0 ? c.statusValue : undefined;
  const statusText = stagedStatusText(c);
  if (merged === undefined && status === undefined && staged === undefined) {
    if (statusText === undefined) return Response.json(payload);
    return Response.json(payload, { statusText });
  }
  const st = status ?? staged ?? 200;
  if (isEmptyStatus(st)) return emptyStatusResponse(st, statusText, dropContentHeaders(merged));
  return Response.json(
    payload,
    merged === undefined
      ? { status: st, ...(statusText !== undefined ? { statusText } : {}) }
      : {
          status: st,
          ...(statusText !== undefined ? { statusText } : {}),
          headers: headersInitOf(merged),
        },
  );
};

export const sugarHtml = (
  c: ContextState,
  body: string,
  status?: number,
  headers?: Record<string, HeaderValue>,
): Response => {
  const merged = consumeStaged(c, headers);
  const withType =
    merged === undefined ? { "content-type": TEXT_HTML } : { ...merged, "content-type": TEXT_HTML };
  const staged = (c.flags & 1) !== 0 ? c.statusValue : undefined;
  const st = status ?? staged;
  const statusText = stagedStatusText(c);
  const statusInit =
    st === undefined ? {} : { status: st, ...(statusText !== undefined ? { statusText } : {}) };
  // Null-body statuses never carry the html content-type (see sugarText).
  if (st !== undefined && isEmptyStatus(st)) {
    return new Response(null, {
      ...statusInit,
      headers: headersInitOf(dropContentHeaders(withType) ?? {}),
    });
  }
  if (st === undefined && statusText === undefined) {
    return new Response(body, { headers: headersInitOf(withType) });
  }
  return new Response(body, { ...statusInit, headers: headersInitOf(withType) });
};
