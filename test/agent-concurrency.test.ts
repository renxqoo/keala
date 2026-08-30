/**
 * Concurrency / interleaving / lifecycle red-team suite.
 *
 * CONFIRMED-BUG tests are written with the CORRECT (Koa-3.2.1 / design-intent)
 * expectation and currently FAIL — each one's comment carries the label
 * CONFIRMED-BUG plus the reproduction, expected-vs-actual and the root cause
 * (file:line). "语义锁定" tests encode behavior that matches Koa (or a
 * documented deliberate deviation) and must stay green.
 *
 * Koa baseline: .parity/koa/lib/{request,context,application}.js (v3.2.1).
 */

import { describe, expect, it } from "vitest";

import { createApp } from "../src/application/app.ts";
import { createError } from "../src/http/errors.ts";
import { createRouter } from "../src/router/router.ts";
import type { QueryMap } from "../src/utils/query.ts";

const quiet = { env: "test" } as const;
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// 1. Same-request async interleaving: the query cache across await points
// ---------------------------------------------------------------------------
describe("same-request interleaving: query cache", () => {
  it("语义锁定: re-reading query after a downstream ctx.url rewrite reflects the new value", async () => {
    // Koa keys _querycache by the querystring string, so a url rewrite makes
    // the next read re-parse. Our single-slot cache must be invalidated by
    // the url setter (src/http/request.ts set url).
    const observed: unknown[] = [];
    const app = createApp(quiet);
    app.use(async (ctx, next) => {
      observed.push({ ...ctx.query });
      await next();
      observed.push({ ...ctx.query });
    });
    app.use(async (ctx) => {
      ctx.url = "/rewritten?b=2";
      ctx.body = "ok";
    });
    await app.handle(new Request("http://localhost:3000/?a=1"));
    expect(observed).toEqual([{ a: "1" }, { b: "2" }]);
  });

  it("语义锁定: a path rewrite keeps the cached query object and its values", async () => {
    // Koa's set path keeps the query string, so the cache key is unchanged.
    const observed: unknown[] = [];
    const app = createApp(quiet);
    app.use(async (ctx, next) => {
      const before = ctx.query;
      before["touched"] = "yes";
      await next();
      observed.push(ctx.query === before, { ...ctx.query });
    });
    app.use(async (ctx) => {
      ctx.path = "/moved";
      ctx.body = "ok";
    });
    await app.handle(new Request("http://localhost:3000/orig?a=1"));
    expect(observed).toEqual([true, { a: "1", touched: "yes" }]);
  });

  it("语义锁定: re-reading query after a downstream ctx.search rewrite reflects the new value", async () => {
    const observed: unknown[] = [];
    const app = createApp(quiet);
    app.use(async (ctx, next) => {
      observed.push({ ...ctx.query });
      await next();
      observed.push({ ...ctx.query });
    });
    app.use(async (ctx) => {
      ctx.search = "?c=3";
      ctx.body = "ok";
    });
    await app.handle(new Request("http://localhost:3000/?a=1"));
    expect(observed).toEqual([{ a: "1" }, { c: "3" }]);
  });

  // CONFIRMED-BUG (parity): assigning the IDENTICAL querystring must be a
  // no-op that preserves the cached query object, because Koa guards with
  // `if (url.search === `?${str}`) return` (.parity/koa/lib/request.js set
  // querystring). Repro: middleware A reads query and mutates the cached
  // object, awaits; middleware B assigns the same querystring value; A
  // re-reads. Expected (Koa): the same cache entry survives — the mutation is
  // visible. Actual: our setter unconditionally drops `_query`, so the
  // re-read returns a fresh parse and cross-await mutations are lost.
  // Root cause: src/http/request.ts:201-206 (set querystring has no
  // same-value guard before `this._query = null`).
  it("CONFIRMED-BUG: assigning an identical querystring preserves the cached query object", async () => {
    const app = createApp(quiet);
    const observed: unknown[] = [];
    app.use(async (ctx, next) => {
      const cached = ctx.query;
      cached["mutated"] = "yes";
      await next();
      observed.push(ctx.query === cached, ctx.query["mutated"]);
    });
    app.use(async (ctx) => {
      ctx.querystring = "a=1"; // identical to the current "?a=1" — Koa no-ops
      ctx.body = "ok";
    });
    await app.handle(new Request("http://localhost:3000/?a=1"));
    expect(observed).toEqual([true, "yes"]);
  });

  // 语义锁定 (documented deviation): this project's `query=` setter stashes
  // the assigned object, so reads return it verbatim (identity + value types
  // preserved). Koa re-stringifies and re-parses, so it would return a fresh
  // all-strings object. Locked in by test/request.test.ts ("parses and caches
  // the query"); recorded here as an intentional deviation, not a defect.
  it("语义锁定(偏差): query= keeps the assigned object (no koa round-trip)", async () => {
    const app = createApp(quiet);
    const observed: unknown[] = [];
    app.use(async (ctx) => {
      const assigned = { page: 2, tags: ["a", "b"] } as unknown as QueryMap;
      ctx.query = assigned;
      observed.push(ctx.query === assigned, ctx.query["page"], ctx.query["tags"]);
      ctx.body = "ok";
    });
    await app.handle(new Request("http://localhost:3000/?old=1"));
    expect(observed).toEqual([true, 2, ["a", "b"]]);
    expect(observed[1]).not.toBe("2");
  });
});

// ---------------------------------------------------------------------------
// 2. Cross-request isolation under concurrency
// ---------------------------------------------------------------------------
describe("concurrent isolation", () => {
  const buildApp = () => {
    const app = createApp({ ...quiet, keys: ["k"] });
    const router = createRouter();
    router.get("/user/:id", async (ctx) => {
      await delay(Number(ctx.params.id) % 3);
      ctx.set("X-Path", "param");
      ctx.body = `user:${ctx.params.id}:${ctx.query.tag ?? "none"}`;
    });
    router.get("/static", (ctx) => {
      ctx.type = "json";
      ctx.body = { stable: true };
    });
    router.get("/error", () => {
      throw createError(418, "teapot");
    });
    router.get("/redirect", (ctx) => {
      ctx.redirect(`/user/${ctx.query.to ?? "0"}`);
    });
    router.get("/cookie", (ctx) => {
      ctx.cookies.set("sid", `s-${ctx.query.n ?? "0"}`, { signed: true });
      ctx.body = `cookie:${ctx.cookies.get("sid")}`;
    });
    app.use(router.routes());
    return app;
  };

  it("语义锁定: 50-way concurrent mixed traffic matches the serial baseline", async () => {
    const paths = Array.from({ length: 50 }, (_, i) => {
      const kind = i % 5;
      if (kind === 0) return `/user/${i}?tag=t${i}`;
      if (kind === 1) return "/static";
      if (kind === 2) return "/error";
      if (kind === 3) return `/redirect?to=${i}`;
      return `/cookie?n=${i}`;
    });
    const serialize = async (app: ReturnType<typeof buildApp>) => {
      const out: Array<{ status: number; body: string; allow: string | null; cookie: string[] }> =
        [];
      for (const path of paths) {
        const res = await app.handle(new Request(`http://localhost:3000${path}`));
        out.push({
          status: res.status,
          body: await res.text(),
          allow: res.headers.get("allow"),
          cookie: res.headers
            .getSetCookie()
            .map((c) => c.replace(/s-\d+/, "s-N").replace(/user\/\d+/, "user/N")),
        });
      }
      return out;
    };
    const serial = await serialize(buildApp());
    const app = buildApp();
    const concurrent = await Promise.all(
      paths.map(async (path) => {
        const res = await app.handle(new Request(`http://localhost:3000${path}`));
        return {
          status: res.status,
          body: await res.text(),
          allow: res.headers.get("allow"),
          cookie: res.headers
            .getSetCookie()
            .map((c) => c.replace(/s-\d+/, "s-N").replace(/user\/\d+/, "user/N")),
        };
      }),
    );
    expect(concurrent).toEqual(serial);
    // Sanity: the baseline itself is non-trivial.
    expect(serial.filter((r) => r.status === 418).length).toBe(10);
    expect(serial.filter((r) => r.status === 302).length).toBe(10);
  });

  it("语义锁定: ctx.state stays request-private across await points under concurrency", async () => {
    const app = createApp(quiet);
    const violations: string[] = [];
    app.use(async (ctx) => {
      const mine = ctx.query.token as string;
      ctx.state.token = mine;
      await delay(Number(mine) % 4);
      if (ctx.state.token !== mine) violations.push(`token:${mine}->${String(ctx.state.token)}`);
      const extra = Object.keys(ctx.state).filter((k) => k !== "token");
      if (extra.length > 0) violations.push(`extra:${mine}:${extra.join(",")}`);
      ctx.body = String(ctx.state.token);
    });
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        Promise.resolve(app.handle(new Request(`http://localhost:3000/?token=${i}`))).then((r) =>
          r.text(),
        ),
      ),
    );
    expect(violations).toEqual([]);
    expect(results).toEqual(Array.from({ length: 30 }, (_, i) => String(i)));
  });

  it("语义锁定: app.currentContext tracks the right ctx per concurrent request", async () => {
    const app = createApp({ ...quiet, currentContext: true });
    const seen: string[] = [];
    app.use(async (ctx) => {
      await delay(Number(ctx.query.i) % 4);
      seen.push(app.currentContext === ctx ? ctx.path : "WRONG");
      ctx.body = "ok";
    });
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        app.handle(new Request(`http://localhost:3000/p${i}?i=${i}`)),
      ),
    );
    expect(seen.filter((s) => s === "WRONG")).toEqual([]);
    expect(seen.toSorted()).toEqual(Array.from({ length: 12 }, (_, i) => `/p${i}`).toSorted());
  });

  it("语义锁定: concurrent 405s (no pooling) each produce the right Allow header", async () => {
    const app = createApp(quiet);
    const router = createRouter();
    router.get("/only-get", (ctx) => {
      ctx.body = "g";
    });
    router.put("/only-put", (ctx) => {
      ctx.body = "p";
    });
    app.use(router.routes());
    app.use(router.allowedMethods());
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        app.handle(
          new Request(`http://localhost:3000/${i % 2 === 0 ? "only-get" : "only-put"}`, {
            method: "POST",
          }),
        ),
      ),
    );
    for (const [i, res] of responses.entries()) {
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe(i % 2 === 0 ? "HEAD, GET" : "PUT");
    }
  });

  // CONFIRMED-BUG (pooling lifecycle): the router keys its 405 bookkeeping on
  // ctx object identity (WeakMap, src/router/router.ts:140 + dispatchRoute
  // 262-268). With `pooling: true` the ctx object is recycled into the next
  // request (src/application/app.ts:94-96,135-144) and stays referenced by
  // the pool, so the WeakMap entry survives `resetContext`, which cannot
  // clear it. Repro: request 1 = POST /only-get (no POST route) -> 405,
  // allowed={GET,HEAD} recorded on pooled ctx A; request 2 reuses ctx A with
  // POST /only-post (a POST route whose handler writes nothing -> stays 404).
  // Expected: 404 (allowedMethods only speaks for methods its own dispatch
  // recorded). Actual: the stale {GET,HEAD} set turns the 404 into a bogus
  // 405 with "Allow: HEAD, GET" from a foreign path.
  // Root cause: src/router/router.ts:140,262-268 (state keyed by ctx
  // identity) + src/context/context.ts:334-353 (resetContext cannot clear
  // it) + src/application/app.ts:94-96 (recycle keeps the object alive).
  it("CONFIRMED-BUG: pooled ctx reuses a foreign request's 405 allowed-methods set", async () => {
    const app = createApp({ ...quiet, pooling: true });
    const router = createRouter();
    router.get("/only-get", (ctx) => {
      ctx.body = "g";
    });
    router.post("/only-post", async (_ctx, next) => {
      // Defers downstream (fall-through style): allowedMethods gets to run
      // while this route's handler wrote nothing, so status stays 404.
      await next();
    });
    app.use(router.routes());
    app.use(router.allowedMethods());

    const first = await app.handle(
      new Request("http://localhost:3000/only-get", { method: "POST" }),
    );
    expect(first.status).toBe(405); // allowed={GET,HEAD} recorded on the pooled ctx

    const second = await app.handle(
      new Request("http://localhost:3000/only-post", { method: "POST" }),
    );
    expect(second.status).toBe(404); // actual: 405
    expect(second.headers.get("allow")).toBe(null); // actual: "HEAD, GET"
  });

  it("语义锁定: the same 405/404 sequence without pooling stays correct (control)", async () => {
    const app = createApp(quiet);
    const router = createRouter();
    router.get("/only-get", (ctx) => {
      ctx.body = "g";
    });
    router.post("/only-post", async (_ctx, next) => {
      await next();
    });
    app.use(router.routes());
    app.use(router.allowedMethods());
    const first = await app.handle(
      new Request("http://localhost:3000/only-get", { method: "POST" }),
    );
    const second = await app.handle(
      new Request("http://localhost:3000/only-post", { method: "POST" }),
    );
    expect(first.status).toBe(405);
    expect(second.status).toBe(404);
    expect(second.headers.get("allow")).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// 3. Error-path lifecycle
// ---------------------------------------------------------------------------
describe("error path lifecycle", () => {
  it("语义锁定: a failed response drops its headers and body, keeps set-cookie (documented deviation)", async () => {
    // Koa's ctx.onerror unsets ALL headers; this project deliberately keeps
    // set-cookie so a failing request still clears cookies (see
    // src/application/app.ts buildErrorResponse).
    const errors: unknown[] = [];
    const app = createApp(quiet);
    app.on("error", (e) => errors.push(e));
    app.use(async (ctx) => {
      ctx.set("X-Custom", "leak");
      ctx.append("Set-Cookie", "sid=dead; Path=/");
      ctx.status = 200;
      ctx.body = "partial";
      throw createError(500, "boom");
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(500);
    expect(res.headers.get("x-custom")).toBe(null);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).toBe("Internal Server Error");
    expect(res.headers.getSetCookie()).toEqual(["sid=dead; Path=/"]);
    expect(errors).toHaveLength(1);
  });

  it("语义锁定: upstream middleware may recover after a downstream error", async () => {
    const app = createApp(quiet);
    app.on("error", () => {});
    app.use(async (ctx, next) => {
      try {
        await next();
      } catch {
        ctx.status = 200;
        ctx.body = "recovered";
      }
    });
    app.use(async () => {
      throw createError(418, "first");
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("recovered");
  });

  it("语义锁定: when a request throws twice, the surviving error wins exactly once", async () => {
    const messages: string[] = [];
    const app = createApp(quiet);
    app.on("error", (e: Error) => messages.push(e.message));
    app.use(async (_ctx, next) => {
      try {
        await next();
      } catch {
        throw createError(503, "second");
      }
    });
    app.use(async () => {
      throw createError(418, "first");
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("Service Unavailable");
    expect(messages).toEqual(["second"]);
  });

  it("语义锁定: an error listener that throws never escapes app.handle", async () => {
    const app = createApp(quiet);
    app.on("error", () => {
      throw new Error("listener exploded");
    });
    app.use(async () => {
      throw new Error("original");
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Internal Server Error");
  });

  it("语义锁定: allowedMethods stays silent when the matched route itself errors", async () => {
    // The route handler runs (method matched) and throws: the rejection skips
    // allowedMethods' status fixup and the error path owns the response,
    // exactly like @koa/router under koa-compose.
    const app = createApp(quiet);
    app.on("error", () => {});
    const router = createRouter();
    router.get("/get-only", () => {
      throw createError(410, "gone");
    });
    app.use(router.routes());
    app.use(router.allowedMethods());
    const res = await app.handle(new Request("http://localhost:3000/get-only"));
    expect(res.status).toBe(410);
    expect(res.headers.get("allow")).toBe(null);
  });

  // CONFIRMED-BUG (parity): the error response inherits the FAILED
  // response's custom status message when the pre-error status equals the
  // error status. Repro: middleware sets ctx.status=500 + ctx.message=
  // "Custom Phrase", then throws a 500. Expected: the status line carries
  // the standard reason phrase ("Internal Server Error") — Koa's error path
  // never maps ctx.message onto the status line. Actual: our status setter
  // only clears _message when the status CHANGES
  // (src/http/response.ts:191) and buildErrorResponse never resets it, so
  // respond() ships the stale phrase as statusText.
  // Root cause: src/application/app.ts:284-289 (buildErrorResponse resets
  // headers/body/flags but not _message) + src/http/response.ts:191.
  it("CONFIRMED-BUG: error response inherits the failed response's custom statusText", async () => {
    const app = createApp(quiet);
    app.on("error", () => {});
    app.use(async (ctx) => {
      ctx.status = 500;
      ctx.message = "Custom Phrase";
      throw createError(500, "boom");
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(500);
    expect(res.statusText).toBe("Internal Server Error"); // actual: "Custom Phrase"
  });
});
