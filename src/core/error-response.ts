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
import type { HeaderMap, HeaderValue } from "../types.ts";

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
    // The overwhelmingly common enterprise mapper is synchronous and returns
    // a Response. Brand-check it first: probing `.then` and then brand-checking
    // again added two redundant operations to every mapped error.
    if (out instanceof Response) return finalizeTakeoverResponse(c, out, error);
    if (out === undefined) return builtinErrorResponse(app, c, error);
    if (isThenable(out)) {
      // ADOPT through Promise.resolve: a hand-rolled thenable's .then may
      // return anything — verbatim .then() chaining once leaked undefined
      // through the never-reject boundary (review round finding).
      return Promise.resolve(out).then(
        (res) => finalizeMapperResult(app, c, res, error),
        (mapperErr: unknown) => mapperFailed(c, mapperErr),
      );
    }
    return invalidMapperResult(c);
  } catch (mapperErr) {
    return mapperFailed(c, mapperErr);
  }
};

const invalidMapperResult = (c: Context): Response =>
  mapperFailed(c, new TypeError("error mapper must return a Response, a thenable, or undefined"));

/** Validate the asynchronously adopted value, then apply rules 3-4. */
const finalizeMapperResult = (
  app: Application,
  c: Context,
  res: unknown,
  error: HttpError,
): Response => {
  // Only the contract's explicit `void` declines. Treat every other value as
  // a mapper bug: silently accepting a wrong return type can leak the
  // original error body/status and hides a broken enterprise envelope.
  if (res === undefined) return builtinErrorResponse(app, c, error) as Response;
  if (!(res instanceof Response)) return invalidMapperResult(c);
  return finalizeTakeoverResponse(c, res, error);
};

/** Apply takeover wire-safety and merge rules to a known Response. */
const finalizeTakeoverResponse = (c: Context, res: Response, error: HttpError): Response => {
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
  // Common envelope fast path: no transformation or inherited headers are
  // required. Returning here avoids the larger merge routine entirely.
  const sources = reconciledHeaderSources(c, c.headersRecord);
  if (
    c.method !== "HEAD" &&
    !isEmptyStatus(res.status) &&
    error.headers === undefined &&
    sources === null
  ) {
    return res;
  }
  let out = res;
  // RFC 9110 §8.6: 204/304 MUST NOT carry a body — sanitized exactly like
  // the committed-Response path (Bun constructs it, undici refuses).
  if (isEmptyStatus(res.status) && res.body !== null) out = sanitizeEmptyStatus(res);
  if (c.method === "HEAD" && out.body !== null) out = stripBody(out);
  return mergeAbsentHeaders(out, error, sources);
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
 * security headers. Runtime-created Responses may expose immutable Headers
 * (notably Response.redirect on Node); in that case the Response is rebuilt
 * once with mutable copied headers so protocol/security headers are not lost.
 */
const applyAbsentHeaders = (
  headers: Headers,
  error: HttpError,
  staged: HeaderMap | null,
): boolean => {
  const errorHeaders = error.headers;
  if (errorHeaders !== undefined) {
    for (const [field, value] of Object.entries(errorHeaders)) {
      if (isMergeForbidden(field)) continue;
      try {
        if (headers.has(field)) continue;
      } catch {
        // Headers.has() can only reject a malformed name; immutable guards
        // reject writes, not reads. Drop this field without touching peers.
        continue;
      }
      const multiValue = Array.isArray(value);
      const values = multiValue ? value : [value];
      for (const item of values) {
        try {
          if (multiValue) {
            headers.append(field, String(item));
          } else {
            headers.set(field, String(item));
          }
        } catch {
          // Distinguish a malformed VALUE (drop only that array item) from a
          // valid write rejected by an immutable Headers guard (request one
          // rebuild). The name was already validated by headers.has().
          try {
            const probe = new Headers();
            probe.append(field, String(item));
            return false;
          } catch {
            // Invalid value — keep scanning valid siblings.
          }
        }
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
        try {
          const probe = new Headers();
          probe.append(name, value);
          return false;
        } catch {
          // Invalid staged header — drop it alone.
        }
      }
    }
  }
  return true;
};

const mutableHeaderCopy = (source: Headers): Headers => {
  const headers = new Headers();
  for (const [name, value] of source.entries()) {
    if (name !== "set-cookie") headers.append(name, value);
  }
  for (const cookie of source.getSetCookie()) headers.append("set-cookie", cookie);
  return headers;
};

/**
 * The header state an error rebuild must carry: the STAGED RECORD (the
 * user's latest intent) reconciled over everything the discarded committed
 * Response had baked in. A sugar commit consumes the record INTO the
 * Response and clears it — the record alone then under-reports what the
 * developer staged, and the rebuilt error page would silently drop
 * security headers and cookies. The committed Response is the complete
 * picture for those, so harvest it before the reset; the record still
 * wins per name (later writes), and set-cookie JOINS (both sides are
 * cookies the error page should carry). Content-describing names are
 * pruned downstream by isMergeForbidden, exactly as for the record.
 */
const reconciledHeaderSources = (c: Context, record: HeaderMap | null): HeaderMap | null => {
  const committed = c._res;
  if (committed === undefined) return record;
  let out: HeaderMap | null = null;
  for (const [name, value] of committed.headers.entries()) {
    if (name === "set-cookie") continue; // joined below, order matters
    if (record?.[name] !== undefined) continue; // the record is the later intent
    (out ??= Object.create(null) as HeaderMap)[name] = value;
  }
  const committedCookies = committed.headers.getSetCookie();
  const recordCookies = record?.["set-cookie"];
  if (committedCookies.length > 0 || recordCookies !== undefined) {
    const joined = [...committedCookies];
    if (recordCookies !== undefined) {
      joined.push(...(Array.isArray(recordCookies) ? recordCookies : [recordCookies]));
    }
    (out ??= Object.create(null) as HeaderMap)["set-cookie"] = joined;
  }
  if (out === null) return record;
  if (record !== null) {
    for (const name of Object.keys(record)) {
      if (name === "set-cookie") continue; // already joined
      out[name] = record[name] as HeaderValue;
    }
  }
  return out;
};

const mergeAbsentHeaders = (
  res: Response,
  error: HttpError,
  staged: HeaderMap | null,
): Response => {
  if (applyAbsentHeaders(res.headers, error, staged)) return res;

  // A valid mutation failed, so the runtime guard is immutable. Rebuilding
  // transfers the still-unconsumed body stream without reading or buffering
  // it and preserves multi-value Set-Cookie entries exactly.
  const rebuilt = new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: mutableHeaderCopy(res.headers),
  });
  void applyAbsentHeaders(rebuilt.headers, error, staged);
  return rebuilt;
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
  // that failed to ship). The staged record is reconciled with everything
  // the discarded Response baked in (see reconciledHeaderSources) so a
  // sugar commit's consumed headers survive the rebuild too. The takeover
  // path skips the reset but applies the same reconciliation.
  const record = c.headersRecord;
  const sources = reconciledHeaderSources(c, record);
  c._res = undefined;
  let carriesHeaders = false;
  if (sources !== null) {
    // The rebuild below re-stages through the context and finalizes, so
    // land the reconciled sources in the LIVE record — finalize then
    // carries them (the record object identity is what the memoized
    // cookies facade holds; never swap it).
    const target = record ?? (c.headersRecord = Object.create(null) as HeaderMap);
    if (sources !== target) {
      for (const name of Object.keys(sources)) target[name] = sources[name] as HeaderValue;
    }
    delete target["content-type"];
    delete target["content-length"];
    delete target["transfer-encoding"];
    delete target["content-encoding"];
    for (const _ in target) {
      carriesHeaders = true;
      break;
    }
  }
  c.bodyValue = null;
  c.flags = 0;
  // FAST PATH: nothing staged, nothing to replay, not HEAD, bodied status —
  // construct the exact same bytes directly and skip the staged-state
  // machinery + finalize walk entirely (the default app's every error page).
  // Byte-equivalence with the staged path is locked by the R4.3 tests.
  if (
    !carriesHeaders &&
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
      c.setHeader(field, Array.isArray(value) ? value : String(value));
    } catch {
      // Invalid header from an error object — drop it silently.
    }
  }
  c.status = error.status;
  const message =
    error.expose === true ? error.message : statusMessage(error.status) || "Internal Server Error";
  c.setHeader("Content-Type", "text/plain; charset=utf-8");
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
 * Context-free error funnel for natively-sunk function handlers: they run
 * outside dispatch with no context, so the mapper contract cannot apply
 * (registration refuses the combination loudly). Byte-faithful to the
 * builtin fast path above for the nothing-staged case — exposed 4xx
 * messages, hidden 5xx status text, bodiless HEAD — with the error's own
 * headers riding along exactly as the staged path would deliver them.
 * Empty statuses cannot occur here: toHttpError normalizes any invalid
 * error status to an unexposed 500 in place, so a sunk funnel always
 * answers a bodied status.
 */
export const sunkErrorResponse = (method: string, error: unknown): Response => {
  const http = toHttpError(error);
  const bodyless = method === "HEAD";
  const headers = new Headers({ "content-type": "text/plain; charset=utf-8" });
  if (http.headers !== undefined) {
    for (const [field, value] of Object.entries(http.headers)) {
      try {
        if (Array.isArray(value)) {
          for (const item of value) headers.append(field, item);
        } else {
          headers.append(field, String(value));
        }
      } catch {
        // An invalid header from an error object — drop it silently; the
        // error path must never throw.
      }
    }
  }
  return new Response(
    bodyless
      ? null
      : http.expose === true
        ? http.message
        : statusMessage(http.status) || "Internal Server Error",
    { status: http.status, headers },
  );
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
