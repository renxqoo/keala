/**
 * Red-team audit locks (final verification) — read-only audit, no src changes.
 *
 * `it("CONFIRMED-BUG(now fixed) (RT-n): ...")` cases are reproduced defects, locked in
 * the skip state with the EXPECTED-CORRECT assertion inside. Unskip after fixing;
 * each turns into a regression lock. Every block comment carries the ledger:
 * repro / expect / actual / root cause (file:line).
 *
 * The green cases here are properties the audit attacked and could not break —
 * most notably the router equivalence fuzz (GA-1): matchRoute (staticMap + fast
 * matcher + trie) vs the pure trie, the router's own source of truth.
 *
 * Ledger summary (severity ordered; details in each block):
 *   RT-1 CRITICAL  fast matcher ignores static segments after params (router.ts fastMatch)
 *   RT-2 HIGH      HEAD x committed x deferred headers returns a body (respond.ts finalize)
 *   RT-3 HIGH      notFound-handler throw escapes app.handle w/o global middleware (app.ts)
 *   RT-4 HIGH      c.body = Response collapses multi set-cookie (response.ts body setter)
 *   RT-5 HIGH      sugar helpers corrupt multi-value headers (response.ts text/json/html)
 *   RT-6 MEDIUM    decorate() leaks into every app's contexts (app.ts / context.ts)
 *   RT-7 MEDIUM    app.mount(prefix, app) self-mount hangs forever (app.ts mount)
 *   RT-8 LOW       floating next() rejection becomes a process unhandledRejection
 *   RT-9  HIGH     encoded static segments bypass staticMap -> 404 / wildcard steal
 *   RT-10 MEDIUM   sugar text/json/html discard a previously set c.status
 *   RT-11 LOW      HEAD x custom notFound handler loses the CL backfill
 *
 * Companion green assets: test/redteam-assets.test.ts (e2e fuzz) and
 * test/redteam-round2.test.ts (full-shape internal fuzz, concurrency,
 * leak, security) — split for the oxlint max-lines: 500 budget.
 */

import { describe, expect, it } from "vitest";

import { Eleu, Router } from "../src/index.ts";
import { compilePattern } from "../src/router/pattern.ts";
import { createRouterState, matchRoute, registerDef } from "../src/router/router.ts";
import { createNode, createTarget, insertPattern, matchPattern } from "../src/router/trie.ts";

const quiet = { env: "test", silent: true } as const;
const req = (url: string, init: RequestInit = {}): Request => new Request(url, init);
const text = async (res: Response): Promise<string> => res.text();
// ---------------------------------------------------------------------------
// RT-1 (CRITICAL): the bucket fast matcher ignores static segments that follow
// a parameter. A single-param pattern with a static tail (`/users/:id/posts`)
// matches its own truncated path (`/users/42`); a two-param pattern with a
// static between/after params (`/admin/:a/items/:b`) matches when the tail is
// missing and hoists the static itself into a param value (`b:"items"`).
//
// Repro:    register `/users/:id/posts` (GET) -> request `/users/42` -> 200 {id:"42"}
//           register `/admin/:a/items/:b` -> request `/admin/1/items` -> 200 {a:"1",b:"items"}
//           register `/users/:id/posts` (POST only) -> GET `/users/42` -> 405 + Allow: POST
// Expect:   404 in all three cases; params never absorb static segments.
// Actual:   200 with polluted params / 405 with a bogus Allow.
// Root:     src/router/router.ts fastMatch (single-param branch L255-262 and
//           multi-param branch L263-272) verifies only the leading static head
//           (staticHeadOf) and the param count — never the static segments AFTER
//           the first dynamic one. Contributing: src/router/pattern.ts isSimple
//           (L90-100) does not require dynamic segments to be suffix-positioned,
//           so these shapes still earn a fast matcher they cannot fulfill.
// ---------------------------------------------------------------------------

describe("redteam — RT-1 fast matcher ignores static tail after params", () => {
  it("CONFIRMED-BUG(now fixed) (RT-1a): /users/:id/posts must not match /users/42", async () => {
    const app = new Eleu(quiet);
    app.get("/users/:id/posts", (c) => c.json({ route: "posts", id: c.params?.["id"] }));
    const res = await app.handle(req("http://localhost/users/42"));
    expect(res.status).toBe(404);
  });

  it("CONFIRMED-BUG(now fixed) (RT-1b): /admin/:a/items/:b must not match /admin/1/items", async () => {
    const app = new Eleu(quiet);
    app.get("/admin/:a/items/:b", (c) => c.json({ a: c.params?.["a"], b: c.params?.["b"] }));
    const res = await app.handle(req("http://localhost/admin/1/items"));
    expect(res.status).toBe(404);
  });

  it("CONFIRMED-BUG(now fixed) (RT-1c): truncated path must not turn 404 into 405+Allow", async () => {
    const app = new Eleu(quiet);
    app.post("/users/:id/posts", (c) => c.text("p"));
    const res = await app.handle(req("http://localhost/users/42"));
    expect(res.status).toBe(404);
    expect(res.headers.get("allow")).toBeNull();
  });

  it("CONFIRMED-BUG(now fixed) (RT-1d): matchRoute must agree with the pure trie (source of truth)", () => {
    // Internal-level comparison, no runtime URL normalization in between.
    const state = createRouterState();
    registerDef(state, "GET", "/users/:id/posts", [() => {}]);
    const root = createNode();
    const terminals = insertPattern(root, compilePattern("/users/:id/posts").segments);
    for (const terminal of terminals) {
      if (terminal.target === null) terminal.target = createTarget();
    }
    expect(matchRoute(state, "/users/42")).toBeNull(); // the trie says null
    expect(matchPattern(root, "/users/42")).toBeNull();
  });

  it("CONFIRMED-BUG(now fixed) (RT-1e): mounted routers inherit the bug (mount /user/:id + /profile)", async () => {
    const app = new Eleu(quiet);
    const sub = new Router();
    sub.get("/profile", (c) => c.text(`uid=${c.params?.["id"]}`));
    app.mount("/user/:id", sub);
    const res = await app.handle(req("http://localhost/user/42")); // "/profile" missing
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// RT-2 (HIGH): for a HEAD request over a committed Response with deferred
// header writes (rule 4 merge), the merged response KEEPS the body and never
// backfills Content-Length. The design doc promises "HEAD 回填 Content-Length
// — koa 全部保留" and respond.ts implements it — but only on the record-empty
// path.
//
// Repo:     HEAD /x, middleware does `await next(); c.set("x-late","1")`,
//           route returns c.text("hello").
// Expect:   body "" and content-length "5" (same as the record-empty path).
// Actual:   body "hello", content-length null.
// Root:     src/core/respond.ts finalize (L246-253): the mergeIntoCommitted
//           branch returns before the committedHead branch, and
//           mergeIntoCommitted itself has no HEAD handling.
// ---------------------------------------------------------------------------

describe("redteam — RT-2 HEAD x committed x deferred headers", () => {
  it("CONFIRMED-BUG(now fixed) (RT-2a): HEAD must drop the body and backfill CL after a late c.set", async () => {
    const app = new Eleu(quiet);
    app.use(async (c, next) => {
      await next();
      c.set("x-late", "1");
    });
    app.get("/x", (c) => c.text("hello"));
    const res = await app.handle(req("http://localhost/x", { method: "HEAD" }));
    expect(await text(res)).toBe("");
    expect(res.headers.get("content-length")).toBe("5");
  });

  it("CONFIRMED-BUG(now fixed) (RT-2b): same via cookies.set after a committed set-cookie", async () => {
    const app = new Eleu(quiet);
    app.use(async (c, next) => {
      await next();
      c.cookies.set("late", "1", { path: "/" });
    });
    app.get("/x", () => new Response("ok", { headers: [["set-cookie", "early=1; Path=/"]] }));
    const res = await app.handle(req("http://localhost/x", { method: "HEAD" }));
    expect(await text(res)).toBe("");
    // R7: the finalizer never reads committed bodies — no derived CL on a
    // hand-built Response; the late cookie still joins the committed one.
    expect(res.headers.get("content-length")).toBeNull();
    expect(res.headers.getSetCookie().sort()).toEqual(["early=1; Path=/", "late=1; Path=/"]);
  });

  it("green: HEAD x committed (no deferred writes) backfills CL and drops the body", async () => {
    const app = new Eleu(quiet);
    app.get("/x", (c) => c.text("hello"));
    const res = await app.handle(req("http://localhost/x", { method: "HEAD" }));
    expect(await text(res)).toBe("");
    expect(res.headers.get("content-length")).toBe("5");
  });

  it("green: HEAD x state-mode backfills CL and drops the body", async () => {
    const app = new Eleu(quiet);
    app.get("/s", (c) => {
      c.set("x-a", "1");
      c.body = "hello";
    });
    const res = await app.handle(req("http://localhost/s", { method: "HEAD" }));
    expect(await text(res)).toBe("");
    expect(res.headers.get("content-length")).toBe("5");
    expect(res.headers.get("x-a")).toBe("1");
  });
});

// ---------------------------------------------------------------------------
// RT-3 (HIGH): a throwing notFound handler escapes app.handle as a thrown
// exception whenever the app has NO global middleware — the finalizer promise
// ("can never throw past app.handle", respond.ts L243-245) only holds on the
// dispatchChain path; the `globalChain === null` shortcut calls finalize bare.
//
// Repro:    app without app.use(), notFound handler throws (or c.throw, or an
//           invalid c.set) -> any unmatched request.
// Expect:   a 500 Response (like the with-global-middleware case, green below).
// Actual:   app.handle rejects with the raw error — under Bun.serve the fetch
//           handler throws and the runtime's default handling kicks in.
// Root:     src/core/app.ts handle (L434 `if (globalChain === null) return
//           finalize(app, c);`) — no errorResponse wrapper; src/core/respond.ts
//           finalize L259 calls app.notFoundHandler(c) unguarded.
// ---------------------------------------------------------------------------

describe("redteam — RT-3 notFound throw escapes app.handle", () => {
  it("CONFIRMED-BUG(now fixed) (RT-3a): throwing notFound handler must answer 500, not reject", async () => {
    const app = new Eleu(quiet);
    app.get("/a", (c) => c.text("a"));
    app.notFound(() => {
      throw new Error("nf-boom");
    });
    const res = await app.handle(req("http://localhost/missing"));
    expect(res.status).toBe(500);
  });

  it("CONFIRMED-BUG(now fixed) (RT-3b): c.throw inside notFound must answer 404, not reject", async () => {
    const app = new Eleu(quiet);
    app.get("/a", (c) => c.text("a"));
    app.notFound((c) => {
      c.throw(404, "custom nf");
    });
    const res = await app.handle(req("http://localhost/missing"));
    expect(res.status).toBe(404);
    expect(await text(res)).toBe("custom nf");
  });

  it("CONFIRMED-BUG(now fixed) (RT-3c): invalid c.set inside notFound must answer 500, not reject", async () => {
    const app = new Eleu(quiet);
    app.get("/a", (c) => c.text("a"));
    app.notFound((c) => {
      c.set("x-bad-name\r\ninject: 1", "v");
      return c.text("nf");
    });
    const res = await app.handle(req("http://localhost/missing"));
    expect(res.status).toBe(500);
  });

  it("green: with global middleware the same throw becomes a clean 500", async () => {
    const app = new Eleu(quiet);
    app.use(async (_c, next) => {
      await next();
    });
    app.notFound(() => {
      throw new Error("nf-boom");
    });
    const res = await app.handle(req("http://localhost/missing"));
    expect(res.status).toBe(500);
    expect(await text(res)).toBe("Internal Server Error");
  });
});

// ---------------------------------------------------------------------------
// RT-4 (HIGH): assigning a web Response through the state mode (`c.body = res`)
// collapses multiple Set-Cookie headers into ONE comma-joined header, while the
// return-style commit preserves them (control below).
//
// Repro:    c.body = new Response("ok", {headers:[["set-cookie","a=1; Path=/"],
//           ["set-cookie","b=2; Path=/"]]})
// Expect:   2 distinct Set-Cookie headers.
// Actual:   1 header "a=1; Path=/, b=2; Path=/" — both cookies corrupted.
// Root:     src/core/context/response.ts body setter (L204-215) copies headers
//           via `value.headers.get(key)`, which joins set-cookie values;
//           getSetCookie() is never consulted.
// ---------------------------------------------------------------------------

describe("redteam — RT-4 c.body = Response collapses set-cookie", () => {
  it("CONFIRMED-BUG(now fixed) (RT-4a): state-assigning a Response must preserve every set-cookie", async () => {
    const app = new Eleu(quiet);
    app.get("/x", (c) => {
      c.body = new Response("ok", {
        headers: [
          ["set-cookie", "a=1; Path=/"],
          ["set-cookie", "b=2; Path=/"],
        ],
      });
    });
    const res = await app.handle(req("http://localhost/x"));
    expect(res.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });

  it("green control: return-style commit keeps both set-cookie headers", async () => {
    const app = new Eleu(quiet);
    app.get(
      "/x",
      () =>
        new Response("ok", {
          headers: [
            ["set-cookie", "a=1; Path=/"],
            ["set-cookie", "b=2; Path=/"],
          ],
        }),
    );
    const res = await app.handle(req("http://localhost/x"));
    expect(res.headers.getSetCookie()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// RT-5 (HIGH): the response sugar helpers corrupt multi-value headers.
//
// Repro a)  handler calls c.cookies.set() twice, then RETURNS c.text("hi"):
//           THREE set-cookie headers come out, the first being the comma-joined
//           pair "sess=1; Path=/,cart=2; Path=/" followed by both originals.
// Repro b)  c.text("hi", 200, { "set-cookie": ["a=1", "b=2"] }) -> "a=1,b=2".
// Expect:   exactly the intended distinct Set-Cookie headers.
// Actual:   a) ["sess=1; Path=/,cart=2; Path=/", "sess=1; Path=/", "cart=2; Path=/"]
//           b) ["a=1,b=2"]
// Root:     src/core/context/response.ts mergedHeadersOf (L118-127) copies the
//           header record — arrays included — into a plain record that
//           text/json/html (L411-439) hand to the Headers record-init, which
//           stringifies arrays; afterwards rule 4 (respond.ts
//           mergeIntoCommitted) appends the original array values AGAIN.
// ---------------------------------------------------------------------------

describe("redteam — RT-5 sugar helpers corrupt multi-value headers", () => {
  it("CONFIRMED-BUG(now fixed) (RT-5a): cookies.set + return c.text() must yield exactly 2 set-cookie", async () => {
    const app = new Eleu(quiet);
    app.get("/x", (c) => {
      c.cookies.set("sess", "1", { path: "/" });
      c.cookies.set("cart", "2", { path: "/" });
      return c.text("hi");
    });
    const res = await app.handle(req("http://localhost/x"));
    expect(res.headers.getSetCookie()).toEqual(["sess=1; Path=/", "cart=2; Path=/"]);
  });

  it("CONFIRMED-BUG(now fixed) (RT-5b): c.text(body, status, {set-cookie: [...]}) must not join values", async () => {
    const app = new Eleu(quiet);
    app.get("/x", (c) => c.text("hi", 200, { "set-cookie": ["a=1", "b=2"] }));
    const res = await app.handle(req("http://localhost/x"));
    expect(res.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
  });

  it("green control: state-mode cookies.set without sugar keeps both headers", async () => {
    const app = new Eleu(quiet);
    app.get("/x", (c) => {
      c.cookies.set("sess", "1", { path: "/" });
      c.cookies.set("cart", "2", { path: "/" });
      c.body = "hi";
    });
    const res = await app.handle(req("http://localhost/x"));
    expect(res.headers.getSetCookie()).toEqual(["sess=1; Path=/", "cart=2; Path=/"]);
  });

  it("green: rule-4 merge of committed set-cookie + late cookies.set (GET)", async () => {
    const app = new Eleu(quiet);
    app.use(async (c, next) => {
      await next();
      c.cookies.set("late", "1", { path: "/" });
    });
    app.get("/x", () => new Response("ok", { headers: [["set-cookie", "early=1; Path=/"]] }));
    const res = await app.handle(req("http://localhost/x"));
    expect(res.headers.getSetCookie()).toEqual(["early=1; Path=/", "late=1; Path=/"]);
  });
});

// ---------------------------------------------------------------------------
// RT-6 (MEDIUM): app.decorate() writes into the module-global baseContextProto
// shared by EVERY app, so one app's decoration leaks into all other apps in
// the process (and can shadow core accessors process-wide).
//
// Repro:    appA.decorate("marker", "A"); request appB -> context.marker === "A".
// Expect:   appB contexts untouched (undefined).
// Actual:   "A".
// Root:     src/core/app.ts decorate (L404-412) defines on the shared
//           baseContextProto (src/core/context/context.ts L98); Eleu never
//           derives a per-app prototype (L271 `const contextProto = baseContextProto`).
// ---------------------------------------------------------------------------

describe("redteam — RT-6 decorate leaks across apps", () => {
  it("CONFIRMED-BUG(now fixed) (RT-6a): decorate must not leak into other apps' contexts", async () => {
    const appA = new Eleu(quiet);
    const appB = new Eleu(quiet);
    appA.decorate("redteamMarker", "A");
    let seen: unknown = "unset";
    appB.get("/b", (c) => {
      seen = (c as unknown as { redteamMarker?: string }).redteamMarker;
      return c.text("b");
    });
    await appB.handle(req("http://localhost/b"));
    expect(seen).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// RT-7 (MEDIUM): mounting an app onto itself never terminates.
//
// Repro:    const app = new Eleu(); app.get("/a", ...); app.mount("/self", app)
// Expect:   a thrown TypeError (aliasing guard), or at least termination.
// Actual:   infinite loop + unbounded memory (verified in a child process: the
//           process is still alive after 6s). `mount` iterates `sub.router.defs`
//           while registerDef keeps pushing into that very same live array.
// Root:     src/core/app.ts mount (L362-373) — no self/aliasing guard.
// NOTE: cannot be asserted in-process (it would hang the runner); kept as a
// skip lock documenting the contract.
// ---------------------------------------------------------------------------

describe("redteam — RT-7 self-mount hang", () => {
  it("CONFIRMED-BUG(now fixed) (RT-7a): app.mount(prefix, app) must throw instead of hanging", () => {
    const app = new Eleu(quiet);
    app.get("/a", (c) => c.text("a"));
    expect(() => app.mount("/self", app)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// RT-8 (LOW): a middleware that returns a Response while its floating `next()`
// promise is still running turns any downstream rejection into a process-level
// unhandledRejection (potential crash vector under Bun.serve).
//
// Repro:    app.use((c, next) => { void next(); return c.text("early"); }) with
//           a route that rejects ~10ms later.
// Expect:   the framework answers "early" AND contains/observes the late
//           rejection (or documents it explicitly as user error).
// Actual:   response "early" + process "unhandledRejection" event fires.
// Root:     src/core/compose.ts makeLevel (L54-74): the downstream promise from
//           `next()` has no rejection guard once the handler settles first.
//           (Koa shares this gap — flagged for an explicit decision.)
// ---------------------------------------------------------------------------

describe("redteam — RT-8 floating next rejection", () => {
  it("CONFIRMED-BUG(now fixed) (RT-8a): late downstream rejection after early return must stay contained", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.addListener("unhandledRejection" as never, onUnhandled as never);
    try {
      const app = new Eleu(quiet);
      app.use((c, next) => {
        void next();
        return c.text("early");
      });
      app.get("/x", async () => {
        await new Promise((r) => setTimeout(r, 10));
        throw new Error("floating-boom");
      });
      const res = await app.handle(req("http://localhost/x"));
      expect(await text(res)).toBe("early");
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection" as never, onUnhandled as never);
    }
  });
});

// ---------------------------------------------------------------------------
// RT-9 (HIGH): staticMap keys the RAW registration string with no decoded
// retry, while the trie (source of truth) accepts encoded static segments.
// Static routes are unreachable via percent-encoded paths, and a wildcard
// steals the request (priority inversion); a dynamic route at the same
// position DOES answer (green witness). Root: src/router/router.ts
// indexPattern files static patterns only under staticMap; matchRoute never
// retries decoded (contrast trie.ts's decoded retry for static children).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// RT-10 (MEDIUM): the sugar helpers advertise hono-compatible signatures, but
// hono keeps a status set beforehand (c.status(201); c.text("x") -> 201);
// eleu answers 200 (html shares the same code path). Root:
// src/core/context/response.ts text/json/html use `status ?? 200` and never
// consult c.statusValue.
// ---------------------------------------------------------------------------

describe("redteam — RT-10 sugar discards prior c.status", () => {
  it("CONFIRMED-BUG(now fixed) (RT-10): sugar must keep a previously set c.status (hono parity)", async () => {
    const app = new Eleu(quiet);
    app.get("/t", (c) => {
      c.status = 201;
      return c.text("hi");
    });
    app.get("/j", (c) => {
      c.status = 201;
      return c.json({ ok: true });
    });
    expect((await app.handle(req("http://localhost/t"))).status).toBe(201);
    expect((await app.handle(req("http://localhost/j"))).status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// RT-11 (LOW): HEAD over a custom notFound handler drops the body without
// backfilling Content-Length; every other HEAD path backfills (state mode,
// route-committed, RT-2 merge). Root: src/core/respond.ts finalize uses
// stripBody(notFound) instead of committedHead(notFound).
// ---------------------------------------------------------------------------

describe("redteam — RT-11 HEAD x notFound CL backfill", () => {
  it("CONFIRMED-BUG(now fixed) (RT-11a): HEAD over a custom notFound must backfill CL", async () => {
    const app = new Eleu(quiet);
    app.notFound((c) => c.text("custom-nf"));
    const res = await app.handle(req("http://localhost/missing", { method: "HEAD" }));
    expect(await text(res)).toBe("");
    expect(res.headers.get("content-length")).toBe("9");
  });
});
