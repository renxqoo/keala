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

import type { HeaderValue } from "../../types.ts";
import { isRedirectStatus } from "../../http/status.ts";
import { encodeUrlValue } from "../../utils/url.ts";
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
  /**
   * Read-only status (U3c: the write path is gone). Returns the committed
   * Response's status once one exists; before that, the synthesized-answer
   * observation slot (405/501/OPTIONS) or the 404 default. The way to set a
   * status is the sugar's second parameter or `new Response(..., { status })`.
   */
  readonly status: number;
  setHeader(field: string | Record<string, HeaderValue>, value?: HeaderValue): void;
  append(field: string, value: HeaderValue): void;
  remove(field: string): void;
  has(field: string): boolean;
  resHeader(field: string): string;
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
  get status(): number {
    // A committed Response (return style) is the response — post-next
    // middleware must observe its status, not the stale state default.
    return this._res !== undefined ? this._res.status : this.statusValue;
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
