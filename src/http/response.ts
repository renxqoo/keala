/**
 * Response facade.
 *
 * Accumulates status / headers / body on a flat state object during the
 * middleware chain; `respond()` turns it into a web `Response` exactly once
 * at the end of the request. Koa-compatible surface (`ctx.response.*`).
 */

import type { HeaderMap, HeaderValue, ResponseBody } from "../types.ts";
import { isEmptyStatus, isRedirectStatus, statusMessage } from "./status.ts";
import { expandContentType, mimeFromExtension, normalizeType } from "../utils/mime.ts";
import { typeIs } from "../negotiation/typeis.ts";
import {
  contentDisposition,
  escapeHtml,
  validateHeaderName,
  validateHeaderValue,
} from "../utils/text.ts";

export interface ResponsePeer {
  readonly request: {
    readonly method: string;
    readonly href: string;
    readonly host: string;
    get(field: string): string;
    accepts(...types: (string | string[])[]): string | string[] | false;
  };
}

export interface ResponseState {
  peer: ResponsePeer;
  _status: number;
  _message: string;
  _headers: HeaderMap;
  _body: ResponseBody;
  /**
   * Bit-packed response flags — one field write per request instead of four.
   * 1 = explicit status, 2 = explicit null body, 4 = multi-value header,
   * 8 = content-length touched.
   */
  _flags: number;
}

/**
 * Expand shorthand/extension content types and append the UTF-8 charset to
 * known textual types (Koa's cache-content-type behavior).
 */
export interface ResponseFacade {
  get(field: string): string;
  status: number;
  message: string;
  body: ResponseBody;
  type: string;
  readonly headers: HeaderMap;
  readonly headerSent: boolean;
  length: number | undefined;
  lastModified: Date | string | undefined;
  etag: string;
  attachment(
    filename?: string,
    options?: { fallback?: string | false; type?: "attachment" | "inline" | string },
  ): void;
  redirect(url: string, alt?: string): void;
  back(alt?: string): void;
  is(...types: (string | string[])[]): string | false;
  set(field: string | Record<string, HeaderValue>, value?: HeaderValue): void;
  append(field: string, value: HeaderValue): void;
  remove(field: string): void;
  vary(field: string): void;
  has(field: string): boolean;
  toJSON(): { status: number; message: string; headers: HeaderMap };
}

const TEXT_PLAIN = "text/plain; charset=utf-8";
const TEXT_HTML = "text/html; charset=utf-8";

/**
 * Koa's `encodeurl`: percent-encode characters unsafe in a Location header
 * (non-ASCII, controls, space, `"`, `<`, `>`, `` ` ``) while leaving existing
 * percent-escapes untouched.
 */
const encodeUrlValue = (url: string): string => {
  let out = "";
  for (let i = 0; i < url.length;) {
    const code = url.charCodeAt(i);
    if (code === 37 && /[0-9a-fA-F]{2}/.test(url.slice(i + 1, i + 3))) {
      out += url.slice(i, i + 3);
      i += 3;
      continue;
    }
    const ch = url[i] as string;
    const unsafe =
      code > 0x7e ||
      code < 0x21 ||
      ch === '"' ||
      ch === "'" ||
      ch === "<" ||
      ch === ">" ||
      ch === "`";
    out += unsafe ? `%${code.toString(16).toUpperCase().padStart(2, "0")}` : ch;
    i += 1;
  }
  return out;
};

/** True when the string body starts with optional whitespace then `<`. */
const startsWithMarkup = (value: string): boolean => {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x3c) return true;
    if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return false;
  }
  return false;
};

/** UTF-8 byte length with an ASCII fast path. */
export const byteLengthOf = (value: string): number => {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 0x7f) return Buffer.byteLength(value);
  }
  return value.length;
};

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

export const responseProto: ThisType<ResponseState & ResponseFacade> & ResponseFacade = {
  get headers(): HeaderMap {
    return this._headers;
  },
  get headerSent(): boolean {
    return false;
  },
  get status(): number {
    return this._status;
  },
  set status(code: number) {
    if (typeof code !== "number" || !Number.isInteger(code) || code < 200 || code > 599) {
      throw new TypeError(`Invalid status code: ${JSON.stringify(code)}`);
    }
    this._flags |= 1;
    if (this._status !== code) this._message = "";
    this._status = code;
    if (isEmptyStatus(code)) {
      // Koa: empty statuses carry no body and no content headers.
      this._body = null;
      delete this._headers["content-type"];
      delete this._headers["content-length"];
      delete this._headers["transfer-encoding"];
    }
  },
  get message(): string {
    return this._message || statusMessage(this._status);
  },
  set message(value: string) {
    if (typeof value !== "string" || value.includes("\r") || value.includes("\n")) {
      throw new TypeError("Invalid status message: CR/LF are not allowed");
    }
    this._message = value;
  },
  get body(): ResponseBody {
    return this._body;
  },
  set body(value: ResponseBody) {
    this._body = value;
    if (value === null || value === undefined) {
      // Koa 3: clearing a JSON-typed body yields the literal "null".
      if (!isEmptyStatus(this._status) && this.type === "application/json") {
        this._body = "null";
        return;
      }
      if (value === null) this._flags |= 2;
      if (!isEmptyStatus(this._status)) this._status = 204;
      // The implicit 204 is an explicit status as far as koa is concerned.
      this._flags |= 1;
      this.remove("Content-Type");
      this.remove("Content-Length");
      this.remove("Transfer-Encoding");
      return;
    }
    if ((this._flags & 1) === 0) this._status = 200;
    const typeUnset = this._headers["content-type"] === undefined;
    if (typeof value === "string") {
      if (typeUnset) {
        // Framework constants: skip set() validation entirely.
        this._headers["content-type"] = startsWithMarkup(value) ? TEXT_HTML : TEXT_PLAIN;
      }
      // Content-Length is left to the runtime (Bun sets it automatically);
      // `length` below computes the same value on demand.
      clearTouchedLength(this);
      return;
    }
    if (value instanceof Uint8Array) {
      if (typeUnset) this._headers["content-type"] = "application/octet-stream";
      clearTouchedLength(this);
      return;
    }
    if (value instanceof ReadableStream) {
      if (typeUnset) this._headers["content-type"] = "application/octet-stream";
      // Koa only clears Content-Length when replacing a previous body.
      if (this._body !== null) this.remove("Content-Length");
      return;
    }
    if (value instanceof Blob) {
      if (typeUnset) this._headers["content-type"] = "application/octet-stream";
      this._headers["content-length"] = String(value.size);
      return;
    }
    if (value instanceof Response) {
      // Koa 3: a web Response can be assigned directly; status and headers win.
      if (value.status >= 200 && value.status <= 599) {
        this._status = value.status;
        this._flags |= 1;
      }
      if (typeUnset) this._headers["content-type"] = "application/octet-stream";
      for (const key of value.headers.keys()) {
        this.set(key, value.headers.get(key) ?? "");
      }
      this._body = value.body;
      return;
    }
    const json = JSON.stringify(value) ?? "null";
    this._body = json;
    if (typeUnset) this._headers["content-type"] = "application/json; charset=utf-8";
    clearTouchedLength(this);
  },
  get length(): number | undefined {
    const raw = this._headers["content-length"];
    if (raw !== undefined) {
      const value = Array.isArray(raw) ? (raw[0] ?? "") : raw;
      return Number.parseInt(value, 10) || 0;
    }
    const body = this._body;
    if (typeof body === "string") return byteLengthOf(body);
    if (body instanceof Uint8Array) return body.byteLength;
    if (body instanceof Blob) return body.size;
    return undefined;
  },
  set length(value: number) {
    // Koa: Content-Length is never written alongside Transfer-Encoding.
    if (this._headers["transfer-encoding"] !== undefined) return;
    const n = Math.trunc(Number(value));
    this._flags |= 8;
    // Hot path: constant field, numeric value — write directly.
    this._headers["content-length"] = String(Number.isNaN(n) ? 0 : n);
  },
  get type(): string {
    const raw = this._headers["content-type"];
    if (raw === undefined) return "";
    const value = Array.isArray(raw) ? (raw.at(-1) ?? "") : raw;
    return value.split(";")[0]?.trim().toLowerCase() ?? "";
  },
  set type(value: string | null | undefined) {
    if (value === null || value === undefined) {
      delete this._headers["content-type"];
      return;
    }
    // Koa: shorthand/extension values expand to full MIME types with charset;
    // unexpandable tokens remove the header (respond falls back to text/plain).
    const full = expandContentType(value);
    if (full === null) {
      delete this._headers["content-type"];
      return;
    }
    validateHeaderValue("content-type", full);
    this._headers["content-type"] = full;
  },
  get etag(): string {
    return this.get("ETag");
  },
  set etag(value: string) {
    if (value.length === 0) {
      this.remove("ETag");
      return;
    }
    this.set("ETag", value.startsWith('"') || value.startsWith("W/") ? value : `"${value}"`);
  },
  get lastModified(): Date | undefined {
    const raw = this.get("Last-Modified");
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
      if (mime !== null) this._headers["content-type"] = mime;
    }
  },
  back(alt?: string): void {
    // Koa: jump back to the Referrer when it is same-origin, else alt.
    const referrer = this.peer.request.get("referrer");
    if (referrer.length > 0) {
      try {
        const url = new URL(referrer, this.peer.request.href);
        if (url.host === this.peer.request.host) {
          this.redirect(referrer);
          return;
        }
      } catch {
        // fall through to alt on unparseable referrers
      }
    }
    this.redirect(alt || "/");
  },
  is(...types: (string | string[])[]): string | false {
    const raw = this._headers["content-type"];
    const contentType = raw === undefined || Array.isArray(raw) ? undefined : raw;
    if (contentType === undefined) return false;
    if (types.length === 0) return normalizeType(contentType);
    // Koa's type-is also accepts a single array of candidate types.
    const list: readonly string[] =
      types.length === 1 && Array.isArray(types[0]) ? types[0] : (types as string[]);
    return typeIs(contentType, list) as string | false;
  },
  redirect(url: string, alt = "/") {
    const raw = url === "back" ? this.peer.request.get("referrer") || alt || "/" : url;
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
    if (!isRedirectStatus(this._status)) {
      this._message = "";
      this._status = 302;
    }
    this._flags |= 1;
    if (this.peer.request.accepts("html") === "html") {
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
      this._headers[name] = value;
      return;
    }
    for (const entry of value) validateHeaderValue(name, entry);
    this._flags |= 4;
    this._headers[name] = [...value];
  },
  append(field: string, value: HeaderValue) {
    const name = field.toLowerCase();
    const next = typeof value === "string" ? [value] : [...value];
    for (const entry of next) validateHeaderValue(name, entry);
    const existing = this._headers[name];
    if (existing === undefined) {
      if (next.length === 1) {
        this._headers[name] = next[0] ?? "";
        return;
      }
      this._flags |= 4;
      this._headers[name] = next;
      return;
    }
    this._flags |= 4;
    const list = Array.isArray(existing) ? [...existing] : [existing];
    list.push(...next);
    this._headers[name] = list;
  },
  remove(field: string) {
    delete this._headers[field.toLowerCase()];
  },
  vary(field: string) {
    if (field.includes(",") || field.includes(" ")) {
      throw new TypeError("Vary field must be a single token");
    }
    const current = this.get("Vary");
    if (current.length === 0) {
      this.set("Vary", field);
      return;
    }
    const tokens = current.split(",").map((token) => token.trim().toLowerCase());
    if (!tokens.includes(field.toLowerCase())) this.append("Vary", field);
  },
  has(field: string): boolean {
    return this._headers[field.toLowerCase()] !== undefined;
  },
  get(field: string): string {
    const raw = this._headers[field.toLowerCase()];
    if (raw === undefined) return "";
    return Array.isArray(raw) ? raw.join(", ") : raw;
  },
  toJSON(): { status: number; message: string; headers: HeaderMap } {
    return { status: this._status, message: this.message, headers: { ...this._headers } };
  },
};

/** Create the per-request response state. The peer is linked right after creation. */
/** Any explicit Content-Length is stale once a body lands (koa recomputes). */
const clearTouchedLength = (state: ResponseState): void => {
  if (state._headers["content-length"] !== undefined) {
    delete state._headers["content-length"];
  }
};

export const createResponse = (proto: object = responseProto): ResponseFacade => {
  const state: ResponseState = Object.create(proto);
  state.peer = undefined as unknown as ResponsePeer;
  state._status = 404;
  state._message = "";
  // Plain object (not null-proto): iterates faster when handed to Response.
  // `__proto__`-style names are rejected by validateHeaderName instead.
  state._headers = {} as HeaderMap;
  state._body = null;
  state._flags = 0;
  return state as unknown as ResponseFacade;
};

/** Attach the request facade after both objects exist (they reference each other). */
export const linkResponsePeer = (response: ResponseFacade, peer: ResponsePeer): void => {
  (response as unknown as ResponseState).peer = peer;
};

export const responseStateOf = (response: ResponseFacade): ResponseState =>
  response as unknown as ResponseState;
