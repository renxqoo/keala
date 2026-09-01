/**
 * The error funnel (R4.3): every failure that must become an HTTP response
 * flows through buildErrorResponse — chain throws, finalize failures and
 * errorResponse's guards all land here. Extracted from dispatch.ts for its
 * 500-line budget. The contract lives in
 * docs/HOTPATH-R4-3-MIGRATION-ERROR-POLICY.md §2.2.
 */

import type { Application } from "./app.ts";
import type { Context } from "./context/context.ts";
import { finalize, flattenHeaders, sanitizeEmptyStatus, stripBody } from "./respond.ts";
import { normalizeError, toHttpError, type HttpError } from "../http/errors.ts";
import { isEmptyStatus, statusMessage } from "../http/status.ts";
import type { HeaderMap } from "../types.ts";

/**
 * Console fallback for UNOBSERVED server faults (R4.3 rule 6): request-path
 * errors fire it only when no error mapper is registered (a registered
 * mapper owns observation — silence is then an explicit `app.onError(() => {})`,
 * not a boolean switch). Non-request framework errors (serve/ws runtime)
 * have no mapper context and always use this fallback.
 */
export const consoleFallback = (
  app: Application,
  url: string | undefined,
  error: HttpError,
): void => {
  if (app.env !== "test" && error.status >= 500) {
    console.error(`\n  ${error.stack ?? error.message}\n  at ${url ?? "unknown"}\n`);
  }
};

/**
 * The absolute last resort. HEAD-aware: a bodied HEAD response desyncs every
 * keep-alive connection (RFC 9110 §9.3.2 — the client would read the body
 * bytes as the next response).
 */
const staticServerError = (method: string | undefined): Response =>
  new Response(method === "HEAD" ? null : "Internal Server Error", {
    status: 500,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof (value as Partial<PromiseLike<unknown>>)?.then === "function";

/**
 * The mapper failure path must stay LOUD: its own bug answers the static 500
 * AND is console.error'd — an envelope bug must never fail silently.
 * Module-level (no per-error closure): the funnel runs this only on bugs.
 */
const mapperFailed = (c: Context, mapperErr: unknown): Response => {
  const normalized = normalizeError(mapperErr);
  console.error(
    `\n  error mapper failed: ${normalized.stack ?? normalized.message}\n  at ${c.url ?? "unknown"}\n`,
  );
  return staticServerError(c.method);
};

const buildErrorResponse = (
  app: Application,
  c: Context,
  err: unknown,
): Response | Promise<Response> => {
  // Funnel entry contract (R4.3): everything downstream sees an HttpError —
  // non-HttpError throwables classify in place as an unexposed 500 (real
  // Errors keep their own identity/stack; frozen ones fall back to a wrap).
  const error = toHttpError(err);

  const mapper = app.errorMapper;
  if (mapper === undefined) {
    consoleFallback(app, c.url, error);
    return builtinErrorResponse(app, c, error);
  }
  // TAKEOVER FAST PATH: a mapper returning a Response bypasses the context
  // reset entirely — the Response is already built, nothing reads the stale
  // state (retirement resets pooled contexts; the merge excludes
  // content-describing headers by name). The reset only exists for the
  // built-in path, which constructs FROM that state — see
  // builtinErrorResponse. One reset's worth of writes saved per takeover.
  try {
    const out = mapper(error, c);
    if (isThenable(out)) {
      // ADOPT through Promise.resolve: a hand-rolled thenable's .then may
      // return anything — verbatim .then() chaining once leaked undefined
      // through the never-reject boundary (review round finding).
      return Promise.resolve(out).then(
        (res) => finalizeMapperResponse(app, c, res, error),
        (mapperErr: unknown) => mapperFailed(c, mapperErr),
      );
    }
    return finalizeMapperResponse(app, c, out, error);
  } catch (mapperErr) {
    return mapperFailed(c, mapperErr);
  }
};

/** Apply the takeover rules to a mapper's return value (R4.3 rules 3-4). */
const finalizeMapperResponse = (
  app: Application,
  c: Context,
  res: unknown,
  error: HttpError,
): Response => {
  // void — or any non-Response garbage — declines to the built-in response.
  if (!(res instanceof Response)) return builtinErrorResponse(app, c, error) as Response;
  // A takeover must be SERVABLE. Error-type Responses (Response.error()) and
  // consumed or pre-locked bodies would corrupt the wire — or the NEXT
  // request when the mapper returns a cached module-level Response, a
  // realistic envelope pattern. Fail LOUD exactly like a mapper bug.
  if (res.type === "error" || res.bodyUsed || res.body?.locked === true) {
    const reason =
      res.type === "error"
        ? "an error-type Response"
        : res.bodyUsed
          ? "a consumed Response"
          : "a locked-body Response";
    console.error(
      `\n  error mapper returned ${reason} — build a fresh Response per call\n  at ${c.url ?? "unknown"}\n`,
    );
    return staticServerError(c.method);
  }
  let out = res;
  // RFC 9110 §8.6: 204/304 MUST NOT carry a body — sanitized exactly like
  // the committed-Response path (Bun constructs it, undici refuses).
  if (isEmptyStatus(res.status) && res.body !== null) out = sanitizeEmptyStatus(res);
  if (c.method === "HEAD" && out.body !== null) out = stripBody(out);
  mergeAbsentHeaders(out, error, c.headersRecord);
  return out;
};

/**
 * Never merged onto a takeover: content-describing headers (they describe a
 * body that is NOT the mapper's — a merged content-length desyncs framing on
 * the Node adapter) and the prototype-hazard names the public header API
 * already refuses.
 */
const MERGE_FORBIDDEN_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const MERGE_FORBIDDEN_CONTENT = new Set([
  "content-type",
  "content-length",
  "transfer-encoding",
  "content-encoding",
]);

const isMergeForbidden = (name: string): boolean =>
  MERGE_FORBIDDEN_CONTENT.has(name.toLowerCase()) || MERGE_FORBIDDEN_NAMES.has(name);

/**
 * if-absent merge (R4.3 rule 3): `error.headers` (the throw's own protocol
 * headers, e.g. WWW-Authenticate / Retry-After) and the staged security
 * headers fill only slots the takeover Response left empty — a header the
 * mapper set itself always wins per NAME. if-absent is evaluated per name
 * while values APPEND, so staged multi-value headers (Set-Cookie rotation)
 * keep every value like the built-in path does. One invalid entry drops
 * alone — a bad header must never cost WWW-Authenticate or the staged
 * security headers. An immutable Headers object simply rejects every write
 * (each caught) and ships exactly what the mapper built.
 */
const mergeAbsentHeaders = (res: Response, error: HttpError, staged: HeaderMap | null): void => {
  const headers = res.headers;
  const errorHeaders = error.headers;
  if (errorHeaders !== undefined) {
    for (const [field, value] of Object.entries(errorHeaders)) {
      if (isMergeForbidden(field)) continue;
      try {
        if (headers.has(field)) continue;
        if (Array.isArray(value)) {
          for (const item of value) headers.append(field, String(item));
        } else {
          headers.set(field, String(value));
        }
      } catch {
        // Invalid name/value from an error object — drop it alone. Bun's
        // Headers.has() itself throws on malformed names, so the has() call
        // lives inside this guard too.
      }
    }
  }
  if (staged !== null) {
    const mergedNames = new Set<string>();
    for (const [name, value] of flattenHeaders(staged)) {
      if (value === undefined || isMergeForbidden(name)) continue;
      try {
        // Per-name if-absent: once a name is being merged, later values of
        // the same name append instead of being blocked by has().
        if (headers.has(name) && !mergedNames.has(name)) continue;
        mergedNames.add(name);
        headers.append(name, value);
      } catch {
        // Invalid staged header — drop it alone.
      }
    }
  }
};

/** The built-in text/plain error response — the decline default. */
const builtinErrorResponse = (
  app: Application,
  c: Context,
  error: HttpError,
): Response | Promise<Response> => {
  // A stale committed response must not shadow the error; the built-in
  // constructs FROM this state, so reset it here. Headers the chain staged
  // ride along (koa parity — security headers must still cover error
  // pages); only content-DESCRIBING headers drop (they describe the body
  // that failed to ship). The takeover path skips this entirely.
  c._res = undefined;
  const record = c.headersRecord;
  if (record !== null) {
    delete record["content-type"];
    delete record["content-length"];
    delete record["transfer-encoding"];
    delete record["content-encoding"];
  }
  c.bodyValue = null;
  c.messageValue = "";
  c.flags = 0;
  // FAST PATH: nothing staged, nothing to replay, not HEAD, bodied status —
  // construct the exact same bytes directly and skip the staged-state
  // machinery + finalize walk entirely (the default app's every error page).
  // Byte-equivalence with the staged path is locked by the R4.3 tests.
  if (
    c.headersRecord === null &&
    error.headers === undefined &&
    c.method !== "HEAD" &&
    !isEmptyStatus(error.status)
  ) {
    return new Response(
      error.expose === true
        ? error.message
        : statusMessage(error.status) || "Internal Server Error",
      {
        status: error.status,
        headers: { "content-type": "text/plain; charset=utf-8" },
      },
    );
  }
  for (const [field, value] of Object.entries(error.headers ?? {})) {
    // The error path must never throw; skip headers that fail validation.
    try {
      c.set(field, Array.isArray(value) ? value : String(value));
    } catch {
      // Invalid header from an error object — drop it silently.
    }
  }
  c.status = error.status;
  const message =
    error.expose === true ? error.message : statusMessage(error.status) || "Internal Server Error";
  c.set("Content-Type", "text/plain; charset=utf-8");
  c.body = message;
  // TERMINAL conversion — the error path must never re-enter the full error
  // pipeline: a finalize failure here (say, a staged header no Response can
  // carry) answers the static 500 directly. This built-in path never calls
  // the mapper, so a mapper failure can never recurse (the historical
  // mutual-recursion bug fired app.onerror ~1.3k times for ONE request).
  // finalize is synchronous here by construction: _res is cleared and the
  // body is the plain message string, so no stream/HEAD async branch exists.
  try {
    return finalize(app, c) as Response;
  } catch {
    return staticServerError(c.method);
  }
};

/**
 * Wrap the funnel in the never-throw guard: a failing error response builder
 * answers the static 500 instead of rejecting past `app.handle`.
 */
export const errorResponse = (
  app: Application,
  c: Context,
  err: unknown,
): Response | Promise<Response> => {
  try {
    const out = buildErrorResponse(app, c, err);
    if (out instanceof Promise) {
      return out.catch(() => staticServerError(c.method));
    }
    return out;
  } catch {
    return staticServerError(c.method);
  }
};
