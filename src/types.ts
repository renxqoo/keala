/**
 * Shared type definitions.
 *
 * The framework is functional-first: no classes, only factory functions and
 * plain (often prototype-less) objects. Runtime-facing types live here or
 * next to their owning module.
 */

/** Callable invoked by a middleware to run the downstream part of the onion. */
export type Next = () => Promise<void>;

/** A single header value or multiple values (e.g. multiple `Set-Cookie`). */
export type HeaderValue = string | string[];

/** Header map kept on the context; created lazily on first response write. */
export type HeaderMap = Record<string, HeaderValue>;

/**
 * Allowed response bodies (state mode): objects are serialized as JSON,
 * `Blob` / `Response` / `ReadableStream` pass through directly.
 */
export type ResponseBody = string | Uint8Array | ReadableStream | Blob | Response | object | null;

/** Response-shaping arguments accepted by the `c.text/json/html` sugar. */
export interface ResponseInitLike {
  status?: number;
  headers?: Record<string, HeaderValue>;
}

/**
 * Pluggable component: installs capabilities onto an app at setup time.
 * Middleware functions and components share `app.use(...)` — anything with an
 * `install(app)` method is treated as a component.
 */
export interface Component {
  readonly name: string;
  install(app: unknown): void;
}

/** Per-request runtime injection channel (server handle, env, remote addr). */
export interface Runtime {
  /** Bun server handle — enables `c.ip` via `requestIP` and websocket upgrades. */
  readonly server?: unknown;
  /** Literal remote address or a thunk resolving it. */
  readonly remote?: string | (() => string | undefined);
  /** Bindings surfaced to handlers (defaults to `process.env` on Node-like hosts). */
  readonly env?: Record<string, string | undefined>;
}

export interface AppOptions {
  /** Cookie signing keys (rotation supported: first key signs, any key verifies). */
  keys?: (string | Uint8Array)[];
  /** Trust proxy headers (`X-Forwarded-For`, `X-Forwarded-Proto`, `X-Forwarded-Host`). */
  proxy?: boolean;
  /** Header holding client IPs when `proxy` is enabled. Default `X-Forwarded-For`. */
  proxyIpHeader?: string;
  /** Max IPs kept from the proxy header when `proxy` is enabled. */
  maxIpsCount?: number;
  /** Number of hostname labels that make up the "root". Default 2. */
  subdomainOffset?: number;
  /** Environment name. Default `process.env.NODE_ENV` or `"development"`. */
  env?: string;
  /** Silence error logging when no `error` listener is registered. */
  silent?: boolean;
  /**
   * Opt-in stream error observation: when set, state-mode stream bodies are
   * re-pumped through a guard so consumer/producer failures reach this hook
   * instead of vanishing. Costs one wrapper per streaming response.
   */
  onStreamError?: (error: Error, c: import("./core/context/context.ts").Context) => void;
  /**
   * Recycle the per-request contexts (opt-in, GUARDED): a settled context is
   * prototype-swapped so any late write throws instead of corrupting the
   * next request that reuses it.
   */
  pooling?: boolean;
}

export interface ListenOptions {
  port?: number;
  hostname?: string;
  reusePort?: boolean;
  maxRequestBodySize?: number;
  idleTimeout?: number;
  development?: boolean;
  /** Sink static, unauthenticated routes into Bun's native routing table. */
  nativeRoutes?: boolean;
  /** Bun websocket tuning (maxPayloadLength, backpressureLimit, idleTimeout…). */
  websocket?: Record<string, unknown>;
  /**
   * Server-level error handler (`Bun.serve({error})`): fetch failures and
   * streaming-body crashes. Default: app error hook + plain 500.
   */
  onServeError?: (error: Error) => Response;
}
