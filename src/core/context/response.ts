/**
 * Response-side context API — prototype accessors over the flat context.
 *
 * State mode: handlers write `c.status / c.body / c.set(...)`; the finalizer
 * (`core/respond.ts`) converts the accumulated state into a web `Response`
 * exactly once, preferring the bare-Response fast path (hono-consistent
 * content-type behavior: the runtime adds `text/plain` / `application/json`).
 */

import type { HeaderValue, ResponseBody } from "../../types.ts";
import { isEmptyStatus, isRedirectStatus, statusMessage } from "../../http/status.ts";
import { expandContentType } from "../../utils/mime.ts";
import { contentDisposition, escapeHtml, validateHeaderValue } from "../../utils/text.ts";
import { byteLengthOf, encodeUrlValue } from "../../utils/url.ts";
import { sugarText, sugarJson, sugarHtml, TEXT_PLAIN, TEXT_HTML } from "./sugar.ts";
import type { ContextState } from "./state.ts";
import type { RequestApi } from "./request.ts";
import {
  appendResponseHeader,
  hasResponseHeader,
  removeResponseHeader,
  responseHeaderValue,
  setResponseHeader,
  stagedHeadersOf,
  varyResponseHeader,
} from "./headers.ts";

export interface ResponseApi {
  status: number;
  message: string;
  body: ResponseBody;
  get type(): string;
  set type(value: string | null | undefined);
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

/** Any explicit Content-Length is stale once a body lands (koa recomputes). */
const clearTouchedLength = (c: ContextState): void => {
  if (c.headersRecord?.["content-length"] !== undefined) {
    delete c.headersRecord["content-length"];
  }
};

/**
 * A relative-looking target every WHATWG client resolves to a FOREIGN
 * authority is an open redirect (`//evil.com`, `https:/evil.com` — the same
 * family as the `/\evil.com` form PIPE-1 closed). Resolve against the request
 * origin; when it lands on another host, encode the leading bytes (the exact
 * treatment `\` already gets) so the Location stays a same-origin path.
 * Explicit `scheme://` targets never reach here — those are the developer's
 * deliberate absolute redirects (koa parity).
 */
const neutralizeForeignAuthority = (host: string, raw: string): string => {
  if (host.length === 0) return raw;
  let resolved: URL;
  try {
    resolved = new URL(raw, `http://${host}/`);
  } catch {
    return raw;
  }
  if (resolved.host.length === 0 || resolved.host === host) return raw;
  if (raw.startsWith("//")) return `/%2F${raw.slice(2)}`;
  // Special-scheme slash forms ("https:/host"): WHATWG skips the missing
  // slashes straight into the authority — encode the scheme colon and its
  // slashes so the whole string becomes a relative path.
  return raw.replace(/^[a-z][a-z0-9+.-]*:\/*/i, (head) =>
    head.replaceAll(":", "%3A").replaceAll("/", "%2F"),
  );
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
    // A status write AFTER a Response committed is a rewrite of that response
    // — flag it so the finalizer rebuilds with THIS status (32) instead of
    // returning the commit verbatim. Only a POST-commit write carries that
    // authority: pre-commit staging was superseded by the commit itself.
    if (this._res !== undefined) this.flags |= 16 | 32;
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
    // Control characters beyond CR/LF (NUL, BEL, …) do not throw here — they
    // make the message INELIGIBLE as statusText instead (the finalizer falls
    // back to the standard reason phrase), the same way non-latin-1 messages
    // already behave. Throwing would cost the entire response over a phrase.
    this.messageValue = value;
    // A message write AFTER a Response committed rewrites that response's
    // reason phrase — flag the rebuild (16) and mark messageValue as the
    // winning statusText (64). It must NOT hand the stale pre-commit status
    // to the rebuild; only flag 32 does that.
    if (this._res !== undefined) this.flags |= 16 | 64;
  },
  get body(): ResponseBody {
    return this.bodyValue;
  },
  set body(value: ResponseBody) {
    this.bodyValue = value;
    // A body write AFTER a Response committed replaces that response's body
    // on the rule-4 rebuild — the user's latest intent (post-commit writes
    // were silently dropped before, shipping stale bodies).
    if (this._res !== undefined) this.flags |= 16 | 128;
    if (value === null || value === undefined) {
      // Koa 3: clearing a JSON-typed body yields the literal "null".
      if (!isEmptyStatus(this.statusValue) && this.type === "application/json") {
        this.bodyValue = "null";
        return;
      }
      if (value === null) this.flags |= 2;
      if (!isEmptyStatus(this.statusValue)) {
        // The implicit 204 is an explicit status as far as koa is concerned —
        // and a POST-commit reset must rewrite the committed status on the
        // rule-4 rebuild (flag 32), not silently strand a bodied 200.
        if (this._res !== undefined) this.flags |= 16 | 32;
        this.statusValue = 204;
      }
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
      stagedHeadersOf(this)["content-length"] = String(value.size);
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
      this.remove("Content-Type");
      return;
    }
    // Koa: shorthand/extension values expand to full MIME types with charset;
    // unexpandable tokens remove the header (the finalizer falls back to the
    // runtime default).
    const full = expandContentType(value);
    if (full === null) {
      this.remove("Content-Type");
      return;
    }
    validateHeaderValue("content-type", full);
    stagedHeadersOf(this)["content-type"] = full;
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
    stagedHeadersOf(this)["content-length"] = String(Number.isNaN(n) ? 0 : n);
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
    // GHSA-c5vw-j4hf-j526: never override an existing Content-Type. The
    // inference goes through expandContentType — the same expansion c.type
    // uses — so extensions resolve with their charset ("html" → text/html;
    // charset=utf-8) and ".bin" maps to application/octet-stream instead of
    // letting the runtime's text/plain leak into a binary download.
    if (base.lastIndexOf(".") !== -1 && !this.has("Content-Type")) {
      const ext = base.slice(base.lastIndexOf(".") + 1);
      const mime = expandContentType(ext);
      if (mime !== null) stagedHeadersOf(this)["content-type"] = mime;
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
    if (/^https?:\/\//i.test(raw)) {
      try {
        target = new URL(raw).toString();
      } catch {
        target = raw;
      }
    } else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
      target = neutralizeForeignAuthority(this.host, raw);
    }
    this.set("Location", encodeUrlValue(target));
    // Through the status setter: a post-commit redirect must rewrite the
    // committed Response's status too (flag 32) — the direct statusValue
    // writes used here were invisible to the rule-4 rebuild, shipping
    // Location on a 200 with the old body. The gate reads the COMMIT-AWARE
    // status (`c.status`), so an already-committed 301/308 is preserved
    // instead of being demoted to 302 (308 carries POST-retry semantics).
    if (!isRedirectStatus(this.status)) {
      this.messageValue = "";
      this.status = 302;
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
    setResponseHeader(this, field, value);
  },
  append(field: string, value: HeaderValue) {
    appendResponseHeader(this, field, value);
  },
  remove(field: string) {
    removeResponseHeader(this, field);
  },
  vary(field: string) {
    varyResponseHeader(this, field);
  },
  has(field: string): boolean {
    return hasResponseHeader(this, field);
  },
  resHeader(field: string): string {
    return responseHeaderValue(this, field);
  },
  // The sugar constructors live in core/context/sugar.ts (staged-header
  // consumption, empty-status contract, statusText forwarding).
  text(body, status, headers) {
    return sugarText(this, body, status, headers);
  },
  json(body, status, headers) {
    return sugarJson(this, body, status, headers);
  },
  html(body, status, headers) {
    return sugarHtml(this, body, status, headers);
  },
};
