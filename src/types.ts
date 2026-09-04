/**
 * Shared type definitions.
 *
 * The framework keeps a functional core (compose/dispatch/respond/router are
 * plain functions over plain, often prototype-less objects) with exactly two
 * exported classes as its facade — `Keala` (the app) and `Router` (standalone
 * route groups). Runtime-facing types live here or next to their owner.
 */

/** Callable invoked by a middleware to run the downstream part of the onion. */
export type Next = () => Promise<void>;

/** A single header value or multiple values (e.g. multiple `Set-Cookie`). */
export type HeaderValue = string | string[];

/** Header map kept on the context; created lazily on first response write. */
export type HeaderMap = Record<string, HeaderValue>;

/**
 * Allowed response bodies (state mode): objects are serialized as JSON,
 * `Blob` / `ReadableStream` pass through directly. A web `Response` is NOT
 * assignable (0.7): return it instead — the commit slot owns it.
 */
export type ResponseBody = string | Uint8Array | ReadableStream | Blob | object | null;

/** Response-shaping arguments accepted by the `c.text/json/html` sugar. */
export interface ResponseInitLike {
  status?: number;
  headers?: Record<string, HeaderValue>;
}

/**
 * Plugin: installs capabilities onto an app at setup (bootstrap) time —
 * decorating contexts, publishing configuration. Middleware functions and
 * plugins share the single `app.use(...)` entry: anything with an
 * `install(app)` method is treated as a plugin, anything else must be a
 * middleware function. Distinct lifecycles, one ergonomic entry point.
 */
export interface Plugin {
  readonly name: string;
  install(app: unknown): void;
}

/** Per-request runtime injection channel (server handle, env, remote addr). */
export interface Runtime {
  /** Bun server handle — enables `c.ip` via `requestIP` and websocket upgrades. */
  readonly server?: unknown;
  /** Literal remote address or a thunk resolving it. */
  readonly remote?: string | (() => string | undefined);
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
  /** Environment name. Default `process.env.NODE_ENV` or `"development"`. */
  env?: string;
  /**
   * Opt-in stream error observation: when set, state-mode stream bodies are
   * re-pumped through a guard so consumer/producer failures reach this hook
   * instead of vanishing. Costs one wrapper per streaming response.
   */
  onStreamError?: (error: Error, c: import("./core/context/context.ts").Context) => void;
  /**
   * Recycle the per-request contexts (opt-in, GUARDED): a settled context is
   * prototype-swapped so any late write throws instead of corrupting the
   * next request that reuses it. Measured cost on the hot-path matrix: the
   * guard and recycle machinery (~2μs/req) exceeds the allocation it saves —
   * a net throughput loss on both runtimes
   * (docs/HOTPATH-R4-7-POOLING-AB.md §3). For allocation-sensitive embedding
   * scenarios, not speed.
   */
  pooling?: boolean;
  /**
   * R4.6 overload admission (opt-in): requests beyond `maxConcurrency` are
   * queued (up to `maxQueue`, fail-fast by default) or refused with 503.
   */
  overload?: OverloadOptions;
  /**
   * R4.6 request deadline in milliseconds (opt-in, 0 disables): requests
   * whose response has not settled get a 504 through the error funnel and
   * `c.signal` aborts with a TimeoutError. One unref timer per request
   * when set.
   */
  requestTimeout?: number;
  /**
   * Host whitelist (DESIGN §7.2, Host-poisoning defense): when set, a
   * request whose Host authority is not in the list is refused with an
   * exposed 403 before routing — a forged Host can otherwise poison
   * `c.origin`/`c.href`/`c.redirect(back)` and password-reset style flows.
   * Exact names and `*.example.com` suffix wildcards; port-insensitive;
   * empty list refuses nothing.
   */
  trustedHosts?: string[];
  /**
   * Answer unknown HTTP methods (not in RFC 9110's method grammar) with
   * 404 instead of 501. Default 501 (koa-router semantics).
   */
  unknownMethodAs404?: boolean;
}

/** Why the admission gate refused a request (see `OverloadOptions.handler`). */
export type OverloadReason = "concurrency" | "queue" | "draining";

/**
 * R4.6 pluggable admission (U1): decides what happens once the app is at
 * capacity. Return a Response to refuse; return null — synchronously or
 * from a promise — to admit. Call `admit()` to take the slot at the exact
 * moment capacity is acquired (the built-in queue does — its slot transfer
 * must land synchronously); a null that never called admit() is admitted
 * by the core instead, unless the app began draining while you waited.
 */
export interface AdmissionStrategy {
  onSaturated(
    state: import("./core/lifecycle.ts").LifecycleState,
    request: Request,
    admit: () => void,
    source: import("./core/request-source.ts").RequestSource,
  ): Response | Promise<Response | null> | null;
}

export interface OverloadOptions {
  /** Max simultaneously in-processing requests. Default unlimited. */
  maxConcurrency?: number;
  /**
   * How many overflowing requests may wait for a slot (FIFO). Default 0 —
   * fail fast; queueing is an explicit burst-smoothing opt-in.
   */
  maxQueue?: number;
  /** Max wait in the queue before a 503. Default 10_000. */
  queueTimeoutMs?: number;
  /**
   * `Retry-After` seconds on overload 503s (never sent while draining).
   * Default 1; 0 omits the header.
   */
  retryAfterSeconds?: number;
  /** Custom rejection response (pre-context — no Context exists yet). */
  handler?: (request: Request, reason: OverloadReason) => Response;
  /**
   * Pluggable admission (U1): replaces the implicit fail-fast/queue
   * selection. The mechanism (counter, draining refusal, slot transfer)
   * stays in the core; the strategy only decides the saturated path.
   */
  strategy?: AdmissionStrategy;
}

/** Options for `app.close()`. */
export interface CloseOptions {
  /**
   * Milliseconds to wait for in-flight requests before force-closing.
   * Default 30_000; 0 = immediate force; Infinity waits indefinitely.
   */
  drain?: number;
}

/** Result of `app.close()`. */
export interface CloseStatus {
  /** True when the drain window expired and connections were force-closed. */
  timedOut: boolean;
  /** Requests still unsettled at resolve time (0 unless timedOut). */
  inFlight: number;
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
  /**
   * R4.6 signal bridge (opt-in): SIGTERM/SIGINT drain the server via
   * `app.close()`; a second signal force-closes. The bridge never exits
   * the process itself — the drain timer holds the event loop and the
   * process exits naturally once everything settles.
   */
  signals?: boolean;
}
