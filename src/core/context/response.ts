/**
 * Response-side context API — prototype accessors over the flat context.
 *
 * State mode: handlers write `c.status / c.body / c.set(...)`; the finalizer
 * (`core/respond.ts`) converts the accumulated state into a web `Response`
 * exactly once, preferring the bare-Response fast path (hono-consistent
 * content-type behavior: the runtime adds `text/plain` / `application/json`).
 */

import type { HeaderMap, HeaderValue, ResponseBody } from "../../types.ts";
import { isEmptyStatus, isRedirectStatus, statusMessage } from "../../http/status.ts";
import { expandContentType, mimeFromExtension } from "../../utils/mime.ts";
import {
  contentDisposition,
  escapeHtml,
  validateHeaderName,
  validateHeaderValue,
} from "../../utils/text.ts";
import { byteLengthOf, encodeUrlValue } from "../../utils/url.ts";
import type { ContextState } from "./state.ts";
import type { RequestApi } from "./request.ts";

export interface ResponseApi {
  status: number;
  message: string;
  body: ResponseBody;
  type: string;
  length: number | undefined;
  etag: string;
  lastModified: Date | undefined;
  /** Committed response (dual-mode return style); undefined in state mode. */
  readonly res: Response | undefined;
  readonly headerSent: boolean;
  set(field: string | Record<string, HeaderValue>, value?: HeaderValue): void;
  append(field: string, value: HeaderValue): void;
  remove(field: string): void;
  vary(field: string): void;
  has(field: string): boolean;
  resHeader(field: string): string;
  attachment(
    filename?: string,
    options?: { fallback?: string | false; type?: "attachment" | "inline" | string },
  ): void;
  redirect(url: string, alt?: string): void;
  back(alt?: string): void;
  /** Response sugar (return style) — hono-compatible signatures. */
  text(body: string, status?: number, headers?: Record<string, HeaderValue>): Response;
  json(body: unknown, status?: number, headers?: Record<string, HeaderValue>): Response;
  html(body: string, status?: number, headers?: Record<string, HeaderValue>): Response;
}

/** Materialize the lazy header record on first response write. */
// Prototype-less by design: inherited keys (`constructor`, `__proto__`)
// must never surface as header values or accept prototype writes — an
// app echoing user-controlled names through c.append() would otherwise
// corrupt internal state.
const recordOf = (c: ContextState): HeaderMap => (c.headersRecord ??= Object.create(null));

const normalizeDispositionType = (type: string | undefined): string => {
  if (type === undefined) return "attachment";
  if (typeof type !== "string" || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(type)) {
    throw new TypeError("invalid type");
  }
  return type.toLowerCase();
};

const basenameOf = (filename: string): string => {
  const slash = Math.max(filename.lastIndexOf("/"), filename.lastIndexOf("\\"));
  return slash === -1 ? filename : filename.slice(slash + 1);
};

const TEXT_PLAIN = "text/plain; charset=utf-8";
const TEXT_HTML = "text/html; charset=utf-8";

/**
 * Koa's `encodeurl`, UTF-8 correct: percent-encode characters unsafe in a
 * Location header (non-ASCII, controls, space, `"`, `'`, `<`, `>`, `` ` ``)
/** Any explicit Content-Length is stale once a body lands (koa recomputes). */
const clearTouchedLength = (c: ContextState): void => {
  if (c.headersRecord?.["content-length"] !== undefined) {
    delete c.headersRecord["content-length"];
  }
};

/**
 * The sugar helpers CONSUME the staged headers: whatever c.set()/c.cookies
 * wrote before the return is delivered inside the built Response, and the
 * staging record is cleared so the finalizer does not merge it a second time.
 * Only writes staged AFTER the sugar return hit the rule-4 merge path.
 */
const consumeStaged = (
  c: ContextState,
  headers: Record<string, HeaderValue> | undefined,
): Record<string, HeaderValue> | undefined => {
  const merged = mergedHeadersOf(c, headers);
  if (merged !== undefined && c.headersRecord !== null) c.headersRecord = null;
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

export const responseApi: ThisType<ContextState & ResponseApi & RequestApi> & ResponseApi = {
  get res(): Response | undefined {
    return this._res;
  },
  get headerSent(): boolean {
    return false;
  },
  get status(): number {
    // A committed Response (return style) is the response — post-next
    // middleware must observe its status, not the stale state default.
    return this._res !== undefined ? this._res.status : this.statusValue;
  },
  set status(code: number) {
    if (typeof code !== "number" || !Number.isInteger(code) || code < 200 || code > 599) {
      throw new TypeError(`Invalid status code: ${JSON.stringify(code)}`);
    }
    this.flags |= 1;
    if (this.statusValue !== code) this.messageValue = "";
    this.statusValue = code;
    if (isEmptyStatus(code)) {
      // Koa: empty statuses carry no body and no content headers.
      this.bodyValue = null;
      const record = this.headersRecord;
      if (record !== null) {
        delete record["content-type"];
        delete record["content-length"];
        delete record["transfer-encoding"];
      }
    }
  },
  get message(): string {
    return this.messageValue || statusMessage(this.statusValue);
  },
  set message(value: string) {
    if (typeof value !== "string" || value.includes("\r") || value.includes("\n")) {
      throw new TypeError("Invalid status message: CR/LF are not allowed");
    }
    this.messageValue = value;
  },
  get body(): ResponseBody {
    return this.bodyValue;
  },
  set body(value: ResponseBody) {
    this.bodyValue = value;
    if (value === null || value === undefined) {
      // Koa 3: clearing a JSON-typed body yields the literal "null".
      if (!isEmptyStatus(this.statusValue) && this.type === "application/json") {
        this.bodyValue = "null";
        return;
      }
      if (value === null) this.flags |= 2;
      if (!isEmptyStatus(this.statusValue)) this.statusValue = 204;
      // The implicit 204 is an explicit status as far as koa is concerned.
      this.flags |= 1;
      this.remove("Content-Type");
      this.remove("Content-Length");
      this.remove("Transfer-Encoding");
      return;
    }
    if ((this.flags & 1) === 0) this.statusValue = 200;
    if (typeof value === "string") {
      clearTouchedLength(this);
      return;
    }
    if (value instanceof Uint8Array) {
      clearTouchedLength(this);
      return;
    }
    if (value instanceof ReadableStream) {
      // A stream has unknown length by construction — any pre-existing
      // Content-Length describes a DIFFERENT payload and desyncs the
      // response behind every proxy.
      this.remove("Content-Length");
      return;
    }
    if (value instanceof Blob) {
      recordOf(this)["content-length"] = String(value.size);
      return;
    }
    if (value instanceof Response) {
      // Koa 3: a web Response can be assigned directly; status and headers win.
      if (value.status >= 200 && value.status <= 599) {
        this.statusValue = value.status;
        this.flags |= 1;
      }
      // Drop any stale length FIRST — the response's own (authoritative)
      // headers are copied right after and re-establish it when present.
      this.remove("Content-Length");
      for (const key of value.headers.keys()) {
        // set-cookie is multi-value: get() would join values with ", " and
        // collapse distinct cookies — append each individually.
        if (key === "set-cookie") continue;
        this.set(key, value.headers.get(key) ?? "");
      }
      for (const cookie of value.headers.getSetCookie()) this.append("Set-Cookie", cookie);
      this.bodyValue = value.body;
      return;
    }
    // Plain object: stored as-is; the finalizer serializes via Response.json.
    clearTouchedLength(this);
  },
  get type(): string {
    const raw = this.headersRecord?.["content-type"];
    if (raw === undefined) return "";
    const value = Array.isArray(raw) ? (raw.at(-1) ?? "") : raw;
    return value.split(";")[0]?.trim().toLowerCase() ?? "";
  },
  set type(value: string | null | undefined) {
    if (value === null || value === undefined) {
      if (this.headersRecord !== null) delete this.headersRecord["content-type"];
      return;
    }
    // Koa: shorthand/extension values expand to full MIME types with charset;
    // unexpandable tokens remove the header (the finalizer falls back to the
    // runtime default).
    const full = expandContentType(value);
    if (full === null) {
      if (this.headersRecord !== null) delete this.headersRecord["content-type"];
      return;
    }
    validateHeaderValue("content-type", full);
    recordOf(this)["content-type"] = full;
  },
  get length(): number | undefined {
    const raw = this.headersRecord?.["content-length"];
    if (raw !== undefined) {
      const value = Array.isArray(raw) ? (raw[0] ?? "") : raw;
      return Number.parseInt(value, 10) || 0;
    }
    const body = this.bodyValue;
    if (typeof body === "string") return byteLengthOf(body);
    if (body instanceof Uint8Array) return body.byteLength;
    if (body instanceof Blob) return body.size;
    if (body !== null && typeof body === "object" && !(body instanceof ReadableStream)) {
      return byteLengthOf(JSON.stringify(body) ?? "null");
    }
    return undefined;
  },
  set length(value: number) {
    // Koa: Content-Length is never written alongside Transfer-Encoding.
    if (this.headersRecord?.["transfer-encoding"] !== undefined) return;
    const n = Math.trunc(Number(value));
    this.flags |= 8;
    recordOf(this)["content-length"] = String(Number.isNaN(n) ? 0 : n);
  },
  get etag(): string {
    return this.resHeader("ETag");
  },
  set etag(value: string) {
    if (value.length === 0) {
      this.remove("ETag");
      return;
    }
    this.set("ETag", value.startsWith('"') || value.startsWith("W/") ? value : `"${value}"`);
  },
  get lastModified(): Date | undefined {
    const raw = this.resHeader("Last-Modified");
    if (raw.length === 0) return undefined;
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? undefined : date;
  },
  set lastModified(value: Date | string) {
    const date = typeof value === "string" ? new Date(value) : value;
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
      throw new TypeError("lastModified must be a Date or a parseable date string");
    }
    this.set("Last-Modified", date.toUTCString());
  },
  attachment(
    filename?: string,
    options?: { fallback?: string | false; type?: "attachment" | "inline" | string },
  ) {
    const disposition = normalizeDispositionType(options?.type);
    if (filename === undefined) {
      this.set("Content-Disposition", disposition);
      return;
    }
    const base = basenameOf(filename);
    this.set("Content-Disposition", contentDisposition(base, options?.fallback, disposition));
    // GHSA-c5vw-j4hf-j526: never override an existing Content-Type.
    if (base.lastIndexOf(".") !== -1 && !this.has("Content-Type")) {
      const mime = mimeFromExtension(base);
      if (mime !== null) recordOf(this)["content-type"] = mime;
    }
  },
  back(alt?: string): void {
    // Koa: jump back to the Referrer when it is same-origin, else alt.
    const referrer = this.get("referrer");
    if (referrer.length > 0) {
      try {
        const url = new URL(referrer, this.href);
        if (url.host === this.host) {
          this.redirect(referrer);
          return;
        }
      } catch {
        // fall through to alt on unparseable referrers
      }
    }
    this.redirect(alt || "/");
  },
  redirect(url: string, alt = "/") {
    if (url === "back") return this.back(alt); // one same-origin gate, both spellings
    const raw = url;
    // Koa: absolute URLs are normalized through URL; Location is encodeurl'd
    // so non-ASCII targets never break the header.
    let target = raw;
    if (raw.startsWith("http://") || raw.startsWith("https://")) {
      try {
        target = new URL(raw).toString();
      } catch {
        target = raw;
      }
    }
    this.set("Location", encodeUrlValue(target));
    // Koa goes through the status setter: coercing to 302 resets the message.
    if (!isRedirectStatus(this.statusValue)) {
      this.messageValue = "";
      this.statusValue = 302;
      this.flags |= 1;
    }
    if (this.accepts("html") === "html") {
      this.type = TEXT_HTML;
      this.body = `Redirecting to ${escapeHtml(target)}.`;
    } else {
      this.type = TEXT_PLAIN;
      this.body = `Redirecting to ${target}.`;
    }
  },
  set(field: string | Record<string, HeaderValue>, value?: HeaderValue) {
    if (typeof field === "object") {
      for (const key of Object.keys(field)) {
        this.set(key, field[key] as HeaderValue);
      }
      return;
    }
    if (value === undefined || value === null) return;
    if (typeof value === "number" || typeof value === "boolean") {
      this.set(field, String(value));
      return;
    }
    const name = field.toLowerCase();
    if (name !== "content-type" && name !== "content-length") validateHeaderName(name);
    if (typeof value === "string") {
      validateHeaderValue(name, value);
      recordOf(this)[name] = value;
      return;
    }
    // RFC 9110 singletons: multiple Content-Type/Length values would be
    // comma-joined into an invalid header — refuse instead (koa #1899).
    if (name === "content-type" || name === "content-length") {
      throw new TypeError(`${field} is a singleton header and cannot be set to an array`);
    }
    for (const entry of value) validateHeaderValue(name, entry);
    this.flags |= 4;
    recordOf(this)[name] = [...value];
  },
  append(field: string, value: HeaderValue) {
    const name = field.toLowerCase();
    if (name !== "content-type" && name !== "content-length") validateHeaderName(name);
    const next = typeof value === "string" ? [value] : [...value];
    for (const entry of next) validateHeaderValue(name, entry);
    const existing = this.headersRecord?.[name];
    if (existing === undefined) {
      if (next.length === 1) {
        recordOf(this)[name] = next[0] ?? "";
        return;
      }
      this.flags |= 4;
      recordOf(this)[name] = next;
      return;
    }
    this.flags |= 4;
    const list = Array.isArray(existing) ? [...existing] : [existing];
    list.push(...next);
    recordOf(this)[name] = list;
  },
  remove(field: string) {
    if (this.headersRecord !== null) delete this.headersRecord[field.toLowerCase()];
  },
  vary(field: string) {
    if (field.includes(",") || field.includes(" ")) {
      throw new TypeError("Vary field must be a single token");
    }
    const current = this.resHeader("Vary");
    if (current.length === 0) {
      this.set("Vary", field);
      return;
    }
    const tokens = current.split(",").map((token) => token.trim().toLowerCase());
    if (!tokens.includes(field.toLowerCase())) this.append("Vary", field);
  },
  has(field: string): boolean {
    return this.headersRecord?.[field.toLowerCase()] !== undefined;
  },
  resHeader(field: string): string {
    const raw = this.headersRecord?.[field.toLowerCase()];
    if (raw === undefined) return "";
    return Array.isArray(raw) ? raw.join(", ") : raw;
  },
  text(body: string, status?: number, headers?: Record<string, HeaderValue>): Response {
    const merged = consumeStaged(this, headers);
    // An explicitly staged c.status wins over the default (hono parity).
    const staged = (this.flags & 1) !== 0 ? this.statusValue : undefined;
    if (merged === undefined && status === undefined && staged === undefined) {
      return new Response(body);
    }
    const st = status ?? staged ?? 200;
    if (merged === undefined) return new Response(body, { status: st });
    if (merged["content-type"] === undefined) merged["content-type"] = TEXT_PLAIN;
    return new Response(body, { status: st, headers: headersInitOf(merged) });
  },
  json(body: unknown, status?: number, headers?: Record<string, HeaderValue>): Response {
    // `undefined` is not JSON-serializable (Response.json would throw a raw
    // TypeError → 500). A handler doing c.json(findUser()) on a miss gets
    // the same graceful "null" JSON.stringify produces for absent values.
    const payload = body === undefined ? null : body;
    const merged = consumeStaged(this, headers);
    // Response.json sets `application/json` and serializes natively — 74ns
    // cheaper than stringify + record init (see docs/AUDIT.md).
    const staged = (this.flags & 1) !== 0 ? this.statusValue : undefined;
    if (merged === undefined && status === undefined && staged === undefined) {
      return Response.json(payload);
    }
    return Response.json(
      payload,
      merged === undefined
        ? { status: status ?? staged }
        : {
            ...(status === undefined && staged === undefined ? {} : { status: status ?? staged }),
            headers: headersInitOf(merged),
          },
    );
  },
  html(body: string, status?: number, headers?: Record<string, HeaderValue>): Response {
    const merged = consumeStaged(this, headers);
    const withType =
      merged === undefined
        ? { "content-type": TEXT_HTML }
        : { ...merged, "content-type": TEXT_HTML };
    const staged = (this.flags & 1) !== 0 ? this.statusValue : undefined;
    const st = status ?? staged;
    if (st === undefined) return new Response(body, { headers: headersInitOf(withType) });
    return new Response(body, { status: st, headers: headersInitOf(withType) });
  },
};
