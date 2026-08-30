/**
 * Context — the object handed to every middleware.
 *
 * `ctx` delegates most properties to `ctx.request` / `ctx.response` exactly
 * like Koa's `delegates` package, but through shared-prototype accessors:
 * zero per-request closure or descriptor cost.
 */

import type { Application } from "../application/app.ts";
import { createError, type HttpErrorProps } from "../http/errors.ts";
import {
  createRequest,
  type RemoteSource,
  type RequestFacade,
  type RequestState,
} from "../http/request.ts";
import {
  createResponse,
  linkResponsePeer,
  type ResponseFacade,
  type ResponsePeer,
  type ResponseState,
} from "../http/response.ts";
import type { QueryMap } from "../utils/query.ts";
import type { HeaderMap, ResponseBody } from "../types.ts";
import { createCookies, type CookiesFacade } from "./cookies.ts";

export interface Context {
  readonly app: Application;
  readonly request: RequestFacade;
  readonly response: ResponseFacade;
  readonly state: Record<string, unknown>;
  readonly cookies: CookiesFacade;
  readonly originalUrl: string;
  readonly URL: URL | null;
  toJSON(): { request: Record<string, unknown>; response: Record<string, unknown> };
  /** Path parameters set by the router (`ctx.params.id`). Undefined when unmatched. */
  params?: Record<string, string>;
  // ---- request delegates
  readonly header: Headers;
  readonly headers: Headers;
  readonly method: string;
  url: string;
  path: string;
  querystring: string;
  search: string;
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
  is(...types: (string | string[])[]): string | null | false;
  accepts(...types: (string | string[])[]): string | string[] | false;
  acceptsEncodings(...encodings: (string | string[])[]): string | string[] | false;
  acceptsCharsets(...charsets: (string | string[])[]): string | string[] | false;
  acceptsLanguages(...langs: (string | string[])[]): string | string[] | false;
  get(field: string): string;
  // ---- response delegates
  status: number;
  message: string;
  body: unknown;
  readonly responseHeaders: ResponseState["_headers"];
  readonly headerSent: boolean;
  length: number | undefined;
  type: string;
  lastModified: Date | string | undefined;
  etag: string;
  attachment(filename?: string, options?: { fallback?: string | false; type?: string }): void;
  redirect(url: string, alt?: string): void;
  back(alt?: string): void;
  set(field: string | Record<string, string | string[]>, value?: string | string[]): void;
  append(field: string, value: string | string[]): void;
  remove(field: string): void;
  vary(field: string): void;
  // ---- context API
  throw(status: number, message?: string | HttpErrorProps, props?: HttpErrorProps): never;
  assert(test: unknown, status: number, message?: string, props?: HttpErrorProps): void;
}

export interface ContextState {
  appValue: Application;
  requestValue: RequestFacade;
  responseValue: ResponseFacade;
  stateValue: Record<string, unknown> | null;
  _cookies: CookiesFacade | null;
}

export const contextProto: ThisType<ContextState & Context> & Context = {
  get app(): Application {
    return this.appValue;
  },
  get request(): RequestFacade {
    return this.requestValue;
  },
  get response(): ResponseFacade {
    return this.responseValue;
  },
  get state(): Record<string, unknown> {
    // Created on first touch — request handlers that never use ctx.state
    // (the common hot path) skip this allocation entirely.
    return (this.stateValue ??= Object.create(null) as Record<string, unknown>);
  },
  get cookies(): CookiesFacade {
    if (this._cookies !== null) return this._cookies;
    const request = this.requestValue as unknown as RequestState;
    const response = this.responseValue as unknown as ResponseState;
    const cookies = createCookies({
      get cookieHeader(): string | null {
        return request.rawRequest.headers.get("cookie");
      },
      keys: this.appValue.keys,
      responseHeaders: response._headers,
    });
    this._cookies = cookies;
    return cookies;
  },
  get originalUrl(): string {
    return this.request.originalUrl;
  },
  get URL(): URL | null {
    return this.request.URL;
  },
  toJSON(): { request: Record<string, unknown>; response: Record<string, unknown> } {
    return {
      request: this.request.toJSON() as unknown as Record<string, unknown>,
      response: this.response.toJSON() as unknown as Record<string, unknown>,
    };
  },
  throw(status: number, message?: string | HttpErrorProps, props?: HttpErrorProps): never {
    throw createError(status, message, props);
  },
  assert(test: unknown, status: number, message?: string, props?: HttpErrorProps): void {
    if (!test) throw createError(status, message, props);
  },
  // ---- request delegates
  get header(): Headers {
    return this.request.header;
  },
  get headers(): Headers {
    return this.request.headers;
  },
  get method(): string {
    return this.request.method;
  },
  get url(): string {
    return this.request.url;
  },
  set url(value: string) {
    this.request.url = value;
  },
  get path(): string {
    return this.request.path;
  },
  set path(value: string) {
    this.request.path = value;
  },
  get querystring(): string {
    return this.request.querystring;
  },
  set querystring(value: string) {
    this.request.querystring = value;
  },
  get search(): string {
    return this.request.search;
  },
  set search(value: string) {
    this.request.search = value;
  },
  get query(): QueryMap {
    return this.request.query;
  },
  set query(value: QueryMap) {
    this.request.query = value;
  },
  get host(): string {
    return this.request.host;
  },
  get hostname(): string {
    return this.request.hostname;
  },
  get protocol(): string {
    return this.request.protocol;
  },
  get secure(): boolean {
    return this.request.secure;
  },
  get ip(): string {
    return this.request.ip;
  },
  get ips(): string[] {
    return this.request.ips;
  },
  get subdomains(): string[] {
    return this.request.subdomains;
  },
  get origin(): string {
    return this.request.origin;
  },
  get href(): string {
    return this.request.href;
  },
  get fresh(): boolean {
    return this.request.fresh;
  },
  get stale(): boolean {
    return this.request.stale;
  },
  get idempotent(): boolean {
    return this.request.idempotent;
  },
  get charset(): string {
    return this.request.charset;
  },
  is(...types: (string | string[])[]) {
    return this.request.is(...types);
  },
  accepts(...types: (string | string[])[]) {
    return this.request.accepts(...types);
  },
  acceptsEncodings(...encodings: (string | string[])[]) {
    return this.request.acceptsEncodings(...encodings);
  },
  acceptsCharsets(...charsets: (string | string[])[]) {
    return this.request.acceptsCharsets(...charsets);
  },
  acceptsLanguages(...langs: (string | string[])[]) {
    return this.request.acceptsLanguages(...langs);
  },
  get(field: string): string {
    return this.request.get(field);
  },
  // ---- response delegates
  get status(): number {
    return this.response.status;
  },
  set status(value: number) {
    this.response.status = value;
  },
  get message(): string {
    return this.response.message;
  },
  set message(value: string) {
    this.response.message = value;
  },
  get body(): unknown {
    return this.response.body;
  },
  set body(value: unknown) {
    (this.response as { body: ResponseBody }).body = value as ResponseBody;
  },
  get responseHeaders(): ResponseState["_headers"] {
    return (this.response as unknown as ResponseState)._headers;
  },
  get headerSent(): boolean {
    return this.response.headerSent;
  },
  get length(): number | undefined {
    return this.response.length;
  },
  set length(value: number) {
    this.response.length = value;
  },
  get type(): string {
    return this.response.type;
  },
  set type(value: string) {
    this.response.type = value;
  },
  get lastModified(): Date | undefined {
    const value = this.response.lastModified;
    return value instanceof Date ? value : undefined;
  },
  set lastModified(value: Date | string | undefined) {
    (this.response as { lastModified: Date | string | undefined }).lastModified = value;
  },
  get etag(): string {
    return this.response.etag;
  },
  set etag(value: string) {
    this.response.etag = value;
  },
  attachment(...args: Parameters<ResponseFacade["attachment"]>) {
    this.response.attachment(...args);
  },
  redirect(...args: Parameters<ResponseFacade["redirect"]>) {
    this.response.redirect(...args);
  },
  back(...args: Parameters<ResponseFacade["back"]>) {
    this.response.back(...args);
  },
  set(...args: Parameters<ResponseFacade["set"]>) {
    this.response.set(...args);
  },
  append(...args: Parameters<ResponseFacade["append"]>) {
    this.response.append(...args);
  },
  remove(...args: Parameters<ResponseFacade["remove"]>) {
    this.response.remove(...args);
  },
  vary(...args: Parameters<ResponseFacade["vary"]>) {
    this.response.vary(...args);
  },
};

/** `http-assert` equivalent: throws an HttpError when the condition is falsy. */
export const httpAssert = (
  test: unknown,
  status: number,
  message?: string,
  props?: HttpErrorProps,
): void => {
  if (!test) throw createError(status, message, props);
};

/**
 * Create the per-request context: three flat objects (ctx + request + response)
 * sharing static prototypes. The response facade gets a minimal peer pointing
 * back at the request facade (used by `redirect` and `back`).
 */
/** Internal accessor used by the router's hot dispatch path. */
export const requestStateOf = (ctx: Context): RequestState =>
  (ctx as unknown as ContextState).requestValue as unknown as RequestState;

/** Reset a pooled context in place — cheaper than a fresh allocation set. */
export const resetContext = (ctx: ContextState, raw: Request, remote: RemoteSource): Context => {
  const response = ctx.responseValue as unknown as ResponseState;
  response.peer = undefined as unknown as ResponsePeer;
  response._status = 404;
  response._message = "";
  response._headers = {} as HeaderMap;
  response._body = null;
  response._flags = 0;
  const request = ctx.requestValue as unknown as RequestState;
  request.rawRequest = raw;
  request.remote = remote;
  request.remoteValue = null;
  request._url = null;
  request._query = null;
  request.originalUrlValue = null;
  ctx.stateValue = null;
  ctx._cookies = null;
  (ctx as unknown as { params?: Record<string, string> }).params = undefined;
  delete (ctx as unknown as { _routerAllowed?: Set<string> })._routerAllowed;
  return ctx as unknown as Context;
};

export const createContext = (app: Application, raw: Request, remote: RemoteSource): Context => {
  const response = createResponse(app.response);
  const request = createRequest(raw, response, app, remote, app.request);
  linkResponsePeer(response, { request });
  const ctx: ContextState = Object.create(app.context);
  ctx.appValue = app;
  ctx.requestValue = request;
  ctx.responseValue = response;
  ctx.stateValue = null;
  ctx._cookies = null;
  return ctx as unknown as Context;
};
