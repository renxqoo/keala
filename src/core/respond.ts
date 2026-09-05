/**
 * Finalizer: converts the settled chain into a web `Response`, exactly once.
 *
 * U3c collapsed the state machine: responses are COMMITTED (a handler return
 * — a sugar product or a hand-built Response) or UNTOUCHED (the chain settled
 * without one → synthesized 405/501/OPTIONS, the notFound handler, or the
 * default 404). Staged headers (`c.setHeader` before a commit) merge onto
 * whatever answer ships; empty statuses sanitize; HEAD strips bodies.
 *
 * A committed Response is returned verbatim unless the request staged headers
 * BEFORE the commit — those merge in place, with a rebuild fallback for
 * immutable guards. There is no post-commit body/status rewrite machinery
 * (the setters are gone; a new returned Response is the replacement).
 *
 * Inherited response contracts (docs/MIGRATION.md §3): empty-status header
 * cleanup and the set-cookie/multi-value merge preconditions.
 */

import type { Application } from "./app.ts";
import type { Context } from "./context/context.ts";
import { isEmptyStatus } from "../http/status.ts";
import type { HeaderMap } from "../types.ts";
import { ALLOW_ORDER, KNOWN_METHODS } from "../router/router.ts";
import { repumpStream } from "../utils/streams.ts";

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
          // Empty strings never become wire headers (flattenHeaders parity).
          for (const item of value) if (item.length > 0) headers.append(key, item);
        } else {
          headers.append(key, value);
        }
        continue;
      }
      headers.delete(key);
      if (Array.isArray(value)) {
        for (const item of value) if (item.length > 0) headers.append(key, item);
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

/**
 * The void-notFound fallback (U3c): with the response setters gone, a
 * handler chain that settles without a Response answers the default 404 —
 * staged headers merge onto it, HEAD strips the body (Content-Length is NOT
 * backfilled: there is no would-be body value any more; §2.3-3).
 */
const fromState = (c: Context, head: boolean): Response => {
  const base = new Response("Not Found", { status: 404 });
  const record = c.headersRecord;
  const merged = record !== null && countOf(record) > 0 ? applyStagedHeaders(base, record) : base;
  return head && merged.body !== null ? stripBody(merged) : merged;
};

/**
 * The committed-answer closer, shared by finalize and the error funnel
 * (U3c): merge the headers staged BEFORE the commit onto the committed
 * Response, then the empty-status sanitation and HEAD body strip. Post-commit
 * header writes already landed on the Response directly.
 */
export const finishCommitted = (c: Context, committed: Response): Response => {
  // The merge runs BEFORE empty-status sanitation (BUG-6, 0.6.2 review): a
  // bodied 204/304 used to early-return through the sanitizer and skip the
  // merge entirely. Merge-first is the semantically correct order — the
  // sanitizer then drops exactly the content-DESCRIBING names (they describe
  // a body the empty status forbids) while staged protocol and security
  // headers reach the wire.
  const record = c.headersRecord;
  const merged =
    record !== null && countOf(record) > 0 ? applyStagedHeaders(committed, record) : committed;
  // RFC 9110 §8.6: a 204/304 MUST NOT carry a body. U3c (§2.3-2 tightening):
  // the sanitation is UNCONDITIONAL for empty statuses — even a bodyless
  // answer loses content-describing headers a staged record may have merged
  // on (a staged content-type describing a body the status forbids must
  // never reach the wire).
  if (isEmptyStatus(merged.status)) {
    // Rebuild only when actually dirty (a body or a content-describing
    // header); an already-clean 204/304 keeps its instance identity.
    const headers = merged.headers;
    if (
      merged.body !== null ||
      headers.has("content-type") ||
      headers.has("content-length") ||
      headers.has("transfer-encoding")
    ) {
      return sanitizeEmptyStatus(merged);
    }
  }
  // HEAD drops the body on every path.
  if (c.method === "HEAD" && merged.body !== null) return stripBody(merged);
  // Opt-in error observation for streaming bodies (see AppOptions). U3c: the
  // wiring moved here from the (deleted) state-mode builder — committed and
  // synthesized 405/501 answers pass through it, whatever built the Response
  // (a notFound handler's Response is returned upstream of this closer).
  const streamHook = c.appValue.onStreamError;
  if (streamHook !== undefined && merged.body instanceof ReadableStream) {
    const observed = repumpStream(merged.body, {
      onReadError: (error) =>
        streamHook(error instanceof Error ? error : new Error(String(error)), c),
    });
    return new Response(observed, {
      status: merged.status,
      statusText: merged.statusText,
      headers: merged.headers,
    });
  }
  return merged;
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
    return finishCommitted(c, committed);
  }
  const head = c.method === "HEAD";
  {
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
