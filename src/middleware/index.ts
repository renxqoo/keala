/**
 * The middleware aggregate — every per-request pipeline factory in one import.
 *
 * ```ts
 * import { Honu } from "@renxqoo/honu";
 * import { cors, bodyLimit, serveStatic } from "@renxqoo/honu/middleware";
 * ```
 *
 * Apps typically grab several middleware at setup time, so the whole tier is
 * importable at once. Memory-minimal consumers import per file instead
 * (`@renxqoo/honu/middleware/auth`) — only the used factory's module loads.
 */

export { basicAuth, bearerAuth, type BasicAuthOptions, type BearerAuthOptions } from "./auth.ts";
export { cache, type ResponseCacheOptions } from "./cache.ts";
export { cors, csrf, type CorsOptions } from "./cors.ts";
export {
  csrfToken,
  csrfTokenGuard,
  type CsrfTokenOptions,
  type CsrfTokenService,
  type CsrfTokenGuardOptions,
  type CsrfAlgorithm,
} from "./csrf-token.ts";
export { etag, compress, type CompressOptions } from "./etag.ts";
export {
  secureHeaders,
  requestId,
  timing,
  logger,
  type SecureHeadersOptions,
  type LoggerOptions,
} from "./headers.ts";
export { bodyLimit, timeout } from "./limits.ts";
export { serveStatic, type ServeStaticOptions } from "./serve-static.ts";
export { validator, type StandardSchema } from "./validator.ts";
