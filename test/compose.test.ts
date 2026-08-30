/**
 * Composition semantics: precompiled levels, the dual-mode commit rules
 * (docs/v2-DESIGN.md §4), double-next guard and misuse detection.
 */

import { describe, expect, it } from "vitest";

import { compose, direct, NOOP_TAIL, type MiddlewareContext } from "../src/core/compose.ts";

interface TestCtx extends MiddlewareContext {
  log: string[];
}

const ctx = (): TestCtx => ({ state: Object.create(null), _res: undefined, log: [] });

describe("compose: execution order", () => {
  it("runs levels outside-in and inside-out around next()", async () => {
    const c = ctx();
    const run = compose<TestCtx>([
      async (c, next) => {
        c.log.push("1-before");
        await next();
        c.log.push("1-after");
      },
      async (c, next) => {
        c.log.push("2-before");
        await next();
        c.log.push("2-after");
      },
    ]);
    await run(c, NOOP_TAIL);
    expect(c.log).toEqual(["1-before", "2-before", "2-after", "1-after"]);
  });

  it("a fully synchronous chain settles without a single promise", () => {
    const c = ctx();
    const run = compose<TestCtx>([
      (c, next) => {
        c.log.push("a");
        return next();
      },
      (c) => {
        c.log.push("b");
      },
    ]);
    const settled = run(c, NOOP_TAIL);
    expect(settled).toBeUndefined(); // no promise allocated on the sync path
    expect(c.log).toEqual(["a", "b"]);
  });

  it("double next() in the same middleware throws", async () => {
    const c = ctx();
    const run = compose<TestCtx>([
      async (_c, next) => {
        await next();
        await next();
      },
    ]);
    await expect(run(c, NOOP_TAIL)).rejects.toThrow("next() called multiple times");
  });

  it("non-function middleware rejects at composition time", () => {
    expect(() => compose([undefined as unknown as () => void])).toThrow(TypeError);
  });
});

describe("compose: dual-mode commit rules", () => {
  it("rule 1 — a leaf Response return commits", async () => {
    const c = ctx();
    const run = compose<TestCtx>([() => new Response("leaf")]);
    await run(c, NOOP_TAIL);
    expect(c._res?.status).toBe(200);
  });

  it("rule 1 — returning BEFORE next() short-circuits the downstream", async () => {
    const c = ctx();
    const run = compose<TestCtx>([
      () => new Response("blocked", { status: 403 }),
      (c) => {
        c.log.push("never");
      },
    ]);
    await run(c, NOOP_TAIL);
    expect(c.log).toEqual([]);
    expect(c._res?.status).toBe(403);
  });

  it("rule 2 — returning AFTER next() overrides the downstream response", async () => {
    const c = ctx();
    const run = compose<TestCtx>([
      async (_c, next) => {
        await next();
        return new Response("outer", { status: 201 });
      },
      () => new Response("inner"),
    ]);
    await run(c, NOOP_TAIL);
    expect(c._res?.status).toBe(201);
    expect(await (c._res as Response).text()).toBe("outer");
  });

  it("rule 3 — an undefined middleware return keeps the downstream response", async () => {
    const c = ctx();
    const run = compose<TestCtx>([
      async (_c, next) => {
        await next();
      },
      () => new Response("inner"),
    ]);
    await run(c, NOOP_TAIL);
    expect(await (c._res as Response).text()).toBe("inner");
  });

  it("rule 4 — a custom thenable return is a loud TypeError", async () => {
    const c = ctx();
    // The thenable is the point of the test — constructing one on purpose.
    // eslint-disable-next-line unicorn/no-thenable
    const thenable: Record<string, unknown> = { then: () => undefined };
    const run = compose<TestCtx>([() => thenable as unknown as Response]);
    // The sync path throws synchronously; the promise path would reject.
    expect(() => run(c, NOOP_TAIL)).toThrow("await it inside the handler");
  });

  it("a returned promise resolves as the handler's own async result", async () => {
    const c = ctx();
    // A genuine promise return is indistinguishable from an async handler
    // and commits normally — the misuse check only targets custom thenables.
    const run = compose<TestCtx>([
      () => Promise.resolve(new Response("x", { status: 299 })) as unknown as Response,
    ]);
    await run(c, NOOP_TAIL);
    expect(c._res?.status).toBe(299);
  });

  it("rule 4 — a rejected-promise-returning handler surfaces the rejection", async () => {
    const c = ctx();
    const run = compose<TestCtx>([
      async () => Promise.reject(new Error("bad")) as unknown as Promise<Response>,
    ]);
    await expect(run(c, NOOP_TAIL)).rejects.toThrow("bad");
  });

  it("rule 4 — non-Response returns throw synchronously (misuse detection)", () => {
    const c = ctx();
    const run = compose<TestCtx>([() => "oops" as unknown as Response]);
    expect(() => run(c, NOOP_TAIL)).toThrow("only Response, undefined or null");
  });
});

describe("direct: single-handler fast path", () => {
  it("commits a Response return without any wrapper level", async () => {
    const c = ctx();
    const run = direct<TestCtx>(() => new Response("solo", { status: 202 }));
    await run(c, NOOP_TAIL);
    expect(c._res?.status).toBe(202);
  });

  it("leaves the slot untouched on a void return", async () => {
    const c = ctx();
    const run = direct<TestCtx>(() => undefined);
    await run(c, NOOP_TAIL);
    expect(c._res).toBeUndefined();
  });

  it("propagates sync throws to the caller", () => {
    const c = ctx();
    const run = direct<TestCtx>(() => {
      throw new Error("bang");
    });
    expect(() => run(c, NOOP_TAIL)).toThrow("bang");
  });
});
