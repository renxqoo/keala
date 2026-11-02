import { registerBranch } from "../core/branches.ts";
import type { RouteHandler } from "../router/router.ts";
import { discardBody } from "../utils/streams.ts";

function discardReplacedResponse(
  response: Response | undefined,
  retained: Response | undefined,
  committed: Response | undefined,
): void {
  if (response === undefined || response === retained || response === committed) return;
  try {
    if (response.body === retained?.body || response.body === committed?.body) return;
  } catch {
    return discardBody(response);
  }
  discardBody(response);
}

export const some = (...candidates: readonly RouteHandler[]): RouteHandler => {
  return async (c, next) => {
    let advanced = false;
    const guardedNext = (): Promise<void> => {
      if (advanced) throw new Error("next() called multiple times in the same middleware");
      advanced = true;
      return next();
    };
    let rejection: Response | undefined;
    let retained: Response | undefined;
    let failure: unknown;
    let failed = false;
    try {
      for (const candidate of candidates) {
        try {
          const result = await candidate(c, guardedNext);
          if (result instanceof Response) {
            if (advanced || result.status < 400) return (retained = result);
            discardReplacedResponse(rejection, result, c._res);
            rejection = result;
            failed = false;
            continue;
          }
          if (advanced) return;
        } catch (error) {
          if (advanced) throw error;
          failure = error;
          failed = true;
        }
      }
      if (failed) throw failure;
      if (rejection !== undefined) return (retained = rejection);
      await next();
    } finally {
      discardReplacedResponse(rejection, retained, c._res);
    }
  };
};

export const all = (...candidates: readonly RouteHandler[]): RouteHandler => {
  return async (c, next) => {
    const run = async (index: number): Promise<Response | undefined> => {
      const handler = candidates[index];
      if (handler === undefined) {
        await next();
        return undefined;
      }
      let advanced = false;
      let settled = false;
      let branchLive = false;
      let pending: Promise<void> | undefined;
      let downstream: Response | undefined;
      let retained: Response | undefined;
      const innerNext = (): Promise<void> => {
        if (advanced) throw new Error("next() called multiple times in the same middleware");
        advanced = true;
        branchLive = true;
        pending = run(index + 1).then(
          (answered) => {
            branchLive = false;
            downstream = answered;
            if (settled) discardReplacedResponse(answered, retained, c._res);
          },
          (error) => {
            branchLive = false;
            throw error;
          },
        );
        void pending.catch(() => undefined);
        return pending;
      };
      try {
        const result = await handler(c, innerNext);
        retained = result instanceof Response ? result : downstream;
        return retained;
      } finally {
        settled = true;
        if (branchLive && pending !== undefined) registerBranch(c, pending);
        discardReplacedResponse(downstream, retained, c._res);
      }
    };
    return run(0);
  };
};
