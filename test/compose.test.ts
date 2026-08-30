import { describe, expect, it } from "vitest";

import { compose, NOOP_TAIL, type Middleware } from "../src/application/compose.ts";

interface TestCtx {
  state: Record<string, unknown>;
}

const recorder = (): { order: string[]; track: (label: string) => void } => {
  const order: string[] = [];
  return { order, track: (label: string) => order.push(label) };
};

const doubleNext: Middleware<TestCtx> = async (_ctx, next) => {
  await next();
  await next();
};

describe("compose", () => {
  it("executes middleware in onion order", async () => {
    const { order, track } = recorder();
    const a: Middleware<TestCtx> = async (_ctx, next) => {
      track("a:before");
      await next();
      track("a:after");
    };
    const b: Middleware<TestCtx> = async (_ctx, next) => {
      track("b:before");
      await next();
      track("b:after");
    };
    const chain = compose<TestCtx>([a, b]);
    await chain({ state: {} }, NOOP_TAIL);
    expect(order).toEqual(["a:before", "b:before", "b:after", "a:after"]);
  });

  it("supports synchronous middleware", async () => {
    const { order, track } = recorder();
    const chain = compose<TestCtx>([
      (_ctx, next) => {
        track("sync:before");
        return next();
      },
      async () => {
        track("core");
      },
    ]);
    await chain({ state: {} }, NOOP_TAIL);
    expect(order).toEqual(["sync:before", "core"]);
  });

  it("rejects non-function middleware", () => {
    expect(() => compose([undefined as unknown as Middleware<TestCtx>])).toThrow(TypeError);
    expect(() => compose([42 as unknown as Middleware<TestCtx>])).toThrow(
      "Middleware must be composed of functions",
    );
  });

  it("throws when next() is called twice in the same middleware", async () => {
    const chain = compose<TestCtx>([doubleNext, async () => {}]);
    await expect(chain({ state: {} }, NOOP_TAIL)).rejects.toThrow(
      "next() called multiple times in the same middleware",
    );
  });

  it("passes the tail straight through a single-middleware chain", async () => {
    let tailCalls = 0;
    const seen: string[] = [];
    const chain = compose<TestCtx>([
      async (ctx, next) => {
        seen.push(`mid:${Object.keys(ctx.state).length}`);
        await next();
      },
    ]);
    await chain({ state: {} }, async () => {
      tailCalls += 1;
    });
    expect(tailCalls).toBe(1);
    expect(seen).toEqual(["mid:0"]);
  });

  it("propagates upstream errors through the chain", async () => {
    const sawError: string[] = [];
    const chain = compose<TestCtx>([
      async (_ctx, next) => {
        try {
          await next();
        } catch (err) {
          sawError.push((err as Error).message);
          throw err;
        }
      },
      async () => {
        throw new Error("boom");
      },
    ]);
    await expect(chain({ state: {} }, NOOP_TAIL)).rejects.toThrow("boom");
    expect(sawError).toEqual(["boom"]);
  });

  it("runs the tail when the stack is empty", async () => {
    let tailRan = false;
    const chain = compose<TestCtx>([]);
    await chain({ state: {} }, async () => {
      tailRan = true;
    });
    expect(tailRan).toBe(true);
  });

  it("invokes the tail exactly once after all middleware", async () => {
    let tailCount = 0;
    const chain = compose<TestCtx>([
      async (_ctx, next) => {
        await next();
      },
    ]);
    await chain({ state: {} }, async () => {
      tailCount += 1;
    });
    expect(tailCount).toBe(1);
  });

  it("guards nested chains independently (router pattern)", async () => {
    const { order, track } = recorder();
    const inner = compose<TestCtx>([
      async (_ctx, next) => {
        track("inner");
        await next();
      },
    ]);
    const outer = compose<TestCtx>([
      async (_ctx, next) => {
        track("outer:before");
        await inner({ state: {} }, next);
        track("outer:after");
      },
    ]);
    await outer({ state: {} }, NOOP_TAIL);
    expect(order).toEqual(["outer:before", "inner", "outer:after"]);
  });

  it("awaits async work between layers", async () => {
    const stamps: number[] = [];
    const chain = compose<TestCtx>([
      async (_ctx, next) => {
        stamps.push(1);
        await next();
        stamps.push(3);
      },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        stamps.push(2);
      },
    ]);
    await chain({ state: {} }, NOOP_TAIL);
    expect(stamps).toEqual([1, 2, 3]);
  });
});
