/**
 * bun-koa — Koa-compatible, Hono-fast, Bun-native.
 *
 * ```ts
 * import { createApp, createRouter } from "bun-koa"
 *
 * const app = createApp({ keys: ["secret"] })
 * const router = createRouter()
 * router.get("/users/:id", (ctx) => {
 *   ctx.body = { id: ctx.params.id }
 * })
 * app.use(router.routes()).use(router.allowedMethods())
 * app.listen(3000)
 * ```
 */

export { createApp, type Application } from "./application/app.ts";
export {
  compose,
  NOOP_TAIL,
  type Composed,
  type Middleware,
  type MiddlewareContext,
} from "./application/compose.ts";
export type { Next } from "./types.ts";
export type { Context } from "./context/context.ts";
export { createContext } from "./context/context.ts";
export { httpAssert } from "./context/context.ts";
export {
  sign as signCookie,
  unsign as unsignCookie,
  parseCookies,
  serializeCookie,
  type CookieOptions,
  type CookiesFacade,
} from "./context/cookies.ts";
export {
  createError,
  isHttpError,
  normalizeError,
  type HttpError,
  type HttpErrorProps,
} from "./http/errors.ts";
export {
  isEmptyStatus,
  isRedirectStatus,
  isValidErrorStatus,
  statusMessage,
} from "./http/status.ts";
export type { RequestFacade } from "./http/request.ts";
export type { ResponseFacade } from "./http/response.ts";
export type { AppOptions, HeaderValue, ListenOptions, ResponseBody } from "./types.ts";
export {
  createRouter,
  type Router,
  type RouterContext,
  type RouterOptions,
} from "./router/router.ts";
export { startBunServer, type ServerHandle, type ServeImplementation } from "./adapters/bun.ts";
