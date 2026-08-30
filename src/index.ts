/**
 * bun-koa v2 — hono-fast, onion-ergonomic, Bun-native.
 *
 * ```ts
 * import { createApp } from "bun-koa"
 *
 * const app = createApp({ keys: ["secret"] })
 *
 * app.use((c, next) => {           // global onion middleware
 *   console.log(`${c.method} ${c.path}`)
 *   return next()
 * })
 *
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

export {
  createBodyParser,
  readBodyLimited,
  type BodyParserOptions,
  type RequestBodyFacade,
} from "./components/body-parser.ts";
export { validator, type StandardSchema } from "./components/validator.ts";
export {
  stream,
  streamText,
  streamSSE,
  type StreamWriter,
  type SSEWriter,
  type SSEMessage,
  type StreamSSEOptions,
} from "./components/streams.ts";
export {
  secureHeaders,
  requestId,
  timing,
  logger,
  type SecureHeadersOptions,
  type LoggerOptions,
} from "./components/headers.ts";
export { cors, csrf, type CorsOptions } from "./components/cors.ts";
export { etag, compress } from "./components/etag.ts";
export { bodyLimit, timeout } from "./components/limits.ts";
export { serveStatic, type ServeStaticOptions } from "./components/serve-static.ts";
export { html, raw, escapeHtml } from "./components/html.ts";
export type { Component } from "./types.ts";
