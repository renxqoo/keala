/**
 * Outstanding onion branches — the floating `next()` bookkeeping shared by
 * compose and the guarded pool.
 *
 * A middleware that calls `next()` WITHOUT awaiting it leaves a downstream
 * branch running past its own return. The branch still holds the request's
 * context, so a pooled context must not be recycled (handed to the next
 * request) while any observed branch can still mutate it. Registration is
 * deliberately cheap and rare: compose registers a branch ONLY on the
 * detectable floating shape (a level returning synchronously after calling
 * next); a branch floated inside an async handler that settles first is
 * beyond static detection and stays the caller's responsibility.
 */

const BRANCHES = Symbol("bun-koa.branches");

type BranchHost = { [BRANCHES]?: Promise<unknown>[] };

/** Record a floating downstream branch on its request host. */
export const registerBranch = (host: object, branch: Promise<unknown>): void => {
  const holder = host as BranchHost;
  if (holder[BRANCHES] === undefined) holder[BRANCHES] = [branch];
  else (holder[BRANCHES] as Promise<unknown>[]).push(branch);
};

/** Drop the branch list (context reuse resets it with the rest of the state). */
export const clearBranches = (host: object): void => {
  delete (host as BranchHost)[BRANCHES];
};

/**
 * Promise settling when every registered branch has settled (rejections
 * included — compose already observes them). null when nothing is pending,
 * so the hot path stays synchronous.
 */
export const drainBranches = (host: object): Promise<void> | null => {
  const branches = (host as BranchHost)[BRANCHES];
  if (branches === undefined || branches.length === 0) return null;
  return Promise.all(
    branches.map((branch) =>
      branch.then(
        () => undefined,
        () => undefined,
      ),
    ),
  ).then(() => undefined);
};
