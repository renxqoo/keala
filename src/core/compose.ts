/**
 * Middleware composition — the onion model with precompiled levels.
 *
 * The chain is compiled ONCE at registration time into nested functions; a
 * request executes a straight call chain with zero dispatch closures and zero
 * `Promise.resolve` wraps. Each level allocates exactly one small `next`
 * closure (it captures the per-request context), guarded against double
 * `next()` calls with a local flag.
 *
 * Dual-mode commit rule (see docs/DESIGN.md §4): when a handler settles
 * with a `Response`, it is committed to the context's response slot — the
 * last committer wins, which makes "outer middleware rewriting the downstream
 * response after `await next()`" work without any runtime style detection.
 */

import type { Next } from "../types.ts";

/** Anything a handler may return: a committed Response, or nothing. */
export type HandlerResult = Response | void;

export interface MiddlewareContext {
  /** Arbitrary per-request state (`c.state`). */
  state: Record<string, unknown>;
  /** Committed response slot — managed by compose, read by the finalizer. */
  _res: Response | undefined;
}

export type Handler<C extends MiddlewareContext = MiddlewareContext> = (
  c: C,
  next: Next,
) => HandlerResult | Promise<HandlerResult>;

export type Level<C extends MiddlewareContext> = (c: C, tail: Next) => Promise<void> | void;

export type Composed<C extends MiddlewareContext> = Level<C>;

const terminal: Level<MiddlewareContext> = (_c, tail) => tail();

/** Commit a settled handler result; undefined means "keep the current slot". */
const commit = (c: MiddlewareContext, ret: HandlerResult): void => {
  if (ret === undefined || ret === null) return;
  if (ret instanceof Response) {
    c._res = ret;
    return;
  }
  // A thenable return is a programming error: handlers must await their own
  // promises. Fail loudly in every environment — silent drops hide bugs.
  if (typeof (ret as PromiseLike<unknown>).then === "function") {
    throw new TypeError("handler returned a promise — await it inside the handler instead");
  }
  throw new TypeError(`handler returned ${typeof ret}; only Response, undefined or null are valid`);
};

const makeLevel =
  <C extends MiddlewareContext>(handler: Handler<C>, downstream: Level<C>): Level<C> =>
  (c, tail) => {
    let advanced = false;
    const result = handler(c, () => {
      if (advanced) {
        throw new Error("next() called multiple times in the same middleware");
      }
      advanced = true;
      const downstreamResult = downstream(c, tail);
      if (downstreamResult !== undefined && typeof downstreamResult.then === "function") {
        // A handler that returns WITHOUT awaiting its next() leaves this
        // promise floating; a late rejection there would otherwise surface as
        // a process-level unhandledRejection under Bun.serve. Observe it
        // silently — the response has already been committed by design.
        // (Synchronous chains return undefined here and pay nothing.)
        void (downstreamResult as Promise<void>).catch(() => undefined);
      }
      return downstreamResult as Promise<void>;
    });
    if (result instanceof Promise) {
      return result.then((settled) => {
        commit(c, settled as HandlerResult);
      });
    }
    commit(c, result);
    return undefined;
  };

/**
 * Compile a handler stack into a single callable. The result is cached by the
 * caller (per app / per route) and reused for every request, so composition
 * cost is paid once at registration instead of per request.
 */
export const compose = <C extends MiddlewareContext>(
  handlers: readonly Handler<C>[],
): Composed<C> => {
  let level: Level<C> = terminal as unknown as Level<C>;
  for (let i = handlers.length - 1; i >= 0; i--) {
    const handler = handlers[i];
    if (typeof handler !== "function") {
      throw new TypeError("Middleware must be composed of functions");
    }
    const downstream = level;
    level = makeLevel(handler, downstream);
  }
  return (c, tail) => level(c, tail);
};

/** No-op tail used by the application chain. */
export const NOOP_TAIL: Next = async () => {};

/**
 * Wrap a single handler (no stack) as a uniform chain callable — the fast
 * path for routes with one handler and no middleware. Zero guard closures.
 */
export const direct =
  <C extends MiddlewareContext>(handler: Handler<C>): Composed<C> =>
  (c, tail) => {
    const result = handler(c, tail);
    if (result instanceof Promise) {
      return result.then((settled) => {
        commit(c, settled as HandlerResult);
      });
    }
    commit(c, result);
    return undefined;
  };
