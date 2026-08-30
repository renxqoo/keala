/**
 * Middleware composition — the onion model, without Koa's recursive dispatch.
 *
 * Koa allocates a fresh `dispatch` closure per request, binds `next` for every
 * layer and wraps every step in `Promise.resolve`. Here the chain is compiled
 * ONCE at registration time into nested functions. A request then executes a
 * straight call chain: zero dispatch closures, zero `Promise.resolve` wraps,
 * zero array indexing. Each layer allocates exactly one small `next` closure
 * (unavoidable — it captures the per-request context), guarded against
 * double `next()` calls with a local flag so nested chains (router inside app)
 * never collide.
 */

import type { Next } from "../types.ts";

export interface MiddlewareContext {
  /** Arbitrary per-request state (`ctx.state`). */
  state: Record<string, unknown>;
}

export type Middleware<C extends MiddlewareContext = MiddlewareContext> = (
  ctx: C,
  next: Next,
) => Promise<void> | void;

export type Level<C extends MiddlewareContext> = (ctx: C, tail: Next) => Promise<void> | void;

export type Composed<C extends MiddlewareContext> = (ctx: C, tail: Next) => Promise<void> | void;

const terminal: Level<MiddlewareContext> = (_ctx, tail) => tail();

const makeLevel =
  <C extends MiddlewareContext>(middleware: Middleware<C>, downstream: Level<C>): Level<C> =>
  (ctx, tail) => {
    let advanced = false;
    return middleware(ctx, () => {
      if (advanced) {
        throw new Error("next() called multiple times in the same middleware");
      }
      advanced = true;
      // Sync middleware may settle without a promise; cast keeps `Next` honest
      // without wrapping every hop in `Promise.resolve` (the Koa tax).
      return downstream(ctx, tail) as Promise<void>;
    });
  };

/**
 * Compile a middleware stack into a single callable.
 * The result is cached by callers (per app / per route) and reused for every
 * request, so composition cost is paid once instead of per request.
 */
export const compose = <C extends MiddlewareContext>(
  middleware: readonly Middleware<C>[],
): Composed<C> => {
  let level: Level<C> = terminal as unknown as Level<C>;
  for (let i = middleware.length - 1; i >= 0; i--) {
    const current = middleware[i];
    if (typeof current !== "function") {
      throw new TypeError("Middleware must be composed of functions");
    }
    const downstream = level;
    level = makeLevel(current, downstream);
  }
  return (ctx, tail) => level(ctx, tail);
};

/** No-op tail used by the application chain. */
export const NOOP_TAIL: Next = async () => {};
