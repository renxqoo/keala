/**
 * Response sugar helpers — the hono-compatible `c.text()/c.json()/c.html()`
 * return-style constructors.
 *
 * The helpers CONSUME the staged headers: whatever c.setHeader()/c.cookies
 * wrote before the return is delivered inside the built Response, and the
 * staging record is cleared so the finalizer does not merge it a second
 * time. Writes made AFTER the sugar return land directly on the committed
 * Response's headers (the 0.7 contract).
 *
 * Null-body statuses (204/205/304) honor the same contract as the state-mode
 * finalizer: no body, no content headers — a 204-with-body Response cannot
 * even be constructed (it would escape as an opaque 500 otherwise).
 */

import type { HeaderValue } from "../../types.ts";
import { byteLengthOf } from "../../utils/url.ts";
import { isEmptyStatus } from "../../http/status.ts";
import type { ContextState } from "./state.ts";
import { createPlannedResponse } from "../response-plan.ts";
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

const textResponse = (c: ContextState, body: string, init?: ResponseInit): Response => {
  if (isNativeRequestSource(c.rawRequest)) {
    return directResponse(c, createPlannedResponse(body, init, TEXT_PLAIN));
  }
  return directResponse(c, new Response(body, init));
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
const headersInitOf = (merged: Record<string, HeaderValue>): Headers => {
  // Always ONE live Headers instance (record-init Responses cost ~47ns more
  // per construction, and the record form forces another copy inside fetch).
  const headers = new Headers();
  for (const key of Object.keys(merged)) {
    const value = merged[key] as HeaderValue;
    if (Array.isArray(value)) {
      // Empty strings never become wire headers (flattenHeaders parity).
      for (const item of value) if (item.length > 0) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }
  return headers;
};

/**
 * Consume the staging record into the sugar Response's own init. With
 * per-call headers a lowercase-merged COPY is built and the record is
 * cleared up front (the old path). Without them — the common staged-only
 * shape — the LIVE record is returned as scratch: callers may write
 * content-type defaults into it, and `clearStagedInPlace` runs on every
 * exit, keeping the in-place clearing contract the memoized cookies facade
 * depends on. One spread allocation per sugar call disappears.
 */
const consumeStaged = (
  c: ContextState,
  headers: Record<string, HeaderValue> | undefined,
): Record<string, HeaderValue> | undefined => {
  const merged = mergedHeadersOf(c, headers);
  if (merged !== undefined && c.headersRecord !== null) {
    for (const key of Object.keys(c.headersRecord)) delete c.headersRecord[key];
  }
  return merged;
};

/** The staged-only fast path: the live record (undefined when nothing staged). */
const liveStaged = (c: ContextState): Record<string, HeaderValue> | undefined =>
  c.headersRecord ?? undefined;

/**
 * Clear the staged record IN PLACE, never swap the slot: the memoized
 * cookies facade (and any other holder) keeps referencing THIS record
 * object — a slot swap would detach them and silently drop every later
 * c.cookies.set() into the orphaned record.
 */
const clearStagedInPlace = (c: ContextState): void => {
  const record = c.headersRecord;
  if (record !== null) {
    for (const key of Object.keys(record)) delete record[key];
  }
};

/** The empty-status Response shared by every sugar helper. */
const emptyStatusResponse = (
  st: number,
  clean: Record<string, HeaderValue> | undefined,
): Response =>
  new Response(null, {
    status: st,
    ...(clean !== undefined ? { headers: headersInitOf(clean) } : {}),
  });

/**
 * HEAD view built AT CONSTRUCTION: no body, exact Content-Length from the
 * would-be payload. The finalizer never reads committed bodies (an open
 * producer must not block it), so the koa HEAD-CL contract is honored where
 * the payload is still a known value — right here. The view is BRANDED as a
 * snapshot and the would-be payload memoized, so post-next transforms
 * (etag()'s conditional 304 on `HEAD + If-None-Match`) work on HEAD too
 * (adversarial review: hashing must read the memo — the view itself has no
 * body to clone).
 */
const sugarHead = (
  c: ContextState,
  merged: Record<string, HeaderValue> | undefined,
  contentType: string | undefined,
  bodyLength: number,
  status: number | undefined,
  snapshot: string | undefined,
): Response => {
  const record: Record<string, HeaderValue> = merged === undefined ? {} : { ...merged };
  if (contentType !== undefined && record["content-type"] === undefined) {
    record["content-type"] = contentType;
  }
  record["content-length"] = String(bodyLength);
  if (snapshot !== undefined && c.bodySerializedValue === undefined) {
    c.bodySerializedValue = snapshot;
  }
  return directResponse(
    c,
    new Response(null, {
      status: status ?? 200,
      headers: headersInitOf(record),
    }),
  );
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
  const live = headers === undefined;
  const merged = live ? liveStaged(c) : consumeStaged(c, headers);
  // U3c: the status write path is gone — the explicit parameter is the
  // only status source.
  const st = status;
  let response: Response;
  if (st !== undefined && isEmptyStatus(st)) {
    response = emptyStatusResponse(st, dropContentHeaders(merged));
  } else if (sourceMethod(c.rawRequest) === "HEAD") {
    response = sugarHead(
      c,
      merged,
      TEXT_PLAIN,
      payloadLength(body as string | Uint8Array),
      st,
      typeof body === "string" ? body : undefined,
    );
  } else if (merged === undefined) {
    response = st === undefined ? textResponse(c, body) : textResponse(c, body, { status: st });
  } else {
    if (merged["content-type"] === undefined) merged["content-type"] = TEXT_PLAIN;
    const init = { status: st as number, headers: headersInitOf(merged) };
    response = directResponse(
      c,
      isNativeRequestSource(c.rawRequest)
        ? createPlannedResponse(body, init)
        : new Response(body, init),
    );
  }
  if (live) clearStagedInPlace(c);
  return response;
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
  const live = headers === undefined;
  const merged = live ? liveStaged(c) : consumeStaged(c, headers);
  // Response.json sets `application/json` and serializes natively — 74ns
  // cheaper than stringify + record init (see docs/AUDIT.md).
  // U3c: the status write path is gone — the parameter is the only source.
  const st = status;
  let response: Response;
  if (st !== undefined && isEmptyStatus(st)) {
    response = emptyStatusResponse(st, dropContentHeaders(merged));
  } else if (sourceMethod(c.rawRequest) === "HEAD") {
    // The HEAD view serializes once, here — Response.json would attach a body.
    const jsonText =
      typeof payload === "object" && payload !== null
        ? (c.bodySerializedValue ?? (c.bodySerializedValue = JSON.stringify(payload) ?? "null"))
        : (JSON.stringify(payload) ?? "null");
    response = sugarHead(c, merged, "application/json", byteLengthOf(jsonText), st, jsonText);
  } else if (isNativeRequestSource(c.rawRequest)) {
    const bodyText =
      typeof payload === "object" && payload !== null
        ? (c.bodySerializedValue ?? (c.bodySerializedValue = JSON.stringify(payload) ?? "null"))
        : (JSON.stringify(payload) ?? "null");
    if (merged === undefined) {
      response = directResponse(
        c,
        createPlannedResponse(bodyText, st === undefined ? {} : { status: st }, "application/json"),
      );
    } else {
      if (merged["content-type"] === undefined) {
        merged["content-type"] = "application/json";
      }
      response = directResponse(
        c,
        createPlannedResponse(bodyText, {
          ...(st !== undefined ? { status: st } : {}),
          headers: headersInitOf(merged),
        }),
      );
    }
  } else if (merged === undefined && status === undefined) {
    response = directResponse(c, Response.json(payload));
  } else {
    response = directResponse(
      c,
      Response.json(
        payload,
        merged === undefined
          ? { status: st }
          : {
              status: st,
              headers: headersInitOf(merged),
            },
      ),
    );
  }
  if (live) clearStagedInPlace(c);
  return response;
};

export const sugarHtml = (
  c: ContextState,
  body: string,
  status?: number,
  headers?: Record<string, HeaderValue>,
): Response => {
  const live = headers === undefined;
  const merged = live ? liveStaged(c) : consumeStaged(c, headers);
  // text/html is the DEFAULT, not an override — the caller's explicit
  // content-type wins (hono's setDefaultContentType order). The merged map
  // is already normalized to lowercase keys; the live record is written
  // directly (it is cleared right after the Response is built).
  const withType =
    merged === undefined
      ? { "content-type": TEXT_HTML }
      : ((merged["content-type"] ??= TEXT_HTML), merged);
  // U3c: the status write path is gone — the parameter is the only source.
  const st = status;
  let response: Response;
  // Null-body statuses never carry the html content-type (see sugarText).
  if (st !== undefined && isEmptyStatus(st)) {
    response = new Response(null, {
      status: st,
      headers: headersInitOf(dropContentHeaders(withType) ?? {}),
    });
  } else if (sourceMethod(c.rawRequest) === "HEAD") {
    response = sugarHead(
      c,
      withType,
      undefined,
      payloadLength(body as string | Uint8Array),
      st,
      typeof body === "string" ? body : undefined,
    );
  } else {
    const init =
      st === undefined
        ? { headers: headersInitOf(withType) }
        : { status: st, headers: headersInitOf(withType) };
    response = directResponse(
      c,
      isNativeRequestSource(c.rawRequest)
        ? createPlannedResponse(body, init)
        : new Response(body, init),
    );
  }
  if (live) clearStagedInPlace(c);
  return response;
};
