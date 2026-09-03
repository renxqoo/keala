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
import { byteLengthOf } from "../../utils/url.ts";
import { isEmptyStatus } from "../../http/status.ts";
import { isStatusText } from "../../utils/text.ts";
import type { ContextState } from "./state.ts";
import { createPlannedResponse, responseFactsOf } from "../response-plan.ts";
import { isNativeRequestSource, sourceMethod } from "../request-source.ts";

export const TEXT_PLAIN = "text/plain; charset=utf-8";
export const TEXT_HTML = "text/html; charset=utf-8";

/**
 * Mark a sugar-built Response as pooling-retirable: its body is an immutable
 * snapshot (string/bytes/JSON text) that cannot reference the context, so
 * retireWithBody skips the consumption-tracking wrapper for it. Without the
 * mark, pooling would wrap every bodied response in a ReadableStream —
 * destroying Bun's serve-time string MIME inference (pooled text answers
 * carried NO content-type) and both adapters' direct-write fast paths.
 */
const directResponse = (c: ContextState, response: Response): Response => {
  c.directBodyResponseValue = response;
  return response;
};

export const isImplicitTextResponse = (c: ContextState, response: Response): boolean =>
  c.implicitTextResponseValue === response ||
  responseFactsOf(response)?.implicitContentType === TEXT_PLAIN;

const textResponse = (c: ContextState, body: string, init?: ResponseInit): Response => {
  if (isNativeRequestSource(c.rawRequest)) {
    return directResponse(c, createPlannedResponse(body, init, TEXT_PLAIN));
  }
  const response = new Response(body, init);
  c.implicitTextResponseValue = response;
  return directResponse(c, response);
};

/** Latin-1-safe statusText candidate from a staged c.message. */
const stagedStatusText = (c: ContextState): string | undefined => {
  const message = c.messageValue;
  return message.length > 0 && isStatusText(message) ? message : undefined;
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
 * helpers. Undefined when neither exists (the bare fast path). The merge runs
 * in the NORMALIZED (lowercased) keyspace: the staged record is lowercase by
 * construction, and a per-call key in its original case ("Content-Type")
 * would otherwise survive next to its staged lowercase twin — fetch's record
 * init appends both into one comma-joined (invalid) singleton header.
 */
const mergedHeadersOf = (
  c: ContextState,
  headers: Record<string, HeaderValue> | undefined,
): Record<string, HeaderValue> | undefined => {
  const record = c.headersRecord;
  if (record === null && headers === undefined) return undefined;
  if (headers === undefined) return { ...record };
  const merged: Record<string, HeaderValue> = record === null ? {} : { ...record };
  for (const key of Object.keys(headers)) {
    merged[key.toLowerCase()] = headers[key] as HeaderValue;
  }
  return merged;
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
  if (merged !== undefined && c.headersRecord !== null) {
    // Clear IN PLACE, never swap the slot: the memoized cookies facade (and
    // any other holder) keeps referencing THIS record object — a slot swap
    // would detach them and silently drop every later c.cookies.set() into
    // the orphaned record.
    for (const key of Object.keys(c.headersRecord)) delete c.headersRecord[key];
  }
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

/**
 * HEAD view built AT CONSTRUCTION: no body, exact Content-Length from the
 * would-be payload. The finalizer never reads committed bodies (an open
 * producer must not block it), so the koa HEAD-CL contract is honored where
 * the payload is still a known value — right here.
 */
const sugarHead = (
  merged: Record<string, HeaderValue> | undefined,
  contentType: string | undefined,
  bodyLength: number,
  status: number | undefined,
  statusText: string | undefined,
): Response => {
  const record: Record<string, HeaderValue> = merged === undefined ? {} : { ...merged };
  if (contentType !== undefined && record["content-type"] === undefined) {
    record["content-type"] = contentType;
  }
  record["content-length"] = String(bodyLength);
  return new Response(null, {
    status: status ?? 200,
    ...(statusText !== undefined ? { statusText } : {}),
    headers: headersInitOf(record),
  });
};

/** UTF-8 byte length of a sugar payload (string or raw bytes). */
const payloadLength = (body: string | Uint8Array): number =>
  typeof body === "string" ? byteLengthOf(body) : body.byteLength;

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
  const st = status ?? staged;
  if (st !== undefined && isEmptyStatus(st)) {
    return emptyStatusResponse(st, statusText, dropContentHeaders(merged));
  }
  if (sourceMethod(c.rawRequest) === "HEAD") {
    return sugarHead(
      merged,
      TEXT_PLAIN,
      payloadLength(body as string | Uint8Array),
      st,
      statusText,
    );
  }
  if (merged === undefined && status === undefined && staged === undefined) {
    // Bare path only when nothing is staged — a staged c.message must ride
    // along as statusText exactly like the state-mode finalizer.
    if (statusText === undefined) return textResponse(c, body);
    return textResponse(c, body, { statusText });
  }
  if (merged === undefined) {
    return textResponse(c, body, {
      status: st,
      ...(statusText !== undefined ? { statusText } : {}),
    });
  }
  if (merged["content-type"] === undefined) merged["content-type"] = TEXT_PLAIN;
  const init = {
    status: st as number,
    ...(statusText !== undefined ? { statusText } : {}),
    headers: headersInitOf(merged),
  };
  return directResponse(
    c,
    isNativeRequestSource(c.rawRequest)
      ? createPlannedResponse(body, init)
      : new Response(body, init),
  );
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
  const st = status ?? staged;
  if (st !== undefined && isEmptyStatus(st)) {
    return emptyStatusResponse(st, statusText, dropContentHeaders(merged));
  }
  if (sourceMethod(c.rawRequest) === "HEAD") {
    // The HEAD view serializes once, here — Response.json would attach a body.
    return sugarHead(
      merged,
      "application/json",
      byteLengthOf(JSON.stringify(payload) ?? "null"),
      st,
      statusText,
    );
  }
  if (isNativeRequestSource(c.rawRequest)) {
    const bodyText = JSON.stringify(payload) ?? "null";
    if (merged === undefined) {
      return directResponse(
        c,
        createPlannedResponse(
          bodyText,
          {
            ...(st !== undefined ? { status: st } : {}),
            ...(statusText !== undefined ? { statusText } : {}),
          },
          "application/json",
        ),
      );
    }
    const initHeaders = merged;
    if (initHeaders["content-type"] === undefined) {
      initHeaders["content-type"] = "application/json";
    }
    return directResponse(
      c,
      createPlannedResponse(bodyText, {
        ...(st !== undefined ? { status: st } : {}),
        ...(statusText !== undefined ? { statusText } : {}),
        headers: headersInitOf(initHeaders),
      }),
    );
  }
  if (merged === undefined && status === undefined && staged === undefined) {
    if (statusText === undefined) return directResponse(c, Response.json(payload));
    return directResponse(c, Response.json(payload, { statusText }));
  }
  return directResponse(
    c,
    Response.json(
      payload,
      merged === undefined
        ? { status: st, ...(statusText !== undefined ? { statusText } : {}) }
        : {
            status: st,
            ...(statusText !== undefined ? { statusText } : {}),
            headers: headersInitOf(merged),
          },
    ),
  );
};

export const sugarHtml = (
  c: ContextState,
  body: string,
  status?: number,
  headers?: Record<string, HeaderValue>,
): Response => {
  const merged = consumeStaged(c, headers);
  // text/html is the DEFAULT, not an override — the caller's explicit
  // content-type wins (hono's setDefaultContentType order). The merged record
  // is already normalized to lowercase keys.
  const withType =
    merged === undefined
      ? { "content-type": TEXT_HTML }
      : merged["content-type"] === undefined
        ? { ...merged, "content-type": TEXT_HTML }
        : merged;
  const staged = (c.flags & 1) !== 0 ? c.statusValue : undefined;
  const st = status ?? staged;
  const statusText = stagedStatusText(c);
  const statusInit =
    st === undefined && statusText === undefined
      ? {}
      : {
          ...(st !== undefined ? { status: st } : {}),
          ...(statusText !== undefined ? { statusText } : {}),
        };
  // Null-body statuses never carry the html content-type (see sugarText).
  if (st !== undefined && isEmptyStatus(st)) {
    return new Response(null, {
      ...statusInit,
      headers: headersInitOf(dropContentHeaders(withType) ?? {}),
    });
  }
  if (sourceMethod(c.rawRequest) === "HEAD") {
    return sugarHead(
      withType,
      undefined,
      payloadLength(body as string | Uint8Array),
      st,
      statusText,
    );
  }
  if (st === undefined && statusText === undefined) {
    const init = { headers: headersInitOf(withType) };
    return directResponse(
      c,
      isNativeRequestSource(c.rawRequest)
        ? createPlannedResponse(body, init)
        : new Response(body, init),
    );
  }
  const init = { ...statusInit, headers: headersInitOf(withType) };
  return directResponse(
    c,
    isNativeRequestSource(c.rawRequest)
      ? createPlannedResponse(body, init)
      : new Response(body, init),
  );
};
