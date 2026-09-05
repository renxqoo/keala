/**
 * Response-side context API — prototype accessors over the flat context.
 *
 * State mode: handlers write `c.status / c.body / c.setHeader(...)`; the
 * finalizer (`core/respond.ts`) converts the accumulated state into a web
 * `Response` exactly once, preferring the bare-Response fast path
 * (hono-consistent content-type behavior: the runtime adds `text/plain` /
 * `application/json`).
 *
 * 0.7 commit contract: once a Response is committed (a sugar return or a
 * handler-returned Response), `c.body`/`c.status` throw — return a new
 * Response to replace it. Header writes stay open on both sides of the
 * commit: pre-commit they stage, post-commit they land directly on the
 * committed Response's headers. `c.redirect` (U3a) is a pure builder — it
 * never throws on commit; the Response it returns wins only when returned.
 */

import type { HeaderValue, ResponseBody } from "../../types.ts";
import { isEmptyStatus, isRedirectStatus } from "../../http/status.ts";
import { expandContentType } from "../../utils/mime.ts";
import { contentDisposition, validateHeaderValue } from "../../utils/text.ts";
import { byteLengthOf, encodeUrlValue } from "../../utils/url.ts";
import { sugarText, sugarJson, sugarHtml } from "./sugar.ts";
import type { ContextState } from "./state.ts";
import type { RequestApi } from "./request.ts";
import {
  appendResponseHeader,
  hasResponseHeader,
  removeResponseHeader,
  responseHeaderValue,
  setResponseHeader,
} from "./headers.ts";

export interface ResponseApi {
  status: number;
  body: ResponseBody;
  get type(): string;
  set type(value: string | null | undefined);
  length: number | undefined;
  etag: string;
  lastModified: Date | undefined;
  /** Committed response (dual-mode return style); undefined in state mode. */
  readonly res: Response | undefined;
  setHeader(field: string | Record<string, HeaderValue>, value?: HeaderValue): void;
  append(field: string, value: HeaderValue): void;
  remove(field: string): void;
  has(field: string): boolean;
  resHeader(field: string): string;
  attachment(
    filename?: string,
    options?: { fallback?: string | false; type?: "attachment" | "inline" | string },
  ): void;
  /**
   * Build a redirect Response with an explicit target and code (default 302,
   * or an already-staged 3xx — read from the pre-commit status slot, so a
   * post-commit build sees the stale staged value, not the committed
   * status; harmless since only a returned build takes effect). Eagerly
   * validated: the code must be a 3xx integer. Location-only body (the 0.7
   * adjudication; koa's "Redirecting to X" text/html body is gone). U3a: a
   * PURE builder — return it (`return c.redirect(url[, code])`); it never
   * mutates the context, so calling it after a commit is harmless (the
   * returned Response wins only if actually returned). A Location staged
   * BEFORE the build overrides the target (§2.3-1 same-name rule — the
   * opposite of the old staged form, where redirect wrote last).
   */
  redirect(url: string, code?: number): Response;
  /** Response sugar (return style) — hono-compatible signatures. */
  text(body: string, status?: number, headers?: Record<string, HeaderValue>): Response;
  json(body: unknown, status?: number, headers?: Record<string, HeaderValue>): Response;
  html(body: string, status?: number, headers?: Record<string, HeaderValue>): Response;
}

const COMMITTED = "response already committed — return a new Response to replace it";

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
 * deliberate absolute redirects.
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
  get status(): number {
    // A committed Response (return style) is the response — post-next
    // middleware must observe its status, not the stale state default.
    return this._res !== undefined ? this._res.status : this.statusValue;
  },
  set status(code: number) {
    if (typeof code !== "number" || !Number.isInteger(code) || code < 200 || code > 599) {
      throw new TypeError(`Invalid status code: ${JSON.stringify(code)}`);
    }
    if (this._res !== undefined) throw new TypeError(COMMITTED);
    this.flags |= 1;
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
  get body(): ResponseBody {
    return this.bodyValue;
  },
  set body(value: ResponseBody) {
    if (this._res !== undefined) throw new TypeError(COMMITTED);
    // BUG-3 (0.6.2 review): a web Response type-checks through the object
    // branch of ResponseBody but the finalizer would silently serialize it
    // as "{}" (status/headers dropped). The 0.7 surface removed this shape
    // (docs/KEALA-NATIVE-API.md §6.2) — fail loud with the guidance instead.
    if (value instanceof Response) {
      throw new TypeError(
        "c.body cannot carry a web Response — return the Response instead; the commit slot owns it",
      );
    }
    this.bodyValue = value;
    if (value === null || value === undefined) {
      // Koa 3: clearing a JSON-typed body yields the literal "null".
      if (!isEmptyStatus(this.statusValue) && this.type === "application/json") {
        this.bodyValue = "null";
        return;
      }
      if (value === null) this.flags |= 2;
      if (!isEmptyStatus(this.statusValue)) {
        // The implicit 204 is an explicit status as far as koa is concerned.
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
      this.setHeader("Content-Length", String(value.size));
      return;
    }
    // Plain object: stored as-is; the finalizer serializes via Response.json.
    clearTouchedLength(this);
  },
  get type(): string {
    // Commit-aware: a returned Response's media type wins post-commit.
    if (this._res !== undefined) {
      const committed = this._res.headers.get("content-type");
      if (committed !== null) return committed.split(";")[0]?.trim().toLowerCase() ?? "";
      return "";
    }
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
    setResponseHeader(this, "Content-Type", full);
  },
  get length(): number | undefined {
    // Commit-aware: the committed Response's declared length is the wire
    // truth once a handler returned one.
    if (this._res !== undefined) {
      const committed = this._res.headers.get("content-length");
      if (committed !== null) return Number.parseInt(committed, 10) || 0;
    }
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
    // Content-Length is never written alongside Transfer-Encoding — the
    // staged record drives the pre-commit check; the committed response's
    // own headers answer post-commit.
    if (
      this.headersRecord?.["transfer-encoding"] === undefined &&
      this._res?.headers.has("transfer-encoding") !== true
    ) {
      const n = Math.trunc(Number(value));
      setResponseHeader(this, "Content-Length", String(Number.isNaN(n) ? 0 : n));
    }
  },
  get etag(): string {
    return this.resHeader("ETag");
  },
  set etag(value: string) {
    if (value.length === 0) {
      this.remove("ETag");
      return;
    }
    this.setHeader("ETag", value.startsWith('"') || value.startsWith("W/") ? value : `"${value}"`);
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
    this.setHeader("Last-Modified", date.toUTCString());
  },
  attachment(
    filename?: string,
    options?: { fallback?: string | false; type?: "attachment" | "inline" | string },
  ) {
    const disposition = normalizeDispositionType(options?.type);
    if (filename === undefined) {
      this.setHeader("Content-Disposition", disposition);
      return;
    }
    const base = basenameOf(filename);
    this.setHeader("Content-Disposition", contentDisposition(base, options?.fallback, disposition));
    // GHSA-c5vw-j4hf-j526: never override an existing Content-Type. The
    // inference goes through expandContentType — the same expansion c.type
    // uses — so extensions resolve with their charset ("html" → text/html;
    // charset=utf-8) and ".bin" maps to application/octet-stream instead of
    // letting the runtime's text/plain leak into a binary download.
    if (base.lastIndexOf(".") !== -1 && !this.has("Content-Type")) {
      const ext = base.slice(base.lastIndexOf(".") + 1);
      const mime = expandContentType(ext);
      if (mime !== null) setResponseHeader(this, "Content-Type", mime);
    }
  },
  redirect(url: string, code?: number): Response {
    if (code !== undefined && (!Number.isInteger(code) || code < 300 || code > 399)) {
      throw new TypeError(`redirect code must be a 3xx integer, got ${JSON.stringify(code)}`);
    }
    // Absolute URLs are normalized through URL; Location is encodeurl'd so
    // non-ASCII targets never break the header.
    let target = url;
    if (/^https?:\/\//i.test(url)) {
      try {
        target = new URL(url).toString();
      } catch {
        target = url;
      }
    } else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
      target = neutralizeForeignAuthority(this.host, url);
    }
    // An explicit code wins; without one, an already-staged 3xx (301/308
    // carry POST-retry semantics a caller deliberately chose) is preserved.
    const status =
      code !== undefined ? code : isRedirectStatus(this.statusValue) ? this.statusValue : 302;
    return new Response(null, { status, headers: { location: encodeUrlValue(target) } });
  },
  setHeader(field: string | Record<string, HeaderValue>, value?: HeaderValue) {
    setResponseHeader(this, field, value);
  },
  append(field: string, value: HeaderValue) {
    appendResponseHeader(this, field, value);
  },
  remove(field: string) {
    removeResponseHeader(this, field);
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
