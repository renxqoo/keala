/**
 * Route-chain assembly — extracted from router.ts for the file-size
 * budget: the static-head helper for slice fast-matchers, param-middleware
 * chains, and the composed/direct chain selection (with the dev tracing
 * marker) that bindDef wires onto every terminal target.
 */

import { compose, direct, type Composed } from "../core/compose.ts";
import type { Context } from "../core/context/context.ts";
import { FLAG_ROUTE_REACHED } from "../core/context/state.ts";
import type { CompiledSegment } from "./pattern.ts";
import { paramNamesOf } from "./pattern.ts";
import type { RouteHandler, RouterState } from "./router.ts";

/** All built-in chains share this signature (composed or direct). */
export type Chain = Composed<Context>;

/** Concatenate the leading static segments into a path prefix. */
export const staticHeadOf = (segments: readonly CompiledSegment[]): string => {
  let prefix = "";
  for (const segment of segments) {
    if (segment.kind !== "static") break;
    prefix += `/${segment.value}`;
  }
  return prefix;
};

export const paramChainFor = (
  state: RouterState,
  segments: readonly CompiledSegment[],
): RouteHandler[] => {
  const chain: RouteHandler[] = [];
  for (const name of paramNamesOf(segments)) {
    const mw = state.paramMiddlewares.get(name);
    if (mw !== undefined && !chain.includes(mw)) chain.push(mw);
  }
  return chain;
};

/**
 * Dev tracing marker (DOGFOOD-R1 C4): compiled between the global middleware
 * and the route's own layers, it flags "the route was reached" — a settled
 * chain WITHOUT this flag means a global middleware returned before next()
 * and the route handlers never ran.
 */
const markRouteReached: RouteHandler = (c, next) => {
  c.flags |= FLAG_ROUTE_REACHED;
  return next();
};

export const chainOf = (
  handlers: readonly RouteHandler[],
  appMiddleware: readonly RouteHandler[],
  devTrace: boolean,
): Chain => {
  if (appMiddleware.length === 0) {
    // No middleware ahead of the route: nothing can swallow it — the marker
    // (and, for one handler, composition itself) is unnecessary.
    return handlers.length === 1
      ? direct(handlers[0] as RouteHandler)
      : (compose(handlers) as Chain);
  }
  return compose(
    devTrace ? [...appMiddleware, markRouteReached, ...handlers] : [...appMiddleware, ...handlers],
  ) as Chain;
};
