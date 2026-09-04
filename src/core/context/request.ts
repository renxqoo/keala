/**
 * Request-side context API — prototype accessors over the flat context.
 *
 * Everything reads the raw web `Request` plus lazily materialized caches
 * (`urlValue`, `ipValue`, …). No second object is ever created for the
 * request side. The request is the client's fact (0.7 contract): there are
 * no rewriting setters — write the response, not the request.
 */

import { normalizeType } from "../../utils/mime.ts";
import { acceptableValues, acceptsEncoding, acceptsType } from "../../negotiation/accepts.ts";
import { typeIs } from "../../negotiation/typeis.ts";
import { getPath, getSearch, toURL } from "../../utils/url.ts";
import { findAllQueryValues, findQueryValue } from "../../utils/query.ts";
import type { Runtime } from "../../types.ts";
import type { ContextState } from "./state.ts";
import {
  isNativeRequestSource,
  sourceAbsoluteUrl,
  sourceHeader,
  sourceHeaders,
  sourceMethod,
  sourceRequest,
  sourceSignal,
  sourceUrl,
} from "../request-source.ts";
import { DEADLINE_REASON, FLAG_DEADLINE_FIRED } from "./state.ts";

export interface RequestApi {
  readonly raw: Request;
  /**
   * Cooperative cancellation (R4.6, lazy): aborts when the client
   * disconnects OR the request deadline fires — first one wins, the reason
   * distinguishes them (AbortError vs TimeoutError). Untouched requests
   * never materialize a controller.
   */
  readonly signal: AbortSignal;
  readonly method: string;
  readonly url: string;
  readonly path: string;
  readonly querystring: string;
  readonly search: string;
  /**
   * Targeted query read: first value for `name` (decoded; malformed escapes
   * verbatim), `undefined` when absent. Repeated keys: `queries(name)`.
   */
  query(name: string): string | undefined;
  /** All values for a repeated query key, `[]` when absent. */
  queries(name: string): string[];
  readonly URL: URL | null;
  readonly headers: Headers;
  readonly runtime: Runtime | undefined;
  header(field: string): string;
  readonly host: string;
  readonly protocol: string;
  readonly secure: boolean;
  readonly ip: string;
  readonly origin: string;
  readonly href: string;
  readonly idempotent: boolean;
  readonly reqLength: number | undefined;
  is(...types: (string | string[])[]): string | null | false;
  accepts(...types: (string | string[])[]): string | string[] | false;
  acceptsEncodings(...encodings: (string | string[])[]): string | string[] | false;
}

/** Strip userinfo (`user:pass@host`) — only the authority is ever trusted. */
const stripUserinfo = (value: string): string => {
  const at = value.lastIndexOf("@");
  return at === -1 ? value : value.slice(at + 1);
};

const IDEMPOTENT = new Set(["GET", "HEAD", "PUT", "DELETE", "OPTIONS", "TRACE"]);
const IPV4_WITH_PORT = /^\d{1,3}(?:\.\d{1,3}){3}:\d+$/;
const BRACKETED_WITH_PORT = /^\[[0-9a-f:]+\]:\d+$/i;

/**
 * Strip an explicit port from a forwarded-for entry ("23.243.1.1:38242" —
 * Azure-style proxies). Only the two unambiguous shapes are touched: a
 * dotted quad with a port and a bracketed IPv6 with a port. A bare
 * (unbracketed) IPv6 literal is left alone — its colons ARE the address.
 */
const stripPort = (entry: string): string => {
  if (IPV4_WITH_PORT.test(entry)) return entry.slice(0, entry.lastIndexOf(":"));
  if (BRACKETED_WITH_PORT.test(entry)) return entry.slice(0, entry.indexOf("]") + 1);
  return entry;
};

const flatten = (args: readonly (string | string[])[]): string[] => {
  const out: string[] = [];
  for (const arg of args) {
    if (Array.isArray(arg)) out.push(...arg);
    else out.push(arg);
  }
  return out;
};

/**
 * Authority (host[:port]) carved out of an absolute URL, "" when not absolute.
 *
 * The trusted-URL twin of `urlAuthority` (core/trusted-hosts.ts) — that one
 * parses possibly-hostile request targets and terminates the authority at
 * `[/?#]`; see its comment before unifying (review DEAD-27).
 */
const authorityOf = (url: string): string => {
  const scheme = url.indexOf("://");
  if (scheme === -1) return "";
  let rest = url.slice(scheme + 3);
  const slash = rest.indexOf("/");
  if (slash !== -1) rest = rest.slice(0, slash);
  const at = rest.lastIndexOf("@");
  if (at !== -1) rest = rest.slice(at + 1);
  return rest;
};

/** Host authority with userinfo stripped (proxy-aware, header-first). */
const computeHost = (c: ContextState & { header(field: string): string }): string => {
  // Strip userinfo (user:pass@host) — only the authority is trusted, in
  // BOTH sources: a crafted "evil.com:fake@legitimate.com" in
  // X-Forwarded-Host or Host must never leak into origin/href.
  if (c.appSettings.proxy) {
    // Koa: only the first entry of a chained X-Forwarded-Host is trusted.
    const forwarded = stripUserinfo(c.header("x-forwarded-host").split(",")[0]?.trim() ?? "");
    if (forwarded.length > 0) return forwarded;
  }
  const host = stripUserinfo(c.header("host"));
  if (host.length > 0) return host;
  return authorityOf(sourceAbsoluteUrl(c.rawRequest));
};

export const requestApi: ThisType<ContextState & RequestApi> & RequestApi = {
  get raw(): Request {
    return sourceRequest(this.rawRequest);
  },
  get signal(): AbortSignal {
    const existing = this.abortValue;
    if (existing !== undefined) return existing.signal;
    // Lazy composition: the client's disconnect (a fetch Request aborts
    // natively under Bun; the Node adapter drives the native source's lazy
    // channel) plus the request deadline. Listeners die with the request.
    const controller = new AbortController();
    this.abortValue = controller;
    const raw = sourceSignal(this.rawRequest);
    if (raw.aborted) controller.abort(raw.reason);
    else raw.addEventListener("abort", () => controller.abort(raw.reason), { once: true });
    // A deadline that fired before first read still yields an aborted signal.
    if ((this.flags & FLAG_DEADLINE_FIRED) !== 0) controller.abort(DEADLINE_REASON);
    return controller.signal;
  },
  get method(): string {
    return sourceMethod(this.rawRequest);
  },
  get url(): string {
    const rawUrl = sourceUrl(this.rawRequest);
    return (this.urlValue ??= `${getPath(rawUrl)}${getSearch(rawUrl)}`);
  },
  get path(): string {
    return this.pathValue ?? (this.pathValue = getPath(this.url));
  },
  get querystring(): string {
    // Native scans of the raw request target: touching only the query must
    // not materialize the joined path+search string. Equivalent to
    // getSearch(url).slice(1): the first "#" ends the search (even before
    // any "?"), the first "?" starts the query — a fragment-embedded "?" is
    // therefore NOT a query start. indexOf runs in native code, several
    // times faster than a per-charCode loop. Cached in a slot: the targeted
    // readers call this per key. The request is immutable (0.7), so the
    // memo can never go stale.
    const cached = this.querystringValue;
    if (cached !== null) return cached;
    const url = this.urlValue ?? sourceUrl(this.rawRequest);
    const query = url.indexOf("?");
    if (query === -1) return (this.querystringValue = "");
    const hash = url.indexOf("#");
    if (hash !== -1 && hash < query) return (this.querystringValue = "");
    return (this.querystringValue = url.slice(query + 1, hash === -1 ? url.length : hash));
  },
  get search(): string {
    const qs = this.querystring;
    return qs.length === 0 ? "" : `?${qs}`;
  },
  /**
   * Targeted query read (user adjudication 2026-09-04: the koa-style full
   * Map is gone — building it cost ~111ns/request while a boundary-matched
   * scan costs ~2ns; the property form `c.query.name` cannot be made fast
   * because plain-object property access requires the object to already
   * exist fully parsed). Returns the FIRST value for `name`, decoded
   * (`+` → space, `%XX`; malformed escapes pass through verbatim — security
   * contract #5). `undefined` when absent; a bare trailing key reads as "".
   * Repeated keys: `queries(name)`. Keys match in raw or canonical
   * encodeURIComponent form — non-canonical encoding of unreserved chars
   * (`%5F` for `_`) is not decoded on the match path.
   */
  query(name: string): string | undefined {
    return findQueryValue(this.querystring, name);
  },
  /**
   * All values for a repeated query key (`?a=1&a=2` → `["1","2"]`), `[]`
   * when absent. Same decoding and boundary semantics as `query(name)`.
   */
  queries(name: string): string[] {
    return findAllQueryValues(this.querystring, name);
  },
  get URL(): URL | null {
    // Memoized: a fresh WHATWG parse (40ns + object) per access before.
    const memo = this.urlObjectValue;
    if (memo !== null) return memo as URL;
    return (this.urlObjectValue = toURL(sourceAbsoluteUrl(this.rawRequest))) as URL | null;
  },
  get headers(): Headers {
    return sourceHeaders(this.rawRequest);
  },
  get runtime(): Runtime | undefined {
    return (
      this.runtimeValue ??
      (isNativeRequestSource(this.rawRequest) ? (this.rawRequest as unknown as Runtime) : undefined)
    );
  },
  header(field: string): string {
    const name = field.toLowerCase();
    // Koa: "Referrer" and "Referer" are interchangeable; fetch Headers only
    // store the latter, so both lookups must fall through to it.
    if (name === "referer" || name === "referrer") {
      return (
        sourceHeader(this.rawRequest, "referrer") ?? sourceHeader(this.rawRequest, "referer") ?? ""
      );
    }
    return sourceHeader(this.rawRequest, name) ?? "";
  },
  get host(): string {
    // Memoized (45ns parse per access before; CORS-style readers call twice).
    const memo = this.hostValue;
    if (memo !== null) return memo;
    return (this.hostValue = computeHost(this));
  },
  get protocol(): string {
    if (this.appSettings.proxy) {
      const forwarded = this.header("x-forwarded-proto").split(",")[0]?.trim();
      if (forwarded !== undefined && forwarded.length > 0) return forwarded;
    }
    return sourceAbsoluteUrl(this.rawRequest).startsWith("https://") ? "https" : "http";
  },
  get secure(): boolean {
    return this.protocol === "https";
  },
  get ip(): string {
    // The trusted-forward chain's first entry (after the maxIpsCount
    // truncation the old `ips` accessor applied — `c.ips` itself is gone,
    // but `c.ip` keeps its exact resolution order).
    if (this.appSettings.proxy) {
      const raw = this.header(this.appSettings.proxyIpHeader);
      if (raw.length > 0) {
        const chain = raw
          .split(",")
          .map((entry) => stripPort(entry.trim()))
          .filter((entry) => entry.length > 0);
        const max = this.appSettings.maxIpsCount;
        const first = (max !== undefined && max > 0 ? chain.slice(-max) : chain)[0];
        if (first !== undefined) return first;
      }
    }
    // Memo: null = unresolved, "" = resolved to no address. The resolver runs
    // exactly once either way.
    if (this.ipValue === null) {
      const runtime = this.runtime;
      const remote = runtime?.remote;
      if (typeof remote === "string") this.ipValue = remote;
      else if (typeof remote === "function") this.ipValue = remote() ?? "";
      else {
        const server = runtime?.server as
          | { requestIP(request: Request): { readonly address: string } | null }
          | undefined;
        this.ipValue = server?.requestIP(sourceRequest(this.rawRequest))?.address ?? "";
      }
    }
    return this.ipValue;
  },
  get origin(): string {
    return `${this.protocol}://${this.host}`;
  },
  get href(): string {
    // An absolute-form request target (proxy-style) echoes verbatim.
    const url = this.url;
    if (url.startsWith("http://") || url.startsWith("https://")) return url;
    const host = this.host;
    return host.length === 0 ? url : `${this.protocol}://${host}${url}`;
  },
  get idempotent(): boolean {
    return IDEMPOTENT.has(sourceMethod(this.rawRequest));
  },
  get reqLength(): number | undefined {
    const raw = sourceHeader(this.rawRequest, "content-length");
    if (raw === null || raw.length === 0) return undefined;
    const parsed = Number.parseInt(raw, 10);
    return Number.isNaN(parsed) ? undefined : parsed;
  },
  is(...types: (string | string[])[]): string | null | false {
    const contentType = sourceHeader(this.rawRequest, "content-type");
    if (types.length === 0) {
      return contentType === null ? "" : normalizeType(contentType);
    }
    const list: readonly string[] =
      types.length === 1 && Array.isArray(types[0]) ? types[0] : (types as string[]);
    return typeIs(contentType, list);
  },
  accepts(...types: (string | string[])[]): string | string[] | false {
    const header = sourceHeader(this.rawRequest, "accept");
    const list = flatten(types);
    if (list.length === 0) return acceptableValues(header);
    return acceptsType(header, list);
  },
  acceptsEncodings(...encodings: (string | string[])[]): string | string[] | false {
    const header = sourceHeader(this.rawRequest, "accept-encoding");
    const list = flatten(encodings);
    if (list.length === 0) return acceptableValues(header);
    return acceptsEncoding(header, list);
  },
};
