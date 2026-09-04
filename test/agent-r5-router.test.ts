/**
 * Round-5 router/matching-engine audit — CONFIRMED-BUG red tests plus
 * "locks correct behavior" green tests.
 *
 * Every `it()` in a CONFIRMED-BUG describe asserts the CORRECT behavior and
 * FAILS against the current src/. Ledger:
 *
 * R5-1  HIGH   src/router/router.ts:193-215 (bindDef + chainOf)
 *        A duplicate path+method registration composes
 *        `compose([previous, chain])` where BOTH chains already embed the
 *        app's global middleware (chainOf prepends globalMw to every route
 *        chain). When the first layer's handler calls next(), execution
 *        re-enters the global middleware: app.use() middleware runs TWICE
 *        (three times for a triple registration) for one request. koa's
 *        observable contract (and this framework's own pipeline design) is
 *        that app.use() middleware runs exactly once per request — only the
 *        route layers chain (@koa/router runs every matching layer).
 * R5-2  MEDIUM src/router/trie.ts:128-136 (matchPattern end-of-path branch)
 *        The empty-wildcard capture is gated on `path.length > 1 &&
 *        path.endsWith("/")`, so the ROOT wildcard `/*` never matches "/"
 *        even though buildURL emits exactly "/" for { wildcard: "" } — the
 *        same round-trip contract R3-8 fixed for "/w/*" (which does answer
 *        "/w/"). Express (`app.get('*')`) and Hono (`app.get('*', ...)`)
 *        both serve "/" from a root wildcard; `/:x?` at the root answers
 *        "/" here too. Only the root wildcard is excluded.
 * R5-3  MEDIUM src/router/router.ts:438-448 (assertRedirectCaptures)
 *        `available` is built from paramNamesOf(), which INCLUDES optional
 *        params. A redirect whose destination requires `:x` therefore passes
 *        registration when the source only captures `:x` OPTIONALLY — and
 *        the request where the param is absent then throws inside buildURL
 *        as a per-request 500. This is exactly the eager-validation
 *        violation that function's doc comment promises cannot happen
 *        ("a missing required param would explode as a per-request 500 …
 *        Checked at registration" — the R3-7 contract).
 * R5-4  MEDIUM src/core/app.ts:360-385 (mount loop) +
 *        src/core/dispatch.ts:133-141 (mergeMountedWs)
 *        `app.mount(prefix, subApp)` forwards only `subApp.globalMiddleware`
 *        as prefixMiddleware. A def that already carries `prefixMiddleware`
 *        (baked when the SUB-APP itself mounted a router) has it silently
 *        dropped — remounting an app one level deeper loses the inner
 *        routers' `use()` middleware. Control facts asserted in-file: the
 *        sub-app's own global middleware and the merged param middleware
 *        both survive remount; only def.prefixMiddleware disappears.
 *
 * Open questions / design freedom (NOT red-tested — see the audit report):
 * registration "//" and "/a///" silently normalize to "/" and "/a" while
 * "/a//b" throws; url() with an empty-string param value emits an
 * unmatchable "/a//b" (express behaves the same); a redirect destination
 * carrying "*" without ":" is used verbatim; parent app.param wins over a
 * mounted router's param for the same name; Router does not validate
 * method names until mount; ALL routes answer truly-unknown methods with
 * the handler instead of 501; "OPTIONS *" server-wide behavior is
 * runtime-dependent; "/w//" yields an absent wildcard param while "/w/"
 * yields "".
 */

import { describe, expect, it } from "vitest";

import { Keala } from "../src/core/app.ts";
import { Router } from "../src/router/group.ts";

const quiet = { env: "test" } as const;
const req = (path: string, init?: RequestInit) => new Request(`http://localhost:3000${path}`, init);

// ---------------------------------------------------------------------------
// R5-1 — duplicate path+method re-runs global middleware
// ---------------------------------------------------------------------------

describe("R5-1 CONFIRMED-BUG: duplicate path+method registration re-runs app.use middleware", () => {
  it("global middleware runs exactly once for a doubly-registered route", async () => {
    const app = new Keala(quiet);
    let globals = 0;
    app.use((_c, next) => {
      globals++;
      return next();
    });
    app.get("/dup", async (_c, next) => {
      await next();
    });
    app.get("/dup", (c) => c.text("second"));
    await app.handle(req("/dup"));
    // koa contract: app.use middleware runs once per request; only the
    // matching route layers chain (@koa/router semantics).
    expect(globals).toBe(1);
  });

  it("execution order is global > layer1 > layer2 with a single global pass", async () => {
    const app = new Keala(quiet);
    const order: string[] = [];
    app.use(async (_c, next) => {
      order.push("global");
      await next();
    });
    app.get("/dup", async (_c, next) => {
      order.push("first");
      await next();
    });
    app.get("/dup", (c) => {
      order.push("second");
      return c.text("done");
    });
    const res = await app.handle(req("/dup"));
    expect(res.status).toBe(200);
    expect(order).toEqual(["global", "first", "second"]);
  });

  it("still doubles after a rebuild (app.use registered after the duplicates)", async () => {
    const app = new Keala(quiet);
    let globals = 0;
    app.get("/dup", async (_c, next) => {
      await next();
    });
    app.get("/dup", (c) => c.text("second"));
    // Late middleware re-composes every route chain — the duplicate nesting
    // is rebuilt from the raw defs and must still embed the global once.
    app.use((_c, next) => {
      globals++;
      return next();
    });
    await app.handle(req("/dup"));
    expect(globals).toBe(1);
  });

  it("a route registered via mount() and again directly doubles the global too", async () => {
    const app = new Keala(quiet);
    let globals = 0;
    app.use((_c, next) => {
      globals++;
      return next();
    });
    const sub = new Router();
    sub.get("/x", async (_c, next) => {
      await next();
    });
    app.mount("/api", sub);
    app.get("/api/x", (c) => c.text("direct"));
    await app.handle(req("/api/x"));
    expect(globals).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// R5-2 — root wildcard `/*` never matches "/"
// ---------------------------------------------------------------------------

describe("R5-2 CONFIRMED-BUG: root wildcard '/*' does not match '/'", () => {
  it("app.get('/*') answers GET / (express/hono semantics; '/*' is the catch-all)", async () => {
    const app = new Keala(quiet);
    app.get("/*", (c) => c.text(`w:${c.params?.["wildcard"] ?? ""}`));
    const res = await app.handle(req("/"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("w:");
  });

  it("url() output for an empty root wildcard round-trips", async () => {
    const app = new Keala(quiet);
    app.get("w", "/*", (c) => c.text(`w:${c.params?.["wildcard"] ?? ""}`));
    const url = app.url("w", { wildcard: "" }); // buildURL emits "/"
    expect(url).toBe("/");
    const res = await app.handle(req(url));
    expect(res.status).toBe(200);
  });

  it("a static '/' route still wins over the root wildcard (priority unchanged)", async () => {
    const app = new Keala(quiet);
    app.get("/*", (c) => c.text("wild"));
    app.get("/", (c) => c.text("root"));
    const res = await app.handle(req("/"));
    expect(await res.text()).toBe("root");
  });
});

// ---------------------------------------------------------------------------
// R5-3 — redirect with optional source param explodes per-request
// ---------------------------------------------------------------------------

describe("R5-3 CONFIRMED-BUG: redirect destination requires a param the source only captures optionally", () => {
  it("registration must throw (eager validation — the param can be absent at runtime)", () => {
    const app = new Keala(quiet);
    // "/o" (no :x captured) would otherwise 500 inside buildURL per request.
    expect(() => app.redirect("/o/:x?", "/n/:x", 302)).toThrow();
  });

  it("mid-pattern optional source params are covered by the same contract", () => {
    const app = new Keala(quiet);
    expect(() => app.redirect("/a/:x?/b", "/c/:x", 302)).toThrow();
  });

  it("locks correct: an optional destination param needs no such guarantee", () => {
    const app = new Keala(quiet);
    expect(() => app.redirect("/o/:x?", "/n/:x?", 302)).not.toThrow();
  });

  it("locks correct: a required source param satisfies a required destination param", () => {
    const app = new Keala(quiet);
    expect(() => app.redirect("/o/:x", "/n/:x", 302)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// R5-4 — remounting an app drops inner routers' use() middleware
// ---------------------------------------------------------------------------

describe("R5-4 CONFIRMED-BUG: nested mount drops the inner router's use() middleware", () => {
  const innerRouter = () => {
    const inner = new Router();
    inner.use(async (c, next) => {
      c.setHeader("X-Inner", "1");
      await next();
    });
    inner.get("/leaf", (c) => c.text("leaf"));
    return inner;
  };

  it("the inner middleware runs through the middle app (control)", async () => {
    const mid = new Keala(quiet);
    mid.mount("/r", innerRouter());
    const res = await mid.handle(req("/r/leaf"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-inner")).toBe("1");
  });

  it("the inner middleware must survive remounting the middle app", async () => {
    const app = new Keala(quiet);
    const mid = new Keala(quiet);
    mid.mount("/r", innerRouter());
    app.mount("/b", mid);
    const res = await app.handle(req("/b/r/leaf"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-inner")).toBe("1");
  });

  it("three levels deep: the innermost use() middleware must still run", async () => {
    const app = new Keala(quiet);
    const leaf = new Router();
    leaf.use(async (c, next) => {
      c.setHeader("X-Leaf", "1");
      await next();
    });
    leaf.get("/x", (c) => c.text("x"));
    const mid1 = new Keala(quiet);
    mid1.mount("/m1", leaf);
    const mid2 = new Keala(quiet);
    mid2.mount("/m2", mid1);
    app.mount("/top", mid2);
    const res = await app.handle(req("/top/m2/m1/x"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-leaf")).toBe("1");
  });

  it("locks correct: the middle app's own global middleware and inner param middleware survive remount", async () => {
    const app = new Keala(quiet);
    const inner = new Router();
    inner.param("id", async (c, next) => {
      c.setHeader("X-Param", c.params?.["id"] ?? "");
      await next();
    });
    inner.get("/i/:id", (c) => c.text("i"));
    const mid = new Keala(quiet);
    mid.use(async (c, next) => {
      c.setHeader("X-Mid", "1");
      await next();
    });
    mid.mount("/r", inner);
    app.mount("/b", mid);
    const res = await app.handle(req("/b/r/i/7"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-mid")).toBe("1");
    expect(res.headers.get("x-param")).toBe("7");
  });
});

// ---------------------------------------------------------------------------
// locks correct behavior — these MUST stay green
// ---------------------------------------------------------------------------
