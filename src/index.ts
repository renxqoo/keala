/**
 * keala — hono-fast, onion-ergonomic, Bun-native.
 *
 * The ROOT entry is the app surface: core (the Keala class, router,
 * context, errors, cookie signing) plus the plugin and the in-handler
 * helpers. Middleware lives at `keala/middleware` (aggregate) or
 * `keala/middleware/<name>` (per file); the Node adapter at
 * `keala/node` — those two are the only split-out tiers (the
 * middleware tier is the heavy one; adapters are a mutually exclusive
 * runtime choice).
 *
 * ```ts
 * import { Keala } from "keala";
 * import { cors } from "keala/middleware";
 *
 * const app = new Keala({ keys: ["secret"] })
 *
 * app.use(cors())                                   // global onion middleware
 * app.get("/users/:id", (c) => c.json({ id: c.params.id }))   // return style
 * app.get("/page", (c) => { c.body = "hi"; c.type = "text/html" }) // state style
 *
 * app.listen(3000)
 * ```
 */

export { Keala, type Application } from "./core/app.ts";
export { Router } from "./router/group.ts";
export type { ErrorMapper, NotFoundHandler, WebSocketHandlers } from "./core/application.ts";
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
// Conditional-request + path-safety primitives (DOGFOOD-R1 C2): the audited
// semantics behind serveStatic, exported so file-backed products consume one
// implementation instead of re-deriving ~50 lines that drift.
export { weakEtag, isNotModified, type FreshnessInput } from "./http/conditional.ts";
export { resolveRelativeSegments, isWithinRoot, findSymlink } from "./utils/path-safety.ts";
export type { QueryMap, QueryValue } from "./utils/query.ts";
export { startBunServer, type ServerHandle, type ServeImplementation } from "./adapters/bun.ts";
export { failFastAdmission, queueAdmission } from "./core/lifecycle-admission.ts";
export type { AdmissionStrategy } from "./types.ts";
export { compilePattern, type CompiledSegment, type PatternIR } from "./router/pattern.ts";
export type {
  AppOptions,
  HeaderValue,
  ListenOptions,
  ResponseBody,
  Runtime,
  Next,
} from "./types.ts";
export type { RouteHandler } from "./router/router.ts";
export type { Plugin } from "./types.ts";
// The typed context-extension channel (EXT-1): merge into ContextExtensions
// to type `app.decorate` members app-wide; createMiddleware<C>() narrows a
// single middleware instead. The factory is runtime-identity (zero frames).
export { createMiddleware } from "./types.ts";
export type { ContextExtensions } from "./types.ts";
export type {
  NativeSinkEntry,
  NativeStaticSink,
  NativeDirSink,
  NativeFnSink,
  SunkHandler,
} from "./core/sink.ts";
export { noOpFor, type NoOpDeclaration } from "./core/middleware-stack.ts";
export {
  createBodyParser,
  bodyOf,
  readBodyLimited,
  type BodyParserOptions,
  type RequestBodyFacade,
} from "./plugins/body-parser.ts";
/**
 * @deprecated Use `bodyOf(c)` instead — `await bodyOf(c).json()` needs no
 * cast and fails loud (with the fix) when the plugin is not installed.
 */
export type { ContextWithBody } from "./plugins/body-parser.ts";
export {
  stream,
  streamText,
  streamSSE,
  disableIdleTimeout,
  type StreamWriter,
  type SSEWriter,
  type SSEMessage,
  type StreamSSEOptions,
} from "./helpers/streams.ts";
export { html, raw, escapeHtml } from "./helpers/html.ts";
export {
  bunPasswordHasher,
  pbkdf2PasswordHasher,
  hashPassword,
  verifyPassword,
  type PasswordHasher,
} from "./helpers/password.ts";
