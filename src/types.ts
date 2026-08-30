/**
 * Shared type definitions for bun-koa.
 *
 * The framework is functional-first: no classes, only factory functions and
 * plain (often prototype-less) objects. All runtime-facing types live here or
 * next to their owning module.
 */

/** Callable invoked by a middleware to run the downstream part of the onion. */
export type Next = () => Promise<void>;

/** A single header value or multiple values (e.g. multiple `Set-Cookie`). */
export type HeaderValue = string | string[];

/** Header map stored on the response facade. Always created with null prototype. */
export type HeaderMap = Record<string, HeaderValue>;

/**
 * Allowed response body types (Koa 3 semantics): objects are JSON.stringify-ed
 * by the `body` setter; `Blob` and web `Response` values are supported directly.
 */
export type ResponseBody = string | Uint8Array | ReadableStream | Blob | Response | object | null;

export interface AppOptions {
  /** Cookie signing keys (rotation supported: first key signs, any key verifies). */
  keys?: (string | Uint8Array)[];
  /** Trust proxy headers (`X-Forwarded-For`, `X-Forwarded-Proto`, `X-Forwarded-Host`). */
  proxy?: boolean;
  /** Header holding client IPs when `proxy` is enabled. Default `X-Forwarded-For`. */
  proxyIpHeader?: string;
  /** Max IPs kept from the proxy header when `proxy` is enabled. */
  maxIpsCount?: number;
  /** Number of hostname labels that make up the "root". Default 2 (`subdomainOffset`). */
  subdomainOffset?: number;
  /** Environment name. Default `process.env.NODE_ENV` or `"development"`. */
  env?: string;
  /** Silence error logging when no `error` listener is registered. */
  silent?: boolean;
  /**
   * Enable `app.currentContext` (koa 3). Uses AsyncLocalStorage, which costs
   * meaningful per-request throughput on Bun — off by default.
   */
  currentContext?: boolean;
  /**
   * Recycle the per-request context objects (opt-in). Unsafe if middleware
   * stores ctx beyond the request lifetime (timers, background jobs).
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
}
