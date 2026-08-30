/**
 * Request-side context API — prototype accessors over the flat context.
 *
 * Everything reads the raw web `Request` plus lazily materialized caches
 * (`urlValue`, `queryValue`, `ipValue`, …). No second object is ever created
 * for the request side.
 */

import type { QueryMap } from "../../utils/query.ts";
import { parseQuery } from "../../utils/query.ts";
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
import type { Runtime } from "../../types.ts";
import type { ContextState } from "./state.ts";

export interface RequestApi {
  readonly raw: Request;
  readonly method: string;
  url: string;
  path: string;
  querystring: string;
  search: string;
  query: QueryMap;
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

const IPV4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const IPV6 = /^[0-9a-f]*:[0-9a-f:]*$/i;
const IDEMPOTENT = new Set(["GET", "HEAD", "PUT", "DELETE", "OPTIONS", "TRACE"]);
const NO_CACHE = /(?:^|,)\s*?no-cache\s*?(?:,|$)/;

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

// Koa search-params: only strings and numbers serialize; anything else is "".
const stringifyQuery = (value: QueryMap): string => {
  const params = new URLSearchParams();
  const push = (key: string, item: unknown): void => {
    if (typeof item === "number" && Number.isFinite(item)) params.append(key, String(item));
    else params.append(key, typeof item === "string" ? item : "");
  };
  for (const key of Object.keys(value)) {
    const entry = value[key];
    if (Array.isArray(entry)) for (const item of entry) push(key, item);
    else push(key, entry);
  }
  return params.toString();
};

export const requestApi: ThisType<ContextState & RequestApi> & RequestApi = {
  get raw(): Request {
    return this.rawRequest;
  },
  get method(): string {
    return this.rawRequest.method;
  },
  get url(): string {
    return (this.urlValue ??= `${getPath(this.rawRequest.url)}${getSearch(this.rawRequest.url)}`);
  },
  set url(value: string) {
    this.urlValue = value;
    this.pathValue = null;
    // The parsed query cache is keyed by the URL — a rewrite invalidates it.
    this.queryValue = null;
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
    return (this.originalUrlValue ??= `${getPath(this.rawRequest.url)}${getSearch(this.rawRequest.url)}`);
  },
  get querystring(): string {
    const url = this.url;
    const hash = url.indexOf("#");
    const limit = hash === -1 ? url.length : hash;
    const q = url.indexOf("?");
    if (q === -1 || q > limit) return "";
    return url.slice(q + 1, limit);
  },
  get search(): string {
    const qs = this.querystring;
    return qs.length === 0 ? "" : `?${qs}`;
  },
  get query(): QueryMap {
    return (this.queryValue ??= parseQuery(this.querystring));
  },
  set query(value: QueryMap) {
    // Koa 3: assigning an object rewrites the query string on the request;
    // the next read re-parses from the rewritten URL (round-trip semantics).
    const url = this.url;
    const base = url.slice(0, url.indexOf("?") === -1 ? url.length : url.indexOf("?"));
    const serialized = stringifyQuery(value);
    this.url = serialized.length === 0 ? base : `${base}?${serialized}`;
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
    return toURL(this.rawRequest.url);
  },
  get headers(): Headers {
    return this.rawRequest.headers;
  },
  get runtime(): Runtime | undefined {
    return this.runtimeValue;
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
        this.rawRequest.headers.get("referrer") ?? this.rawRequest.headers.get("referer") ?? ""
      );
    }
    return this.rawRequest.headers.get(name) ?? "";
  },
  get host(): string {
    if (this.appSettings.proxy) {
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
    return this.rawRequest.url.startsWith("https://") ? "https" : "http";
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
      .map((ip) => ip.trim())
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
      const runtime = this.runtimeValue;
      const remote = runtime?.remote;
      if (typeof remote === "string") this.ipValue = remote;
      else if (typeof remote === "function") this.ipValue = remote() ?? "";
      else {
        const server = runtime?.server as
          | { requestIP(request: Request): { readonly address: string } | null }
          | undefined;
        this.ipValue = server?.requestIP(this.rawRequest)?.address ?? "";
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
    return IDEMPOTENT.has(this.rawRequest.method);
  },
  get charset(): string {
    return charsetFromContentType(this.rawRequest.headers.get("content-type") ?? "");
  },
  get reqType(): string {
    return normalizeType(this.rawRequest.headers.get("content-type") ?? "");
  },
  get reqLength(): number | undefined {
    const raw = this.rawRequest.headers.get("content-length");
    if (raw === null || raw.length === 0) return undefined;
    const parsed = Number.parseInt(raw, 10);
    return Number.isNaN(parsed) ? undefined : parsed;
  },
  get stale(): boolean {
    return !this.fresh;
  },
  get fresh(): boolean {
    const method = this.rawRequest.method;
    if (method !== "GET" && method !== "HEAD") return false;
    const status = this.statusValue;
    if ((status >= 200 && status < 300) || status === 304) {
      return isFresh(this);
    }
    return false;
  },
  is(...types: (string | string[])[]): string | null | false {
    const contentType = this.rawRequest.headers.get("content-type");
    if (types.length === 0) {
      return contentType === null ? "" : normalizeType(contentType);
    }
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
 * `fresh` per the `fresh` package (Koa semantics): If-None-Match takes
 * precedence over If-Modified-Since, but when both are present BOTH validators
 * must hold; `Cache-Control: no-cache` always forces a full response.
 */
const isFresh = (c: ContextState): boolean => {
  const headers = c.rawRequest.headers;
  const modifiedSince = headers.get("if-modified-since");
  const noneMatch = headers.get("if-none-match");

  if (modifiedSince === null && noneMatch === null) return false;

  // Always stale on end-to-end reload requests (RFC 2616 §14.9.4).
  const cacheControl = headers.get("cache-control");
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
