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
}
