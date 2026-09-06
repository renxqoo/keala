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
 * Declaration-merging point for context extensions (EXT-1).
 *
 * `app.decorate(key, value)` installs a member on every context at RUNTIME;
 * this interface is how the same member becomes visible to TypeScript.
 * Augment it once from any module in the program and every `Context` — route
 * handlers, middleware, `onStreamError` hooks — sees the member, because
 * `Context` is `ContextState & ContextCore & ContextExtensions` and interface
 * merging flows through that intersection. Augmentations are program-global:
 * pick keys the way you pick public API names.
 *
 * ```ts
 * import type { ContextExtensions } from "keala";
 *
 * declare module "keala" {
 *   interface ContextExtensions {
 *     db: Pool;
 *   }
 * }
 *
 * const app = new Keala();
 * app.decorate("db", pool);
 * app.get("/users", (c) => c.json(c.db.list())); // c.db strongly typed
 * ```
 *
 * Prefer scoping to one middleware over program-global augmentation? See
 * `createMiddleware<C>()` below — it narrows a single handler instead.
 */
export interface ContextExtensions {}

/**
 * Typed middleware factory (EXT-1's opt-in, scoped half): hands a middleware
 * author a narrowed `Context & C` without declaration merging. The returned
 * wrapper accepts your handler and yields a plain `RouteHandler` ready for
 * `app.use` / route registration. At runtime it is the IDENTITY — the passed
 * function is returned unchanged, so composition never sees an extra frame;
 * `C` describes members YOUR middleware guarantees (by decorating, wrapping,
 * or otherwise installing them before calling `next()`).
 *
 * ```ts
 * const requireUser = createMiddleware<{ user: User }>()(async (c, next) => {
 *   const user = await loadUser(c);          // your machinery
 *   c.user = user;                            // visible downstream…
 *   return next();                            // …only if you put it there
 * });
 * app.use(requireUser);
 * ```
 *
 * The two channels cooperate: members merged into `ContextExtensions` are
 * already on `Context`, so they need not be restated in `C` — an app's
 * merged members never become a burden on a third-party middleware's own
 * `C` (and the no-arg default absorbs every merge for free).
 */
export const createMiddleware = <C extends object = ContextExtensions>() => {
  return (
    fn: (
      c: import("./core/context/context.ts").Context & C,
      next: Next,
    ) =>
      | import("./core/compose.ts").HandlerResult
      | Promise<import("./core/compose.ts").HandlerResult>,
  ): import("./router/router.ts").RouteHandler =>
    fn as unknown as import("./router/router.ts").RouteHandler;
};

/**
 * Plugin: installs capabilities onto an app at setup (bootstrap) time —
 * decorating contexts, publishing configuration. Middleware functions and
 * plugins share the single `app.use(...)` entry: anything with an
 * `install(app)` method is treated as a plugin, anything else must be a
 * middleware function. Distinct lifecycles, one ergonomic entry point.
 */
export interface Plugin {
  readonly name: string;
  install(app: import("./core/app.ts").Application): void;
}

/** Per-request runtime injection channel (server handle, env, remote addr). */
export interface Runtime {
  /** Bun server handle — enables `c.ip` via `requestIP` and websocket upgrades. */
  readonly server?: unknown;
  /** Literal remote address or a thunk resolving it. */
  readonly remote?: string | (() => string | undefined);
}

export interface AppOptions {
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
  /**
   * Milliseconds to wait for EACH `app.onShutdown()` handler before
   * logging and continuing (a hung handler must not wedge `close()`
   * forever — later handlers still run). Default 10_000; 0 waits
   * indefinitely. R4.11 review: HA-4.
   */
  shutdownTimeout?: number;
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
