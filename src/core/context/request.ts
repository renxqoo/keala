/**
 * Request-side context API — prototype accessors over the flat context.
 *
 * Everything reads the raw web `Request` plus lazily materialized caches
 * (`urlValue`, `queryValue`, `ipValue`, …). No second object is ever created
 * for the request side.
 */

import { charsetFromContentType, normalizeType } from "../../utils/mime.ts";
import {
  acceptableValues,
  acceptsCharset,
  acceptsEncoding,
  acceptsLanguage,
  acceptsType,
} from "../../negotiation/accepts.ts";
import { typeIs } from "../../negotiation/typeis.ts";
import { getPath, getSearch, parseHostHeader, toURL } from "../../utils/url.ts";
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
  url: string;
  path: string;
  querystring: string;
  search: string;
  /**
   * Targeted query read: first value for `name` (decoded; malformed escapes
   * verbatim), `undefined` when absent. Repeated keys: `queries(name)`.
   */
  query(name: string): string | undefined;
  /** All values for a repeated query key, `[]` when absent. */
  queries(name: string): string[];
  readonly originalUrl: string;
  readonly URL: URL | null;
  readonly headers: Headers;
  readonly runtime: Runtime | undefined;
  header(field: string): string;
  get(field: string): string;
  readonly host: string;
  readonly hostname: string;
  readonly protocol: string;
  readonly secure: boolean;
  readonly ip: string;
  readonly ips: string[];
  readonly subdomains: string[];
  readonly origin: string;
  readonly href: string;
  readonly idempotent: boolean;
  readonly charset: string;
  readonly reqType: string;
  readonly reqLength: number | undefined;
  readonly fresh: boolean;
  readonly stale: boolean;
  is(...types: (string | string[])[]): string | null | false;
  accepts(...types: (string | string[])[]): string | string[] | false;
  acceptsEncodings(...encodings: (string | string[])[]): string | string[] | false;
  acceptsCharsets(...charsets: (string | string[])[]): string | string[] | false;
  acceptsLanguages(...langs: (string | string[])[]): string | string[] | false;
}

/** Strip userinfo (`user:pass@host`) — only the authority is ever trusted. */
const stripUserinfo = (value: string): string => {
  const at = value.lastIndexOf("@");
  return at === -1 ? value : value.slice(at + 1);
};

const IPV4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const IPV6 = /^[0-9a-f]*:[0-9a-f:]*$/i;
const IDEMPOTENT = new Set(["GET", "HEAD", "PUT", "DELETE", "OPTIONS", "TRACE"]);
const NO_CACHE = /(?:^|,)\s*?no-cache\s*?(?:,|$)/;
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

/** Authority (host[:port]) carved out of an absolute URL, "" when not absolute. */
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

/** Split a path-with-search into path / search / hash / querystring. */
const splitUrl = (
  url: string,
): { path: string; search: string; hash: string; querystring: string } => {
  const hashAt = url.indexOf("#");
  const hash = hashAt === -1 ? "" : url.slice(hashAt);
  const body = hashAt === -1 ? url : url.slice(0, hashAt);
  const queryAt = body.indexOf("?");
  if (queryAt === -1) return { path: body, search: "", hash, querystring: "" };
  return {
    path: body.slice(0, queryAt),
    search: body.slice(queryAt),
    hash,
    querystring: body.slice(queryAt + 1),
  };
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
  set url(value: string) {
    this.urlValue = value;
    this.pathValue = null;
    // The parsed query cache is keyed by the URL — a rewrite invalidates it.
  },
  get path(): string {
    return this.pathValue ?? (this.pathValue = getPath(this.url));
  },
  set path(value: string) {
    // Koa: rewriting the pathname keeps the query string AND the parsed query
    // cache (keyed by querystring) — upstream mutations stay visible.
    const url = this.url;
    const q = url.indexOf("?");
    this.urlValue = q === -1 ? value : `${value}${url.slice(q)}`;
    this.pathValue = null;
  },
  get originalUrl(): string {
    const rawUrl = sourceUrl(this.rawRequest);
    return (this.originalUrlValue ??= `${getPath(rawUrl)}${getSearch(rawUrl)}`);
  },
  get querystring(): string {
    // Single scan of the raw request target (or a rewritten url): touching
    // only the query must not materialize the joined path+search string.
    // Equivalent to getSearch(url).slice(1): the first "#" ends the search
    // (even before any "?"), the first "?" starts the query.
    const url = this.urlValue ?? sourceUrl(this.rawRequest);
    let query = -1;
    let limit = -1;
    for (let i = 0; i < url.length; i++) {
      const code = url.charCodeAt(i);
      if (code === 63 /* "?" */) {
        if (query === -1) query = i;
      } else if (code === 35 /* "#" */) {
        limit = i;
        break;
      }
    }
    if (query === -1 || (limit !== -1 && query > limit)) return "";
    return url.slice(query + 1, limit === -1 ? url.length : limit);
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
  set querystring(value: string) {
    const parts = splitUrl(this.url);
    if (value === parts.querystring) return; // koa no-op guard
    this.url = value.length === 0 ? parts.path + parts.hash : `${parts.path}?${value}${parts.hash}`;
  },
  set search(value: string) {
    const parts = splitUrl(this.url);
    const search = value === "" || value === "?" ? "" : value.startsWith("?") ? value : `?${value}`;
    if (search === parts.search) return; // koa: same-value assignment is a no-op
    this.url = parts.path + search + parts.hash;
  },
  get URL(): URL | null {
    return toURL(sourceAbsoluteUrl(this.rawRequest));
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
    return this.get(field);
  },
  get(field: string): string {
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
    // Strip userinfo (user:pass@host) — only the authority is trusted, in
    // BOTH sources: a crafted "evil.com:fake@legitimate.com" in
    // X-Forwarded-Host or Host must never leak into origin/href/back().
    if (this.appSettings.proxy) {
      // Koa: only the first entry of a chained X-Forwarded-Host is trusted.
      const forwarded = stripUserinfo(this.get("x-forwarded-host").split(",")[0]?.trim() ?? "");
      if (forwarded.length > 0) return forwarded;
    }
    const header = stripUserinfo(this.get("host"));
    if (header.length > 0) return header;
    return authorityOf(sourceAbsoluteUrl(this.rawRequest));
  },
  get hostname(): string {
    const host = this.host;
    if (host.length === 0) return "";
    // Koa: bracketed IPv6 hosts resolve through WHATWG URL semantics.
    if (host.charCodeAt(0) === 91 /* "[" */) {
      return toURL(`http://${host}/`)?.hostname ?? "";
    }
    const at = host.lastIndexOf("@");
    const bare = at === -1 ? host : host.slice(at + 1);
    return parseHostHeader(bare).hostname;
  },
  get protocol(): string {
    if (this.appSettings.proxy) {
      const forwarded = this.get("x-forwarded-proto").split(",")[0]?.trim();
      if (forwarded !== undefined && forwarded.length > 0) return forwarded;
    }
    return sourceAbsoluteUrl(this.rawRequest).startsWith("https://") ? "https" : "http";
  },
  get secure(): boolean {
    return this.protocol === "https";
  },
  get ips(): string[] {
    if (!this.appSettings.proxy) return [];
    const raw = this.get(this.appSettings.proxyIpHeader);
    if (raw.length === 0) return [];
    const ips = raw
      .split(",")
      .map((ip) => stripPort(ip.trim()))
      .filter((ip) => ip.length > 0);
    const max = this.appSettings.maxIpsCount;
    return max !== undefined && max > 0 ? ips.slice(-max) : ips;
  },
  get ip(): string {
    const proxied = this.ips[0];
    if (proxied !== undefined) return proxied;
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
  get subdomains(): string[] {
    const hostname = this.hostname;
    if (hostname.length === 0 || IPV4.test(hostname) || IPV6.test(hostname)) return [];
    return hostname.split(".").toReversed().slice(this.appSettings.subdomainOffset);
  },
  get origin(): string {
    return `${this.protocol}://${this.host}`;
  },
  get href(): string {
    // Koa: href is pinned to originalUrl and echoes absolute URLs verbatim.
    const original = this.originalUrl;
    if (original.startsWith("http://") || original.startsWith("https://")) return original;
    const host = this.host;
    return host.length === 0 ? original : `${this.protocol}://${host}${original}`;
  },
  get idempotent(): boolean {
    return IDEMPOTENT.has(sourceMethod(this.rawRequest));
  },
  get charset(): string {
    return charsetFromContentType(sourceHeader(this.rawRequest, "content-type") ?? "");
  },
  get reqType(): string {
    return normalizeType(sourceHeader(this.rawRequest, "content-type") ?? "");
  },
  get reqLength(): number | undefined {
    const raw = sourceHeader(this.rawRequest, "content-length");
    if (raw === null || raw.length === 0) return undefined;
    const parsed = Number.parseInt(raw, 10);
    return Number.isNaN(parsed) ? undefined : parsed;
  },
  get stale(): boolean {
    return !this.fresh;
  },
  get fresh(): boolean {
    const method = sourceMethod(this.rawRequest);
    if (method !== "GET" && method !== "HEAD") return false;
    const status = this.statusValue;
    if ((status >= 200 && status < 300) || status === 304) {
      return isFresh(this);
    }
    return false;
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
  acceptsCharsets(...charsets: (string | string[])[]): string | string[] | false {
    const header = sourceHeader(this.rawRequest, "accept-charset");
    const list = flatten(charsets);
    if (list.length === 0) return acceptableValues(header);
    return acceptsCharset(header, list);
  },
  acceptsLanguages(...langs: (string | string[])[]): string | string[] | false {
    const header = sourceHeader(this.rawRequest, "accept-language");
    const list = flatten(langs);
    if (list.length === 0) return acceptableValues(header);
    return acceptsLanguage(header, list);
  },
};

/**
 * `fresh` per the `fresh` package (Koa semantics): If-None-Match takes
 * precedence over If-Modified-Since, but when both are present BOTH validators
 * must hold; `Cache-Control: no-cache` always forces a full response.
 */
const isFresh = (c: ContextState): boolean => {
  const modifiedSince = sourceHeader(c.rawRequest, "if-modified-since");
  const noneMatch = sourceHeader(c.rawRequest, "if-none-match");

  if (modifiedSince === null && noneMatch === null) return false;

  // Always stale on end-to-end reload requests (RFC 2616 §14.9.4).
  const cacheControl = sourceHeader(c.rawRequest, "cache-control");
  if (cacheControl !== null && NO_CACHE.test(cacheControl)) return false;

  // If-None-Match takes precedence, except for the existence wildcard `*`.
  if (noneMatch !== null && noneMatch !== "*") {
    const etag = c.headersRecord?.["etag"];
    const etagText = etag === undefined ? "" : Array.isArray(etag) ? etag.join(", ") : etag;
    if (etagText.length === 0) return false;
    if (!etagMatches(etagText, noneMatch)) return false;
  }

  // When present, If-Modified-Since must hold as well.
  if (modifiedSince !== null) {
    const lastModified = c.headersRecord?.["last-modified"];
    if (lastModified === undefined) return false;
    const modifiedAt = Date.parse(
      Array.isArray(lastModified) ? (lastModified[0] ?? "") : lastModified,
    );
    const since = Date.parse(modifiedSince);
    if (Number.isNaN(modifiedAt) || !(modifiedAt <= since)) return false;
  }
  return true;
};

const etagMatches = (etag: string, header: string): boolean => {
  if (header.trim() === "*") return true;
  for (const candidate of header.split(",")) {
    let value = candidate.trim();
    if (value.startsWith("W/")) value = value.slice(2);
    let expected = etag;
    if (expected.startsWith("W/")) expected = expected.slice(2);
    if (value === expected) return true;
  }
  return false;
};
