import { describe, expect, it } from "vitest";

import { Keala } from "../../src/core/app.ts";
import { all, some } from "../../src/middleware/combine.ts";
import type { RouteHandler } from "../../src/router/router.ts";
/**
 * combine component tests: `some()` (first candidate that lets the request
 * through wins; a 4xx/5xx self-answer is a "no" — the multi-auth shape) and
 * `all()` (one onion over every candidate; a self-answer short-circuits).
 * Trace arrays pin execution order and that downstream runs exactly once.
 */

const quiet = { env: "test" } as const;
const req = (path: string, init?: RequestInit) => new Request(`http://localhost:3000${path}`, init);

/** Passes downstream through, THEN throws — the "error after next()" shape. */
const afterNext: RouteHandler = async (_c, next) => {
  await next();
  throw new Error("after-next");
};

/** Calls next() twice — the double-advance bug core compose also rejects. */
const nextTwice: RouteHandler = async (_c, next) => {
  await next();
  await next();
};

/** Per-test harness: label-tracing candidate middlewares + a guarded app. */
const scenario = () => {
  const trace: string[] = [];
  /** Records its label, then calls next() — the "pass" candidate. */
  const pass =
    (label: string): RouteHandler =>
    async (_c, next) => {
      trace.push(label);
      await next();
    };
  /** Records its label and self-answers an error status without next(). */
  const deny =
    (label: string, status = 401): RouteHandler =>
    async (c) => {
      trace.push(label);
      return c.text(label, status);
    };
  /** Records its label and self-answers 200 without next() (cache-hit shape). */
  const serve =
    (label: string): RouteHandler =>
    async (c) => {
      trace.push(label);
      return c.text(label, 200);
    };
  /** Records its label and throws. */
  const boom =
    (label: string): RouteHandler =>
    async () => {
      trace.push(label);
      throw new Error(label);
    };
  const appOf = (guard: RouteHandler): Keala => {
    const app = new Keala(quiet);
    app.use(guard);
    app.get("/x", (c) => {
      trace.push("route");
      return c.text("ok");
    });
    return app;
  };
  return { trace, pass, deny, serve, boom, appOf };
};

describe("some()", () => {
  it("lets the request through when both candidates pass (first passer wins)", async () => {
    const s = scenario();
    const res = await s.appOf(some(s.pass("a"), s.pass("b"))).handle(req("/x"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    // "b" never runs — the downstream must not execute twice.
    expect(s.trace).toEqual(["a", "route"]);
  });

  it("multi-auth: a rejection falls through to the next candidate", async () => {
    const s = scenario();
    const res = await s.appOf(some(s.deny("no-bearer"), s.pass("api-key"))).handle(req("/x"));
    expect(res.status).toBe(200);
    expect(s.trace).toEqual(["no-bearer", "api-key", "route"]);
  });

  it("returns the LAST rejection when every candidate refuses", async () => {
    const s = scenario();
    const res = await s
      .appOf(some(s.deny("no-bearer", 401), s.deny("no-api-key", 403)))
      .handle(req("/x"));
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("no-api-key");
    expect(s.trace).toEqual(["no-bearer", "no-api-key"]); // the route never ran
  });

  it("a success self-answer (cache-hit shape) wins without touching downstream", async () => {
    const s = scenario();
    const res = await s.appOf(some(s.serve("cached"), s.pass("pass"))).handle(req("/x"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("cached");
    expect(s.trace).toEqual(["cached"]);
  });

  it("treats a thrown error like a rejection — later candidates still run", async () => {
    const s = scenario();
    const res = await s.appOf(some(s.boom("boom"), s.pass("pass"))).handle(req("/x"));
    expect(res.status).toBe(200);
    expect(s.trace).toEqual(["boom", "pass", "route"]);
  });

  it("surfaces the last thrown error when every candidate fails", async () => {
    const s = scenario();
    const res = await s.appOf(some(s.boom("boom-1"), s.boom("boom-2"))).handle(req("/x"));
    expect(res.status).toBe(500);
    expect(s.trace).toEqual(["boom-1", "boom-2"]);
  });

  it("an error thrown AFTER next() surfaces instead of being retried", async () => {
    const s = scenario();
    const res = await s.appOf(some(afterNext, s.pass("pass"))).handle(req("/x"));
    expect(res.status).toBe(500);
    expect(s.trace).toEqual(["route"]); // downstream ran exactly once
  });

  it("empty some() passes straight through", async () => {
    const s = scenario();
    const res = await s.appOf(some()).handle(req("/x"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(s.trace).toEqual(["route"]);
  });

  it("guards against a candidate calling next() twice (compose parity)", async () => {
    const s = scenario();
    const res = await s.appOf(some(nextTwice)).handle(req("/x"));
    expect(res.status).toBe(500);
    expect(s.trace).toEqual(["route"]); // downstream ran once, then the guard threw
  });
});

describe("all()", () => {
  it("runs every candidate as one onion and passes through", async () => {
    const s = scenario();
    const res = await s.appOf(all(s.pass("a"), s.pass("b"))).handle(req("/x"));
    expect(res.status).toBe(200);
    expect(s.trace).toEqual(["a", "b", "route"]);
  });

  it("a rejection from the FIRST candidate short-circuits the group", async () => {
    const s = scenario();
    const res = await s.appOf(all(s.deny("deny"), s.pass("b"))).handle(req("/x"));
    expect(res.status).toBe(401);
    // Neither the second candidate nor the route ran.
    expect(s.trace).toEqual(["deny"]);
  });

  it("a rejection from a LATER candidate still answers (no silent 404)", async () => {
    const s = scenario();
    const res = await s.appOf(all(s.pass("a"), s.deny("deny", 403))).handle(req("/x"));
    expect(res.status).toBe(403);
    expect(s.trace).toEqual(["a", "deny"]); // the route never ran
  });

  it("empty all() passes straight through", async () => {
    const s = scenario();
    const res = await s.appOf(all()).handle(req("/x"));
    expect(res.status).toBe(200);
    expect(s.trace).toEqual(["route"]);
  });

  it("composes: all() around some() (the secure-headers + multi-auth shape)", async () => {
    const s = scenario();
    const guard = all(s.pass("headers"), some(s.deny("no-bearer"), s.pass("api-key")));
    const res = await s.appOf(guard).handle(req("/x"));
    expect(res.status).toBe(200);
    expect(s.trace).toEqual(["headers", "no-bearer", "api-key", "route"]);
  });

  it("guards against a candidate calling next() twice (compose parity)", async () => {
    const s = scenario();
    const res = await s.appOf(all(nextTwice)).handle(req("/x"));
    expect(res.status).toBe(500);
    expect(s.trace).toEqual(["route"]);
  });
});
