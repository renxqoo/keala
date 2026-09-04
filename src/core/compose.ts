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
import { registerBranch } from "./branches.ts";
import { FLAG_CHAIN_STALLED, FLAG_DEV_CHAIN } from "./context/state.ts";

/** Anything a handler may return: a committed Response, or nothing. */
export type HandlerResult = Response | void;

export interface MiddlewareContext {
  /** Arbitrary per-request state (`c.state`). */
  state: Record<string, unknown>;
  /** Committed response slot — managed by compose, read by the finalizer. */
  _res: Response | undefined;
  flags?: number;
}

export type Handler<C extends MiddlewareContext = MiddlewareContext> = (
  c: C,
  next: Next,
) => HandlerResult | Promise<HandlerResult>;

export type Level<C extends MiddlewareContext> = (c: C, tail: Next) => Promise<void> | void;

export const DIRECT_HANDLER = Symbol("keala.directHandler");

export type Composed<C extends MiddlewareContext> = Level<C> & {
  readonly [DIRECT_HANDLER]?: Handler<C>;
};

const terminal: Level<MiddlewareContext> = (_c, tail) => tail();

/**
 * Dev-only stall tracing (DOGFOOD-R2 C2): a NON-terminal level that settles
 * with void, never called next(), is a dead stop — everything downstream
 * (including the route handler) never runs and the request answers 404.
 * The migration-round trap. Production contexts never set FLAG_DEV_CHAIN,
 * so the check costs one AND and never writes. A terminal handler's void
 * return is the contract ("untouched → notFound") and is exempt.
 */
const markStalled = (
  c: MiddlewareContext,
  advanced: boolean,
  hasDownstream: boolean,
  result: HandlerResult | undefined,
): void => {
  const flags = (c as { flags?: number }).flags;
  if (
    flags === undefined ||
    advanced ||
    !hasDownstream ||
    (result !== undefined && result !== null) ||
    (flags & FLAG_DEV_CHAIN) === 0
  ) {
    return;
  }
  (c as unknown as { flags: number }).flags = flags | FLAG_CHAIN_STALLED;
};

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

const makeLevel = <C extends MiddlewareContext>(
  handler: Handler<C>,
  downstream: Level<C>,
): Level<C> => {
  // A level whose downstream is the shared terminal is the LAST handler —
  // its void return is the contract, not a stall.
  const hasDownstream = downstream !== (terminal as unknown as Level<C>);
  return (c, tail) => {
    let advanced = false;
    let floated: Promise<void> | undefined;
    // True from next() until the floated branch settles. A branch that has
    // ALREADY settled cannot outlive this level, so it must not hold pool
    // retirement either — the idiomatic `return next()` shape (the level
    // returns the downstream promise itself) used to defer every release by
    // a turn and lose the retire-before-close race (REVIEW-HA-7 soak).
    let branchLive = false;
    const result = handler(c, () => {
      if (advanced) {
        throw new Error("next() called multiple times in the same middleware");
      }
      advanced = true;
      const downstreamResult = downstream(c, tail);
      if (downstreamResult !== undefined && typeof downstreamResult.then === "function") {
        // A handler that returns WITHOUT awaiting its next() leaves this
        // promise floating; a late rejection there would otherwise surface as
        // a process-level unhandledRejection under Bun.serve. Observe it —
        // the response has already been committed by design. The same single
        // reaction flips `branchLive` off, so liveness tracking costs no
        // extra allocation. (Synchronous chains return undefined here and
        // pay nothing.)
        const branch = downstreamResult as Promise<void>;
        void branch.then(
          () => {
            branchLive = false;
          },
          () => {
            branchLive = false;
          },
        );
        floated = branch;
        branchLive = true;
      }
      return downstreamResult as Promise<void>;
    });
    if (result instanceof Promise) {
      return result.then((settled) => {
        // HA-1: an ASYNC handler that settles while its floated next() is
        // still running is the same hazard as the sync shape below — the
        // branch outlives this level while the chain (and the pool's
        // retirement decision) moves on. Register it, or a pooled context
        // is recycled under a live branch and its late writes land on the
        // next request. (`return next()` settles its branch first and pays
        // nothing here.)
        if (branchLive && floated !== undefined) registerBranch(c, floated);
        commit(c, settled as HandlerResult);
        markStalled(c, advanced, hasDownstream, settled as HandlerResult | undefined);
      });
    }
    // Sync return AFTER calling next(): the statically-detectable floating
    // branch (the async twin is registered in the Promise branch above).
    // Register it so a pooled context is never recycled while this branch
    // can still mutate it (see core/branches.ts).
    if (floated !== undefined) registerBranch(c, floated);
    commit(c, result);
    markStalled(c, advanced, hasDownstream, result);
    return undefined;
  };
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
 * path for routes with one handler and no middleware.
 *
 * BUG-4: the direct chain used to pass `tail` through bare, so a handler
 * calling next() twice ran the tail twice silently while a composed chain
 * threw. The guard matches makeLevel's semantics; the once-closure is
 * allocated ONLY when the handler actually calls next() — single-handler
 * routes without next() (the dominant shape) pay one wrapper call and
 * nothing else. The wrapper is also the DIRECT_HANDLER dispatch installs,
 * so the dispatchDirect fast path is guarded identically.
 */
export const direct = <C extends MiddlewareContext>(handler: Handler<C>): Composed<C> => {
  const guarded: Handler<C> = (c, tail) => {
    let advanced = false;
    return handler(c, () => {
      if (advanced) {
        throw new Error("next() called multiple times in the same middleware");
      }
      advanced = true;
      return tail();
    });
  };
  const chain: Composed<C> = (c, tail) => {
    const result = guarded(c, tail);
    if (result instanceof Promise) {
      return result.then((settled) => {
        commit(c, settled as HandlerResult);
      });
    }
    commit(c, result);
    return undefined;
  };
  Object.defineProperty(chain, DIRECT_HANDLER, { value: guarded });
  return chain;
};
