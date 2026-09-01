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
import { clearBranches } from "../branches.ts";
import { markCommittedHeadersStaged } from "../committed-headers.ts";
import { FLAG_DEV_CHAIN } from "./state.ts";
import type { HeaderMap } from "../../types.ts";
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
    // needing the multi-value flag. Null-proto like recordOf() — inherited
    // keys must never surface on the header record.
    // The facade writes the record directly. If earlier post-commit header
    // operations were applied in place, materializing this writer turns the
    // mirror back into semantic rebuild input so a later cookie cannot be
    // skipped by the finalizer.
    markCommittedHeadersStaged(c);
    const headers = (c.headersRecord ??= Object.create(null) as HeaderMap);
    const cookies = createCookies({
      get cookieHeader(): string | null {
        return c.rawRequest.headers.get("cookie");
      },
      // Koa's "get secure from request": cookies set over a secure request
      // (incl. proxy-trusted x-forwarded-proto) carry Secure unless the
      // caller explicitly opts out — session-downgrade protection behind an
      // https-terminating proxy.
      get requestSecure(): boolean {
        return c.secure;
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

/** Assign the full internal slot set (fixed order, one hidden class). */
const assignSlots = (c: Context): Context => {
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
  c.removedValue = null;
  c._res = undefined;
  c.stateValue = null;
  c.cookiesValue = null;
  // Plugin memo slots: undefined clears any own property a previous
  // request created (body bytes / validated value must never survive a
  // pool recycle — cross-request disclosure).
  c.bodyCache = undefined;
  c.validValue = undefined;
  // A recycled object starts a new generation with no outstanding branches
  // (any leftover registration belongs to the previous request).
  clearBranches(c);
  return c;
};

/**
 * Own keys a healthy context may carry: every assignSlots slot (probed from a
 * real assignment so the set cannot drift) plus the identity slots
 * createContext/resetContext assign around it. Anything else is a handler's
 * ad-hoc property (koa-idiomatic `c.user = …`) and must NOT survive a pool
 * recycle: the next request would read the previous request's data
 * (cross-request disclosure).
 */
const INTERNAL_SLOTS: ReadonlySet<string> = new Set([
  ...Object.keys(assignSlots(Object.create(baseContextProto) as Context)),
  "appValue",
  "appSettings",
  "rawRequest",
  "runtimeValue",
]);

/**
 * Strip a RECYCLED context's foreign own keys (handler-assigned ad-hoc
 * properties — see INTERNAL_SLOTS). Fresh contexts skip this: an
 * Object.create'd object carries no own properties, and the sweep on the
 * no-pooling hot path measured +9% in-process per request (bench/M4).
 */
const sweepForeignKeys = (c: Context): void => {
  // Reflect.ownKeys, not Object.keys: a handler's SYMBOL-keyed property is
  // just as much per-request data (it must never survive a recycle).
  const own = c as unknown as Record<PropertyKey, unknown>;
  for (const key of Reflect.ownKeys(c)) {
    if (typeof key !== "string" || !INTERNAL_SLOTS.has(key)) delete own[key];
  }
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
  assignSlots(c);
  // Dev chain tracing (DOGFOOD-R2 C2): one bit, written only in dev.
  if (app.env === "development") c.flags |= FLAG_DEV_CHAIN;
  return c;
};

/** Reset a recycled context in place (pooling is opt-in; see app options). */
export const resetContext = (
  c: Context,
  raw: Request,
  runtime: ContextState["runtimeValue"],
): Context => {
  sweepForeignKeys(c);
  c.rawRequest = raw;
  c.runtimeValue = runtime;
  assignSlots(c);
  if (c.appValue.env === "development") c.flags |= FLAG_DEV_CHAIN;
  return c;
};
