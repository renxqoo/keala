/**
 * bun-koa v2 — hono-fast, onion-ergonomic, Bun-native.
 *
 * The ROOT entry is the core only: app factory, router, composition, context,
 * errors and cookie signing. Middleware lives at `bun-koa/middleware`
 * (aggregate) or `bun-koa/middleware/<name>` (per file); plugins and helpers
 * at `bun-koa/plugins/<name>` / `bun-koa/helpers/<name>`; the Node adapter at
 * `bun-koa/adapters/node`. Importing the core loads no middleware modules —
 * an idle `import "bun-koa"` costs ~2.6MB less than the everything-barrel it
 * replaces.
 *
 * ```ts
 * import { createApp } from "bun-koa";
 * import { cors } from "bun-koa/middleware";
 *
 * const app = createApp({ keys: ["secret"] })
 *
 * app.use(cors())                              // global onion middleware
 * app.get("/users/:id", (c) => c.json({ id: c.params.id }))   // return style
 * app.get("/page", (c) => { c.body = "hi"; c.type = "text/html" }) // state style
 *
 * app.listen(3000)
 * ```
 */

export { createApp, type Application } from "./core/app.ts";
export { createRouter, type Router } from "./router/group.ts";
export type { ErrorListener, NotFoundHandler } from "./core/app.ts";
export {
  compose,
  direct,
  NOOP_TAIL,
  type Composed,
  type Handler as Middleware,
  type HandlerResult,
  type MiddlewareContext,
} from "./core/compose.ts";
export type { Context } from "./core/context/context.ts";
export { createContext, resetContext, baseContextProto } from "./core/context/context.ts";
export {
  sign as signCookie,
  unsign as unsignCookie,
  parseCookies,
  serializeCookie,
  type CookieOptions,
  type CookiesFacade,
  type SigningKeys,
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
export { startBunServer, type ServerHandle, type ServeImplementation } from "./adapters/bun.ts";
export { compilePattern, type CompiledSegment, type PatternIR } from "./router/pattern.ts";
export type { AppOptions, HeaderValue, ListenOptions, ResponseBody, Runtime } from "./types.ts";
export type { Plugin } from "./types.ts";
export type { NativeSinkEntry, NativeStaticSink, NativeDirSink } from "./core/sink.ts";
