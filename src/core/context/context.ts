/**
 * The context: ONE flat object per request.
 *
 * Request-side and response-side APIs live on a single shared prototype
 * (merged from `requestApi` / `responseApi` plus the core members below), so a
 * request costs exactly one allocation with a fixed hidden class. Lazy
 * facades (`state`, `cookies`) materialize on first touch.
 */

import type { Application } from "../app.ts";
import { createError, type HttpErrorProps } from "../../http/errors.ts";
import { createCookies, type CookiesFacade } from "../../context/cookies.ts";
import type { RequestApi } from "./request.ts";
import { requestApi } from "./request.ts";
import type { ResponseApi } from "./response.ts";
import { responseApi } from "./response.ts";
import type { ContextState } from "./state.ts";

export interface ContextCore extends RequestApi, ResponseApi {
  readonly app: Application;
  /** Methods registered for the matched path (405/Allow support). */
  readonly routerAllowed: Set<string>;
  readonly state: Record<string, unknown>;
  readonly cookies: CookiesFacade;
  throw(status: number, message?: string | HttpErrorProps, props?: HttpErrorProps): never;
  assert(test: unknown, status: number, message?: string, props?: HttpErrorProps): void;
  toJSON(): Record<string, unknown>;
}

export type Context = ContextState & ContextCore;

/** Merge API objects into one prototype, preserving property descriptors. */
const mergeProtos = (...sources: object[]): object => {
  const proto: object = {};
  for (const source of sources) {
    Object.defineProperties(proto, Object.getOwnPropertyDescriptors(source));
  }
  return proto;
};

const contextApi: ThisType<Context> & {
  readonly app: Application;
  readonly state: Record<string, unknown>;
  readonly cookies: CookiesFacade;
  readonly routerAllowed: Set<string>;
  throw(status: number, message?: string | HttpErrorProps, props?: HttpErrorProps): never;
  assert(test: unknown, status: number, message?: string, props?: HttpErrorProps): void;
  toJSON(): Record<string, unknown>;
} = {
  get app(): Application {
    return this.appValue;
  },
  get state(): Record<string, unknown> {
    // Created on first touch — handlers that never use c.state (the common
    // hot path) skip this allocation entirely.
    return (this.stateValue ??= Object.create(null) as Record<string, unknown>);
  },
  get cookies(): CookiesFacade {
    if (this.cookiesValue !== null) return this.cookiesValue as CookiesFacade;
    const c = this as Context;
    // The facade writes `Set-Cookie` straight into the response header record
    // (same semantics as koa); arrays are detected by the finalizer without
    // needing the multi-value flag.
    const headers = (c.headersRecord ??= {});
    const cookies = createCookies({
      get cookieHeader(): string | null {
        return c.rawRequest.headers.get("cookie");
      },
      keys: this.appValue.keys,
      responseHeaders: headers,
    });
    this.cookiesValue = cookies;
    return cookies;
  },
  get routerAllowed(): Set<string> {
    return (this.allowedValue ??= new Set());
  },
  throw(status: number, message?: string | HttpErrorProps, props?: HttpErrorProps): never {
    throw createError(status, message, props);
  },
  assert(test: unknown, status: number, message?: string, props?: HttpErrorProps): void {
    if (!test) throw createError(status, message, props);
  },
  toJSON(): Record<string, unknown> {
    const record = this.headersRecord;
    return {
      method: this.method,
      url: this.url,
      header: Object.fromEntries(this.rawRequest.headers.entries()),
      status: this.statusValue,
      message: this.message,
      headers: record === null ? {} : { ...record },
    };
  },
};

/** The base prototype shared by every app (before `decorate` extensions). */
export const baseContextProto = mergeProtos(requestApi, responseApi, contextApi);

const initContext = (c: Context): Context => {
  c.pathValue = null;
  c.urlValue = null;
  c.originalUrlValue = null;
  c.queryValue = null;
  c.ipValue = null;
  c.allowedValue = null;
  c.params = null;
  c.statusValue = 404;
  c.messageValue = "";
  c.headersRecord = null;
  c.bodyValue = null;
  c.flags = 0;
  c._res = undefined;
  c.stateValue = null;
  c.cookiesValue = null;
  // Plugin memo slots: undefined clears any own property a previous
  // request created (body bytes / validated value must never survive a
  // pool recycle — cross-request disclosure).
  c.bodyCache = undefined;
  c.validValue = undefined;
  return c;
};

/** Create the per-request context. One flat allocation, fixed field order. */
export const createContext = (
  app: Application,
  proto: object,
  raw: Request,
  runtime: ContextState["runtimeValue"],
): Context => {
  const c = Object.create(proto) as Context;
  c.appValue = app;
  c.rawRequest = raw;
  c.appSettings = app.settings;
  c.runtimeValue = runtime;
  return initContext(c);
};

/** Reset a recycled context in place (pooling is opt-in; see app options). */
export const resetContext = (
  c: Context,
  raw: Request,
  runtime: ContextState["runtimeValue"],
): Context => {
  c.rawRequest = raw;
  c.runtimeValue = runtime;
  return initContext(c);
};
