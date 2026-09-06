/**
 * Conditional middleware composition — run a group of middleware as ONE.
 *
 * - `some()`: try the candidates in order; the first one that lets the
 *   request through (calls `next()`) or answers it with a success/redirect
 *   wins. A 4xx/5xx self-answer is a "no" — the next candidate is tried,
 *   and only when every candidate refuses is the LAST refusal returned.
 *   `some(bearerAuth(...), apiKeyAuth(...))` (either credential passes) is
 *   the canonical use.
 * - `all()`: run every candidate as a single onion (keala compose
 *   semantics); the first self-answer short-circuits the rest of the group.
 *
 * keala's auth middleware REJECT by returning a 4xx Response (they do not
 * throw, unlike hono's) — so `some()` maps a returned error answer onto
 * hono's "throw and fall through" behavior instead of short-circuiting on
 * the first Response it sees.
 */

import type { RouteHandler } from "../router/router.ts";

/** The double-next guard message, kept identical to core compose's. */
const NEXT_TWICE = "next() called multiple times in the same middleware";

/**
 * Try each candidate in order; the first decisive one wins.
 *
 * - A candidate that calls `next()` passes the whole downstream through —
 *   it wins (and the downstream runs exactly once, ever).
 * - A candidate that returns a <400 Response by itself (a cache hit, a
 *   redirect) handled the request — that answer is final.
 * - A candidate that returns a 4xx/5xx Response by itself rejected the
 *   request — remember it and try the next candidate.
 * - A candidate that throws without having called `next()` is treated like
 *   a rejection; an error after `next()` surfaces (the downstream already
 *   ran — retrying it would double side effects).
 * - Nobody decided (every candidate passed through, or none was given):
 *   call `next()` — an empty `some()` is a plain pass-through.
 *
 * @example
 * ```ts
 * import { some } from "keala/middleware";
 * // Either credential passes:
 * app.use(some(bearerAuth({ token }), apiKeyAuth({ keys: ["k1"] })));
 * ```
 */
export const some = (...candidates: readonly RouteHandler[]): RouteHandler => {
  return async (c, next) => {
    let advanced = false;
    const guardedNext = (): Promise<void> => {
      if (advanced) throw new Error(NEXT_TWICE);
      advanced = true;
      return next();
    };
    let rejection: Response | undefined;
    let failure: unknown;
    let failed = false;
    for (const candidate of candidates) {
      try {
        const result = await candidate(c, guardedNext);
        if (result instanceof Response) {
          // Answered after passing downstream (a rewrite) — or handled the
          // request outright with a success/redirect. Either way: final.
          if (advanced || result.status < 400) return result;
          rejection = result; // a 4xx/5xx self-answer is a "no" — keep trying
          failed = false;
          continue;
        }
        // Passed via next(): the downstream owns the answer.
        if (advanced) return;
        // Neither answered nor advanced (a pure condition) — next candidate.
      } catch (error) {
        if (advanced) throw error;
        failure = error;
        failed = true;
      }
    }
    if (failed) throw failure;
    if (rejection !== undefined) return rejection;
    await next();
  };
};

/**
 * Run every candidate as one onion — `all(a, b)` behaves exactly like
 * registering `a` then `b`: a's pre-work, b's pre-work, the downstream,
 * then the post-work in reverse. A candidate that answers by itself (a
 * rejection, a redirect) short-circuits the rest of the group, and the
 * answer is returned so it is committed — a later candidate's refusal can
 * never fall through to a silent 404.
 *
 * @example
 * ```ts
 * import { all, some } from "keala/middleware";
 * app.use(all(secureHeaders(), some(bearerAuth(...), apiKeyAuth(...))));
 * ```
 */
export const all = (...candidates: readonly RouteHandler[]): RouteHandler => {
  return async (c, next) => {
    // Depth-first runner: candidate i's next() runs candidate i+1; the tail
    // is the group's own next(). Returns the first self-answered Response
    // from depth >= i so the group commits it (last-committer-wins order —
    // an outer candidate's own answer still overrides a deeper one).
    const run = async (i: number): Promise<Response | undefined> => {
      if (i === candidates.length) {
        await next();
        return undefined;
      }
      const handler = candidates[i] as RouteHandler;
      let advanced = false;
      let downstream: Response | undefined;
      const innerNext = (): Promise<void> => {
        if (advanced) throw new Error(NEXT_TWICE);
        advanced = true;
        return run(i + 1).then((answered) => {
          downstream = answered;
        });
      };
      const result = await handler(c, innerNext);
      return result instanceof Response ? result : downstream;
    };
    const answer = await run(0);
    if (answer !== undefined) return answer;
  };
};
