/**
 * The middleware aggregate — every per-request pipeline factory in one import.
 *
 * ```ts
 * import { Keala } from "keala";
 * import { cors, bodyLimit, serveStatic } from "keala/middleware";
 * ```
 *
 * Apps typically grab several middleware at setup time, so the whole tier is
 * importable at once. Memory-minimal consumers import per file instead
 * (`keala/middleware/auth`) — only the used factory's module loads.
 */

export { basicAuth, bearerAuth, type BasicAuthOptions, type BearerAuthOptions } from "./auth.ts";
export { cache, type ResponseCacheOptions } from "./cache.ts";
export { cors, csrf, type CorsOptions, type CsrfOptions } from "./cors.ts";
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
export {
  jwt,
  signJWT,
  verifyJWT,
  type JWTKey,
  type JWTOptions,
  type JWTPayload,
  type SignOptions,
  type SignatureAlgorithm,
  type VerifyOptions,
} from "./jwt.ts";
// The typed body-reader accessor rides the middleware aggregate too — it is
// the companion every bodyParser consumer imports alongside the plugin.
export { bodyOf } from "../plugins/body-parser.ts";
export { serveStatic, type ServeStaticOptions } from "./serve-static.ts";
export { validator, validOf, type StandardSchema } from "./validator.ts";
export { rateLimit, type RateLimitOptions } from "./rate-limit.ts";
export { metrics, type Metrics, type MetricsRegistry, type MetricsSnapshot } from "./metrics.ts";
