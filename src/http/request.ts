/**
 * Request facade over the standard web `Request`.
 *
 * Koa-compatible surface (`ctx.request.*`): URL accessors, headers, IP/proxy
 * helpers, content negotiation and freshness. All getters live on a shared
 * null-prototype object so per-request cost is a single flat state object —
 * no closures, no classes.
 */

import type { QueryMap } from "../utils/query.ts";
import { parseQuery } from "../utils/query.ts";
import { charsetFromContentType, normalizeType } from "../utils/mime.ts";
import {
  acceptableValues,
  acceptsCharset,
  acceptsEncoding,
  acceptsLanguage,
  acceptsType,
} from "../negotiation/accepts.ts";
import { typeIs } from "../negotiation/typeis.ts";
import { getPath, getSearch, parseHostHeader, toURL } from "../utils/url.ts";

/** Where the client IP comes from: a literal, a thunk, or the Bun server handle. */
export type RemoteSource =
  | string
  | (() => string | undefined)
  | { requestIP(request: Request): { readonly address: string } | null }
  | undefined;

export interface RequestAppSettings {
  readonly proxy: boolean;
  readonly proxyIpHeader: string;
  readonly maxIpsCount?: number;
  readonly subdomainOffset: number;
}

export interface RequestPeer {
  readonly status: number;
  readonly etag: string;
  readonly lastModified: Date | string | undefined;
}

const IPV4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const IPV6 = /^[0-9a-f]*:[0-9a-f:]*$/i;
const IDEMPOTENT = new Set(["GET", "HEAD", "PUT", "DELETE", "OPTIONS", "TRACE"]);

/** Internal state carried by each request facade instance. */
export interface RequestState {
  rawRequest: Request;
  peer: RequestPeer;
  settings: RequestAppSettings;
  remote: RemoteSource;
  remoteValue: string | null;
  _url: string | null;
  _query: QueryMap | null;
  originalUrlValue: string | null;
}

export interface RequestFacade {
  readonly raw: Request;
  readonly originalUrl: string;
  readonly header: Headers;
  readonly headers: Headers;
  readonly method: string;
  url: string;
  path: string;
  querystring: string;
  search: string;
  readonly URL: URL | null;
  query: QueryMap;
  readonly host: string;
  readonly hostname: string;
  readonly protocol: string;
  readonly secure: boolean;
  readonly ip: string;
  readonly ips: string[];
  readonly subdomains: string[];
  readonly origin: string;
  readonly href: string;
  readonly fresh: boolean;
  readonly stale: boolean;
  readonly idempotent: boolean;
  readonly charset: string;
  readonly length: number | undefined;
  readonly type: string;
  is(...types: (string | string[])[]): string | null | false;
  accepts(...types: (string | string[])[]): string | string[] | false;
  acceptsEncodings(...encodings: (string | string[])[]): string | string[] | false;
  acceptsCharsets(...charsets: (string | string[])[]): string | string[] | false;
  acceptsLanguages(...langs: (string | string[])[]): string | string[] | false;
  get(field: string): string;
  toJSON(): { method: string; url: string; header: Record<string, string> };
}

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

/** URLSearchParams-compatible serialization (Koa 3 search-params semantics). */
const stringifyQuery = (value: QueryMap): string => {
  const params = new URLSearchParams();
  for (const key of Object.keys(value)) {
    const entry = value[key];
    if (Array.isArray(entry)) {
      for (const item of entry) {
        params.append(key, serializeQueryValue(item));
      }
    } else {
      params.append(key, serializeQueryValue(entry));
    }
  }
  return params.toString();
};

// Koa search-params: only strings and numbers serialize; anything else is "".
const serializeQueryValue = (item: unknown): string => {
  if (typeof item === "number" && Number.isFinite(item)) return String(item);
  return typeof item === "string" ? item : "";
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

const querystringOf = (url: string): string => {
  const hash = url.indexOf("#");
  const limit = hash === -1 ? url.length : hash;
  const q = url.indexOf("?");
  if (q === -1 || q > limit) return "";
  return url.slice(q + 1, limit);
};

export const requestProto: ThisType<RequestState & RequestFacade> & RequestFacade = {
  get raw(): Request {
    return this.rawRequest;
  },
  get header(): Headers {
    return this.rawRequest.headers;
  },
  get headers(): Headers {
    return this.rawRequest.headers;
  },
  get method(): string {
    return this.rawRequest.method;
  },
  get url(): string {
    return (this._url ??= `${getPath(this.rawRequest.url)}${getSearch(this.rawRequest.url)}`);
  },
  set url(value: string) {
    this._url = value;
    // The parsed query cache is keyed by the URL — a rewrite invalidates it.
    this._query = null;
  },
  get originalUrl(): string {
    return (this.originalUrlValue ??= `${getPath(this.rawRequest.url)}${getSearch(this.rawRequest.url)}`);
  },
  get path(): string {
    // Avoid materializing path+search when only the path is needed (routing).
    return this._url !== null ? getPath(this._url) : getPath(this.rawRequest.url);
  },
  set path(value: string) {
    // Koa: rewriting the pathname keeps the query string (and cache) intact.
    const url = this.url;
    const q = url.indexOf("?");
    this._url = q === -1 ? value : `${value}${url.slice(q)}`;
  },
  get querystring(): string {
    return querystringOf(this.url);
  },
  get search(): string {
    const qs = this.querystring;
    return qs.length === 0 ? "" : `?${qs}`;
  },
  get query(): QueryMap {
    return (this._query ??= parseQuery(this.querystring));
  },
  set search(value: string) {
    const parts = splitUrl(this.url);
    const search = value === "" || value === "?" ? "" : value.startsWith("?") ? value : `?${value}`;
    if (search === parts.search) return; // koa: same-value assignment is a no-op
    this._url = parts.path + search + parts.hash;
    this._query = null;
  },
  set querystring(value: string) {
    const parts = splitUrl(this.url);
    if (value === parts.querystring) return; // koa no-op guard
    this._url =
      value.length === 0 ? parts.path + parts.hash : `${parts.path}?${value}${parts.hash}`;
    this._query = null;
  },
  get URL(): URL | null {
    return toURL(this.rawRequest.url);
  },
  set query(value: QueryMap) {
    // Koa 3: assigning an object rewrites the query string on the request.
    this._query = value;
    const url = this.url;
    const base = url.slice(0, url.indexOf("?") === -1 ? url.length : url.indexOf("?"));
    const serialized = stringifyQuery(value);
    this._url = serialized.length === 0 ? base : `${base}?${serialized}`;
  },
  get host(): string {
    const settings = this.settings;
    if (settings.proxy) {
      // Koa: only the first entry of a chained X-Forwarded-Host is trusted.
      const forwarded = this.get("x-forwarded-host").split(",")[0]?.trim() ?? "";
      if (forwarded.length > 0) return forwarded;
    }
    const header = this.get("host");
    if (header.length > 0) {
      // Strip userinfo (user:pass@host) — Koa trusts only the authority.
      const at = header.lastIndexOf("@");
      return at === -1 ? header : header.slice(at + 1);
    }
    return authorityOf(this.rawRequest.url);
  },
  get hostname(): string {
    const host = this.host;
    if (host.length === 0) return "";
    // Koa: bracketed IPv6 hosts resolve through WHATWG URL semantics —
    // canonical compression applies, invalid literals yield "".
    if (host.charCodeAt(0) === 91 /* "[" */) {
      return toURL(`http://${host}/`)?.hostname ?? "";
    }
    const at = host.lastIndexOf("@");
    const bare = at === -1 ? host : host.slice(at + 1);
    return parseHostHeader(bare).hostname;
  },
  get protocol(): string {
    if (this.settings.proxy) {
      const forwarded = this.get("x-forwarded-proto").split(",")[0]?.trim();
      if (forwarded !== undefined && forwarded.length > 0) return forwarded;
    }
    return this.rawRequest.url.startsWith("https://") ? "https" : "http";
  },
  get secure(): boolean {
    return this.protocol === "https";
  },
  get ips(): string[] {
    if (!this.settings.proxy) return [];
    const raw = this.get(this.settings.proxyIpHeader);
    if (raw.length === 0) return [];
    const ips = raw
      .split(",")
      .map((ip) => ip.trim())
      .filter((ip) => ip.length > 0);
    const max = this.settings.maxIpsCount;
    return max !== undefined && max > 0 ? ips.slice(-max) : ips;
  },
  get ip(): string {
    const proxied = this.ips[0];
    if (proxied !== undefined) return proxied;
    // Memo: null = unresolved, "" = resolved to no address. The thunk must
    // run exactly once either way (koa parity for the lazy ip getter).
    if (this.remoteValue === null) {
      const remote = this.remote;
      if (typeof remote === "string") this.remoteValue = remote;
      else if (typeof remote === "function") this.remoteValue = remote() ?? "";
      else if (typeof remote === "object" && remote !== null) {
        this.remoteValue = remote.requestIP(this.rawRequest)?.address ?? "";
      } else {
        this.remoteValue = "";
      }
    }
    return this.remoteValue;
  },
  get subdomains(): string[] {
    const hostname = this.hostname;
    if (hostname.length === 0 || IPV4.test(hostname) || IPV6.test(hostname)) return [];
    return hostname.split(".").toReversed().slice(this.settings.subdomainOffset);
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
    return IDEMPOTENT.has(this.rawRequest.method);
  },
  get length(): number | undefined {
    const raw = this.rawRequest.headers.get("content-length");
    if (raw === null || raw.length === 0) return undefined;
    const parsed = Number.parseInt(raw, 10);
    return Number.isNaN(parsed) ? undefined : parsed;
  },
  get type(): string {
    return normalizeType(this.rawRequest.headers.get("content-type") ?? "");
  },
  get charset(): string {
    return charsetFromContentType(this.rawRequest.headers.get("content-type") ?? "");
  },
  get stale(): boolean {
    return !this.fresh;
  },
  get fresh(): boolean {
    const method = this.rawRequest.method;
    if (method !== "GET" && method !== "HEAD") return false;
    const status = this.peer.status;
    if ((status >= 200 && status < 300) || status === 304) {
      return isFresh(this);
    }
    return false;
  },
  get(field: string): string {
    const name = field.toLowerCase();
    // Koa: "Referrer" and "Referer" are interchangeable; fetch Headers only
    // store the latter, so both lookups must fall through to it.
    if (name === "referer" || name === "referrer") {
      return (
        this.rawRequest.headers.get("referrer") ?? this.rawRequest.headers.get("referer") ?? ""
      );
    }
    return this.rawRequest.headers.get(name) ?? "";
  },
  toJSON(): { method: string; url: string; header: Record<string, string> } {
    const header: Record<string, string> = {};
    for (const [key, value] of this.rawRequest.headers.entries()) header[key] = value;
    return { method: this.rawRequest.method, url: this.url, header };
  },
  is(...types: (string | string[])[]): string | null | false {
    const contentType = this.rawRequest.headers.get("content-type");
    if (types.length === 0) {
      return contentType === null ? "" : normalizeType(contentType);
    }
    // Koa's type-is also accepts a single array of candidate types.
    const list: readonly string[] =
      types.length === 1 && Array.isArray(types[0]) ? types[0] : (types as string[]);
    return typeIs(contentType, list);
  },
  accepts(...types: (string | string[])[]): string | string[] | false {
    const header = this.rawRequest.headers.get("accept");
    const list = flatten(types);
    if (list.length === 0) return acceptableValues(header);
    return acceptsType(header, list);
  },
  acceptsEncodings(...encodings: (string | string[])[]): string | string[] | false {
    const header = this.rawRequest.headers.get("accept-encoding");
    const list = flatten(encodings);
    if (list.length === 0) return acceptableValues(header);
    return acceptsEncoding(header, list);
  },
  acceptsCharsets(...charsets: (string | string[])[]): string | string[] | false {
    const header = this.rawRequest.headers.get("accept-charset");
    const list = flatten(charsets);
    if (list.length === 0) return acceptableValues(header);
    return acceptsCharset(header, list);
  },
  acceptsLanguages(...langs: (string | string[])[]): string | string[] | false {
    const header = this.rawRequest.headers.get("accept-language");
    const list = flatten(langs);
    if (list.length === 0) return acceptableValues(header);
    return acceptsLanguage(header, list);
  },
};

/**
 * `fresh` per the `fresh` package (Koa's exact semantics): If-None-Match takes
 * precedence over If-Modified-Since, but when both are present BOTH validators
 * must hold; `Cache-Control: no-cache` always forces a full response.
 */
const NO_CACHE = /(?:^|,)\s*?no-cache\s*?(?:,|$)/;

const isFresh = (state: RequestState): boolean => {
  const headers = state.rawRequest.headers;
  const modifiedSince = headers.get("if-modified-since");
  const noneMatch = headers.get("if-none-match");

  // Unconditional request — nothing to validate against.
  if (modifiedSince === null && noneMatch === null) return false;

  // Always stale on end-to-end reload requests (RFC 2616 §14.9.4).
  const cacheControl = headers.get("cache-control");
  if (cacheControl !== null && NO_CACHE.test(cacheControl)) return false;

  // If-None-Match takes precedence, except for the existence wildcard `*`.
  if (noneMatch !== null && noneMatch !== "*") {
    const etag = state.peer.etag;
    if (etag.length === 0) return false;
    if (!etagMatches(etag, noneMatch)) return false;
  }

  // When present, If-Modified-Since must hold as well.
  if (modifiedSince !== null) {
    const lastModified = state.peer.lastModified;
    if (lastModified === undefined) return false;
    const modifiedAt =
      lastModified instanceof Date ? lastModified.getTime() : Date.parse(lastModified);
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

/** Create the per-request facade. One flat allocation, prototype shared. */
export const createRequest = (
  raw: Request,
  peer: RequestPeer,
  settings: RequestAppSettings,
  remote: RemoteSource,
  proto: object = requestProto,
): RequestFacade => {
  const state: RequestState = Object.create(proto);
  state.rawRequest = raw;
  state.peer = peer;
  state.settings = settings;
  state.remote = remote;
  state.remoteValue = null;
  state._url = null;
  state._query = null;
  state.originalUrlValue = null;
  return state as unknown as RequestFacade;
};
