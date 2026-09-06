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
import { clearBranches } from "../branches.ts";
import { FLAG_DEV_CHAIN } from "./state.ts";
import type { ContextExtensions } from "../../types.ts";
import type { RequestApi } from "./request.ts";
import { requestApi } from "./request.ts";
import type { ResponseApi } from "./response.ts";
import { responseApi } from "./response.ts";
import type { ContextState } from "./state.ts";
import type { RequestSource } from "../request-source.ts";
import { NO_PARAM_NAMES, NO_PARAM_VALUES } from "../../router/router.ts";

export interface ContextCore extends RequestApi, ResponseApi {
  readonly app: Application;
  /** Methods registered for the matched path (405/Allow support). */
  readonly routerAllowed: Set<string>;
  readonly state: Record<string, unknown>;
  /**
   * Path parameter by name (U2 functional form). `undefined` when the
   * matched route has no such param (optionals may be absent) or no route
   * matched at all. Repeated names keep their LATEST capture.
   */
  params(name: string): string | undefined;
  throw(status: number, message?: string | HttpErrorProps, props?: HttpErrorProps): never;
  assert(test: unknown, status: number, message?: string, props?: HttpErrorProps): void;
}

/**
 * The per-request context type. `ContextExtensions` is the (empty by
 * default) declaration-merging point: users augment it to type their
 * `app.decorate(...)` members, and interface merging flows through this
 * intersection into every handler signature (see src/types.ts).
 */
export type Context = ContextState & ContextCore & ContextExtensions;

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
  readonly routerAllowed: Set<string>;
  params(name: string): string | undefined;
  throw(status: number, message?: string | HttpErrorProps, props?: HttpErrorProps): never;
  assert(test: unknown, status: number, message?: string, props?: HttpErrorProps): void;
} = {
  get app(): Application {
    return this.appValue;
  },
  get state(): Record<string, unknown> {
    // Created on first touch — handlers that never use c.state (the common
    // hot path) skip this allocation entirely.
    return (this.stateValue ??= Object.create(null) as Record<string, unknown>);
  },
  get routerAllowed(): Set<string> {
    return (this.allowedValue ??= new Set());
  },
  params(name: string): string | undefined {
    // Arrays have no prototype chain to hit — "toString"/"__proto__"/"constructor"
    // simply miss (undefined), unlike the old null-proto Record where a missed
    // key was also undefined but construction cost ~30ns/request. lastIndexOf:
    // for routes with a REPEATED name the latest capture wins (trie semantics
    // — the trie dedups at construction, fast/table layers don't need to).
    // +paramOffset: the table layer's values live inside the regex exec array.
    const index = this.paramNames.lastIndexOf(name);
    return index === -1 ? undefined : this.paramValues[index + this.paramOffset];
  },
  throw(status: number, message?: string | HttpErrorProps, props?: HttpErrorProps): never {
    // UX-7 (0.6.2 review): an error status is 4xx/5xx by definition. A 1xx/
    // 2xx/3xx here is a caller bug — the funnel would coerce it to a
    // meaningless 500 (createError's normalization fallback, which stays for
    // genuinely malformed inputs). Fail loud at the throw site naming the
    // right tool; the error funnel itself keeps coercing (it cannot throw).
    if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 399) {
      throw new TypeError(
        `c.throw() expects a 4xx/5xx error status, got ${status} — redirect with c.redirect(url[, code]) or return a Response; informational and success statuses are not errors`,
      );
    }
    throw createError(status, message, props);
  },
  assert(test: unknown, status: number, message?: string, props?: HttpErrorProps): void {
    if (!test) throw createError(status, message, props);
  },
};

/**
 * Immutable fresh-request sentinels. They live on the prototype: a request
 * only creates own properties for state it actually changes. Every value is
 * primitive/null/undefined, so no request can mutate shared state. This
 * removes twenty cold slot writes from the common routing/response path.
 */
const CONTEXT_DEFAULTS = {
  runtimeValue: undefined,
  pathValue: null,
  urlValue: null,
  ipValue: null,
  allowedValue: null,
  paramNames: NO_PARAM_NAMES,
  paramValues: NO_PARAM_VALUES,
  paramOffset: 0,
  routePath: "",
  routeName: undefined,
  querystringValue: null,
  urlObjectValue: null,
  hostValue: null,
  statusValue: 404,
  headersRecord: null,
  flags: 0,
  _res: undefined,
  directBodyResponseValue: undefined,
  stateValue: null,
  cookiesValue: null,
  bodyCache: undefined,
  validValue: undefined,
  bodySerializedValue: undefined,
  abortValue: undefined,
  deadlineAnswered: false,
} satisfies Partial<ContextState>;

/** The base prototype shared by every app (before `decorate` extensions). */
export const baseContextProto = Object.assign(
  mergeProtos(requestApi, responseApi, contextApi),
  CONTEXT_DEFAULTS,
);

/**
 * The internal slot names, exported for the pooling property fence: a
 * recycled context keeps these as own properties (assign-cleared to their
 * CONTEXT_DEFAULTS sentinels — shape-stable recycling; deletes would push
 * the object into dictionary mode and cost ~1.3μs/req), so the fence
 * whitelists them while still flagging every ad-hoc key as foreign.
 */
export const CONTEXT_SLOT_KEYS = Object.keys(CONTEXT_DEFAULTS);

/**
 * Own keys a healthy context may carry: every assignSlots slot (probed from a
 * real assignment so the set cannot drift) plus the identity slots
 * createContext/resetContext assign around it. Anything else is a handler's
 * ad-hoc property (koa-idiomatic `c.user = …`) and must NOT survive a pool
 * recycle: the next request would read the previous request's data
 * (cross-request disclosure).
 */
const INTERNAL_SLOTS: ReadonlySet<string> = new Set([
  ...CONTEXT_SLOT_KEYS,
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

/**
 * Drop prior-generation state so the next request reads fresh sentinels.
 * Slots are REASSIGNED their CONTEXT_DEFAULTS instead of deleted: deleting
 * an own property transitions the recycled object into dictionary mode,
 * which measurably slowed every subsequent slot access (~1.3μs/req on the
 * Bun hot path) — assignment restores byte-identical sentinel values while
 * keeping the object's shape stable.
 */
const clearRequestSlots = (c: Context): void => {
  const own = c as unknown as Record<string, unknown>;
  const defaults = CONTEXT_DEFAULTS as Record<string, unknown>;
  for (const key of CONTEXT_SLOT_KEYS) own[key] = defaults[key];
  clearBranches(c);
};

/** Create the per-request context. One flat allocation, fixed field order. */
export const createContext = (
  app: Application,
  proto: object,
  raw: RequestSource,
  runtime: ContextState["runtimeValue"],
): Context => {
  const c = Object.create(proto) as Context;
  if (c.appValue !== app) c.appValue = app;
  c.rawRequest = raw;
  if (c.appSettings !== app.settings) c.appSettings = app.settings;
  if (runtime !== undefined) c.runtimeValue = runtime;
  // Dev chain tracing (DOGFOOD-R2 C2): one bit, written only in dev.
  if (app.env === "development") c.flags |= FLAG_DEV_CHAIN;
  return c;
};

/** Hot internal constructor for an app-bound prototype. */
export const createBoundContext = (
  proto: object,
  raw: RequestSource,
  runtime: ContextState["runtimeValue"],
): Context => {
  const c = Object.create(proto) as Context;
  c.rawRequest = raw;
  if (runtime !== undefined) c.runtimeValue = runtime;
  return c;
};

/** Reset a recycled context in place (pooling is opt-in; see app options). */
export const resetContext = (
  c: Context,
  raw: RequestSource,
  runtime: ContextState["runtimeValue"],
): Context => {
  sweepForeignKeys(c);
  clearRequestSlots(c);
  // clearRequestSlots resets `flags` to 0 as an own property, shadowing the
  // dev FLAG_DEV_CHAIN the app prototype installs — without this restore,
  // every RECYCLED context silently loses stall tracing in development.
  if (c.appValue.env === "development") c.flags |= FLAG_DEV_CHAIN;
  c.rawRequest = raw;
  if (runtime !== undefined) c.runtimeValue = runtime;
  return c;
};
