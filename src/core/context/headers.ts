/**
 * Response header operations shared by the public context accessors.
 *
 * 0.7 commit contract: before a Response is committed, writes stage into the
 * flat `headersRecord` (zero allocation until touched). After the commit
 * they go STRAIGHT onto the committed Response's `Headers` — the same
 * semantics hono gives a post-`next()` `c.header()`. Post-commit SETs and
 * REMOVEs additionally mirror into the record, an idempotent write that
 * replays onto a newer commit and onto the error funnel's rebuilt response
 * (secureHeaders must survive an outer middleware throwing after next());
 * content-describing names never mirror — they describe THIS body, not
 * whatever a newer commit carries. A post-commit APPEND joins the record's
 * existing entry (the record merge would otherwise clobber it with the
 * older staged value); with no entry it touches only the response, as do
 * all direct Set-Cookie writes (set-cookie merges are additive — a mirror
 * would duplicate). The one rejection is an immutable guard (a handler
 * returned a fetched/redirected Response): a loud TypeError, because the
 * fix — build the Response locally — is the caller's to make.
 */

import type { HeaderMap, HeaderValue } from "../../types.ts";
import { validateHeaderName, validateHeaderValue } from "../../utils/text.ts";
import type { ContextState } from "./state.ts";

/** Materialize the staged-header record (pre-commit writes land here). */
export const stagedHeadersOf = (c: ContextState): HeaderMap =>
  (c.headersRecord ??= Object.create(null) as HeaderMap);

const IMMUTABLE = (error: unknown): TypeError =>
  new TypeError(
    "cannot write headers of the committed response — it carries an immutable guard (a fetched or redirected Response). Return a locally-built Response instead.",
    { cause: error },
  );

/** The two singleton headers skip name validation (always well-formed). */
const isSingleton = (name: string): boolean => name === "content-type" || name === "content-length";

/**
 * Headers a post-commit SET must NOT mirror into the staged record: they
 * describe the BODY they were written against, so replaying them onto a
 * newer commit (or the error funnel's rebuild, which prunes exactly these
 * names) would ship a stale content-type or a desyncing content-length for
 * a different payload. The in-place write on the CURRENT response still
 * happens — only the replay is suppressed.
 */
const MIRROR_FORBIDDEN = new Set([
  "content-type",
  "content-length",
  "transfer-encoding",
  "content-encoding",
]);

/** In-place single-header SET on the committed Response (arrays → multi-value). */
const committedSet = (res: Response, name: string, value: string | string[]): void => {
  try {
    res.headers.delete(name);
    if (Array.isArray(value)) {
      for (const item of value) res.headers.append(name, item);
      return;
    }
    res.headers.set(name, value);
  } catch (error) {
    if (error instanceof TypeError) throw IMMUTABLE(error);
    throw error;
  }
};

export const setResponseHeader = (
  c: ContextState,
  field: string | Record<string, HeaderValue>,
  value?: HeaderValue,
): void => {
  if (typeof field === "object") {
    for (const key of Object.keys(field)) setResponseHeader(c, key, field[key] as HeaderValue);
    return;
  }
  if (value === undefined || value === null) return;
  if (typeof value === "number" || typeof value === "boolean") {
    setResponseHeader(c, field, String(value));
    return;
  }
  const name = validateHeaderName(field);
  if (typeof value === "string") {
    validateHeaderValue(name, value);
    const res = c._res;
    if (res !== undefined) {
      committedSet(res, name, value);
      // Mirror the settled value into the staged record: the error funnel
      // rebuilds from the record when a LATER middleware throws, and a
      // re-apply through the finalizer is idempotent (delete + set).
      // Content-describing names never mirror (MIRROR_FORBIDDEN — they
      // describe THIS body, not whatever a newer commit carries), and
      // set-cookie SETs never mirror (set-cookie merges are additive; the
      // cookie facade writes the record itself, so late cookies survive).
      if (name !== "set-cookie" && !MIRROR_FORBIDDEN.has(name)) {
        (c.headersRecord ??= Object.create(null) as HeaderMap)[name] = value;
      }
      return;
    }
    stagedHeadersOf(c)[name] = value;
    return;
  }
  if (isSingleton(name)) {
    throw new TypeError(`${field} is a singleton header and cannot be set to an array`);
  }
  for (const entry of value) validateHeaderValue(name, entry);
  c.flags |= 4;
  const res = c._res;
  if (res !== undefined) {
    committedSet(res, name, [...value]);
    if (name !== "set-cookie" && !MIRROR_FORBIDDEN.has(name)) {
      (c.headersRecord ??= Object.create(null) as HeaderMap)[name] = [...value];
    }
    return;
  }
  stagedHeadersOf(c)[name] = [...value];
};

export const appendResponseHeader = (c: ContextState, field: string, value: HeaderValue): void => {
  const name = validateHeaderName(field);
  const next = typeof value === "string" ? [value] : [...value];
  for (const entry of next) validateHeaderValue(name, entry);
  const singleton = isSingleton(name);
  if (singleton && next.length > 1) {
    throw new TypeError(`${field} is a singleton header and cannot be set to an array`);
  }
  const res = c._res;
  if (res !== undefined) {
    if (singleton && res.headers.get(name) !== null) {
      throw new TypeError(`${field} is a singleton header and cannot be appended to`);
    }
    try {
      for (const entry of next) res.headers.append(name, entry);
    } catch (error) {
      if (error instanceof TypeError) throw IMMUTABLE(error);
      throw error;
    }
    // An append is the user's LATEST intent for a header that already has
    // state: join the record's existing entry so the finalizer's record
    // merge (delete + set) carries the appended value instead of clobbering
    // it with the older staged one. set-cookie never joins — its merge is
    // additive, so a joined entry would apply twice; the in-place write
    // above already delivered it.
    const record = c.headersRecord;
    const staged = record?.[name];
    if (staged !== undefined && name !== "set-cookie") {
      c.flags |= 4;
      (record as HeaderMap)[name] = Array.isArray(staged)
        ? [...staged, ...next]
        : [staged, ...next];
    }
    return;
  }
  const existing = c.headersRecord?.[name];
  if (singleton && existing !== undefined) {
    throw new TypeError(`${field} is a singleton header and cannot be appended to`);
  }
  if (existing === undefined) {
    if (next.length === 1) {
      stagedHeadersOf(c)[name] = next[0] ?? "";
      return;
    }
    c.flags |= 4;
    stagedHeadersOf(c)[name] = next;
    return;
  }
  c.flags |= 4;
  const list = Array.isArray(existing) ? [...existing] : [existing];
  list.push(...next);
  stagedHeadersOf(c)[name] = list;
};

export const removeResponseHeader = (c: ContextState, field: string): void => {
  const name = field.toLowerCase();
  if (c.headersRecord !== null) delete c.headersRecord[name];
  const res = c._res;
  if (res === undefined) return;
  try {
    res.headers.delete(name);
  } catch (error) {
    if (error instanceof TypeError) throw IMMUTABLE(error);
    throw error;
  }
};

// Post-commit reads fall back to the committed Response's own headers:
// `if (!c.has("x-frame-options")) c.setHeader(...)` guards must see what the
// handler's Response already carries, or they silently clobber the
// developer's explicit value with a default.
const committedHeader = (c: ContextState, field: string): string | undefined => {
  const res = c._res;
  if (res === undefined) return undefined;
  const value = res.headers.get(field);
  return value === null ? undefined : value;
};

export const hasResponseHeader = (c: ContextState, field: string): boolean =>
  c.headersRecord?.[field.toLowerCase()] !== undefined || committedHeader(c, field) !== undefined;

export const responseHeaderValue = (c: ContextState, field: string): string => {
  const raw = c.headersRecord?.[field.toLowerCase()];
  if (raw !== undefined) return Array.isArray(raw) ? raw.join(", ") : raw;
  return committedHeader(c, field) ?? "";
};
