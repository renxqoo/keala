/** Response header operations shared by the public context accessors. */

import type { HeaderMap, HeaderValue } from "../../types.ts";
import { validateHeaderName, validateHeaderValue } from "../../utils/text.ts";
import {
  isDirectHeader,
  markCommittedHeadersStaged,
  tryAppendCommittedHeader,
  tryDeleteCommittedHeader,
  trySetCommittedHeader,
} from "../committed-headers.ts";
import { FLAG_COMMITTED_HEADERS_APPLIED } from "./state.ts";
import { isImplicitTextResponse, TEXT_PLAIN } from "./sugar.ts";
import type { ContextState } from "./state.ts";

/** Materialize staged headers and make every mirrored fast write a rebuild input. */
export const stagedHeadersOf = (c: ContextState): HeaderMap => {
  markCommittedHeadersStaged(c);
  return (c.headersRecord ??= Object.create(null) as HeaderMap);
};

/** Mirror a successful in-place write for observation and newer commits. */
const mirrorHeadersOf = (c: ContextState): HeaderMap =>
  (c.headersRecord ??= Object.create(null) as HeaderMap);

/** Keep Bun 1.4's implicit c.text() type observable after an in-place write. */
const prepareDirectResponse = (c: ContextState): boolean => {
  const response = c._res;
  if (
    response !== undefined &&
    isImplicitTextResponse(response) &&
    !response.headers.has("content-type")
  ) {
    return trySetCommittedHeader(c, "content-type", TEXT_PLAIN);
  }
  return true;
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
  const name = field.toLowerCase();
  if (name !== "content-type" && name !== "content-length") validateHeaderName(name);
  if (typeof value === "string") {
    validateHeaderValue(name, value);
    if (isDirectHeader(name) && prepareDirectResponse(c) && trySetCommittedHeader(c, name, value)) {
      mirrorHeadersOf(c)[name] = value;
      return;
    }
    stagedHeadersOf(c)[name] = value;
    return;
  }
  if (name === "content-type" || name === "content-length") {
    throw new TypeError(`${field} is a singleton header and cannot be set to an array`);
  }
  for (const entry of value) validateHeaderValue(name, entry);
  c.flags |= 4;
  stagedHeadersOf(c)[name] = [...value];
};

export const appendResponseHeader = (c: ContextState, field: string, value: HeaderValue): void => {
  const name = field.toLowerCase();
  if (name !== "content-type" && name !== "content-length") validateHeaderName(name);
  const next = typeof value === "string" ? [value] : [...value];
  for (const entry of next) validateHeaderValue(name, entry);
  const singleton = name === "content-type" || name === "content-length";
  if (singleton && next.length > 1) {
    throw new TypeError(`${field} is a singleton header and cannot be set to an array`);
  }
  let existing = c.headersRecord?.[name];
  if (existing === undefined && c._res !== undefined && name !== "set-cookie") {
    const committed = c._res.headers.get(name);
    if (committed !== null && committed.length > 0) existing = committed;
  }
  if (singleton && existing !== undefined) {
    throw new TypeError(`${field} is a singleton header and cannot be appended to`);
  }
  // One append is atomic. Multi-entry input stays on Semantic so an exotic
  // Headers implementation cannot fail halfway through the mutation.
  if (
    !singleton &&
    name !== "set-cookie" &&
    next.length === 1 &&
    prepareDirectResponse(c) &&
    tryAppendCommittedHeader(c, name, next[0] ?? "")
  ) {
    if (existing === undefined) {
      mirrorHeadersOf(c)[name] = next[0] ?? "";
    } else {
      const list = Array.isArray(existing) ? [...existing] : [existing];
      list.push(next[0] ?? "");
      mirrorHeadersOf(c)[name] = list;
      c.flags |= 4;
    }
    return;
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
  if (c._res === undefined) return;
  if (isDirectHeader(name) && prepareDirectResponse(c) && tryDeleteCommittedHeader(c, name)) {
    // Keep a tombstone in case an outer middleware later commits a newer
    // Response. While APPLIED remains set, the current Response is returned
    // verbatim; a newer commit clears it and the removal is replayed.
    (c.removedValue ??= []).push(name);
    c.flags |= 16 | FLAG_COMMITTED_HEADERS_APPLIED;
    return;
  }
  markCommittedHeadersStaged(c);
  (c.removedValue ??= []).push(name);
  c.flags |= 16;
};

export const varyResponseHeader = (c: ContextState, field: string): void => {
  if (field.includes(",") || field.includes(" ")) {
    throw new TypeError("Vary field must be a single token");
  }
  const staged = c.headersRecord?.["vary"];
  const stagedText = staged === undefined ? "" : Array.isArray(staged) ? staged.join(", ") : staged;
  const committedText = c._res !== undefined ? (c._res.headers.get("vary") ?? "") : "";
  const current = stagedText.length > 0 ? stagedText : committedText;
  const tokens = current
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (!tokens.some((token) => token.toLowerCase() === field.toLowerCase())) tokens.push(field);
  setResponseHeader(c, "Vary", tokens.join(", "));
};

export const hasResponseHeader = (c: ContextState, field: string): boolean =>
  c.headersRecord?.[field.toLowerCase()] !== undefined;

export const responseHeaderValue = (c: ContextState, field: string): string => {
  const raw = c.headersRecord?.[field.toLowerCase()];
  if (raw === undefined) return "";
  return Array.isArray(raw) ? raw.join(", ") : raw;
};
