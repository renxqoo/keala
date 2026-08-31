/**
 * Concurrency / interleaving / lifecycle red-team suite.
 *
 * CONFIRMED-BUG tests are written with the CORRECT (Koa-3.2.1 / design-intent)
 * expectation and currently FAIL — each one's comment carries the label
 * CONFIRMED-BUG plus the reproduction, expected-vs-actual and the root cause
 * (file:line). "语义锁定" tests encode behavior that matches Koa (or a
 * documented deliberate deviation) and must stay green.
 *
 * migration notes (see docs/MIGRATION.md §2):
 *  - routing is app-level (`app.get` / `app.mount`); no router middleware API
 *  - `currentContext` / `pooling` app options no longer exist (removed from
 *    the core) — their tests were dropped; context recycling semantics are
 *    covered by test/pooling.test.ts against `resetContext`
 *  - the inherited koa CONFIRMED-BUGs around the identical-querystring no-op, the error
 *    statusText leak and the lazy ip thunk were fixed and are now
 *    green 语义锁定 locks.
 *
 * Koa baseline: .parity/koa/lib/{request,context,application}.js (v3.2.1).
 */

import { describe, expect, it } from "vitest";

import { Eleu, Router, createError } from "../src/index.ts";

const quiet = { env: "test" } as const;
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// 1. Same-request async interleaving: the query cache across await points
// ---------------------------------------------------------------------------
describe("same-request interleaving: query cache", () => {
  it("语义锁定: re-reading query after a downstream ctx.url rewrite reflects the new value", async () => {
    // Koa keys _querycache by the querystring string, so a url rewrite makes
    // the next read re-parse. Our single-slot cache must be invalidated by
    // the url setter (src/core/context/request.ts set url).
    const observed: unknown[] = [];
    const app = new Eleu(quiet);
    app.use(async (c, next) => {
      observed.push({ ...c.query });
      await next();
      observed.push({ ...c.query });
    });
    app.use(async (c) => {
      c.url = "/rewritten?b=2";
      c.body = "ok";
    });
    await app.handle(new Request("http://localhost:3000/?a=1"));
    expect(observed).toEqual([{ a: "1" }, { b: "2" }]);
  });

  it("语义锁定: a path rewrite keeps the query string values", async () => {
    const observed: unknown[] = [];
    const app = new Eleu(quiet);
    app.use(async (c, next) => {
      await next();
      observed.push(c.path, c.querystring, { ...c.query });
    });
    app.use(async (c) => {
      c.path = "/moved";
      c.body = "ok";
    });
    await app.handle(new Request("http://localhost:3000/orig?a=1"));
    expect(observed).toEqual(["/moved", "a=1", { a: "1" }]);
  });

  // CONFIRMED-BUG (parity): a path rewrite must keep the CACHED query object.
  // Koa's query getter caches by the querystring string
  // (.parity/koa/lib/request.js get query), and `set path` only replaces the
  // pathname — the querystring is unchanged, so the same cache entry survives
  // and in-place mutations made upstream of `await next()` stay visible.
  // Repro: middleware A reads query and mutates the cached object, awaits;
  // middleware B rewrites only the path; A re-reads. Expected (Koa): the
  // identity is preserved and the mutation is visible. Actual: the
  // `set path` delegates to the url setter, which unconditionally nulls
  // `queryValue`, so the re-read returns a fresh parse and the mutation is
  // silently dropped.
  // Root cause: src/core/context/request.ts set path (writes through
  // `this.url = ...`, whose setter resets the query cache) — it should update
  // urlValue without touching queryValue because the querystring is intact.
  it("CONFIRMED-BUG: a path rewrite keeps the cached query object and its mutations", async () => {
    const app = new Eleu(quiet);
    const observed: unknown[] = [];
    app.use(async (c, next) => {
      const cached = c.query;
      cached["touched"] = "yes";
      await next();
      observed.push(c.query === cached, c.query["touched"]);
    });
    app.use(async (c) => {
      c.path = "/moved";
      c.body = "ok";
    });
    await app.handle(new Request("http://localhost:3000/orig?a=1"));
    expect(observed).toEqual([true, "yes"]);
  });

  it("语义锁定: re-reading query after a downstream ctx.search rewrite reflects the new value", async () => {
    const observed: unknown[] = [];
    const app = new Eleu(quiet);
    app.use(async (c, next) => {
      observed.push({ ...c.query });
      await next();
      observed.push({ ...c.query });
    });
    app.use(async (c) => {
      c.search = "?c=3";
      c.body = "ok";
    });
    await app.handle(new Request("http://localhost:3000/?a=1"));
    expect(observed).toEqual([{ a: "1" }, { c: "3" }]);
  });

  // Fixed (was an inherited koa CONFIRMED-BUG): the querystring setter now carries
  // Koa's same-value guard, so the cached query object survives an identical
  // assignment (src/core/context/request.ts set querystring).
  it("语义锁定: assigning an identical querystring preserves the cached query object", async () => {
    const app = new Eleu(quiet);
    const observed: unknown[] = [];
    app.use(async (c, next) => {
      const cached = c.query;
      cached["mutated"] = "yes";
      await next();
      observed.push(c.query === cached, c.query["mutated"]);
    });
    app.use(async (c) => {
      c.querystring = "a=1"; // identical to the current "?a=1" — Koa no-ops
      c.body = "ok";
    });
    await app.handle(new Request("http://localhost:3000/?a=1"));
    expect(observed).toEqual([true, "yes"]);
  });

  // eleu follows koa here (design contract #8 lists `query` among the five
  // cache-invalidating url writers): the assignment rewrites the query string
  // and the next read re-parses the stringified form. koa's verbatim-stash
  // deviation is gone, so this now locks plain Koa semantics.
  it("语义锁定(koa parity): query= rewrites the query string and re-parses on read", async () => {
    const app = new Eleu(quiet);
    const observed: unknown[] = [];
    app.use(async (c) => {
      // The numeric `page` exercises stringifyQuery's number coercion.
      c.query = { page: 2, tags: ["a", "b"] } as unknown as Record<string, string>;
      observed.push(c.querystring, { ...c.query });
      c.body = "ok";
    });
    await app.handle(new Request("http://localhost:3000/?old=1"));
    expect(observed).toEqual(["page=2&tags=a&tags=b", { page: "2", tags: ["a", "b"] }]);
    expect(observed[1]).not.toBe("2");
  });
});

// ---------------------------------------------------------------------------
// 2. Cross-request isolation under concurrency
// ---------------------------------------------------------------------------
describe("concurrent isolation", () => {
  const buildApp = () => {
    const app = new Eleu({ ...quiet, keys: ["k"] });
    const router = new Router();
    router.get("/user/:id", async (c) => {
      await delay(Number(c.params?.["id"]) % 3);
      c.set("X-Path", "param");
      c.body = `user:${c.params?.["id"]}:${c.query["tag"] ?? "none"}`;
    });
    router.get("/static", (c) => {
      c.type = "json";
      c.body = { stable: true };
    });
    router.get("/error", () => {
      throw createError(418, "teapot");
    });
    router.get("/redirect", (c) => {
      c.redirect(`/user/${c.query["to"] ?? "0"}`);
    });
    router.get("/cookie", (c) => {
      c.cookies.set("sid", `s-${c.query["n"] ?? "0"}`, { signed: true });
      c.body = `cookie:${c.cookies.get("sid")}`;
    });
    app.mount("/", router);
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
            .map((cookie) => cookie.replace(/s-\d+/, "s-N").replace(/user\/\d+/, "user/N")),
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
            .map((cookie) => cookie.replace(/s-\d+/, "s-N").replace(/user\/\d+/, "user/N")),
        };
      }),
    );
    expect(concurrent).toEqual(serial);
    // Sanity: the baseline itself is non-trivial.
    expect(serial.filter((r) => r.status === 418).length).toBe(10);
    expect(serial.filter((r) => r.status === 302).length).toBe(10);
  });

  it("语义锁定: ctx.state stays request-private across await points under concurrency", async () => {
    const app = new Eleu(quiet);
    const violations: string[] = [];
    app.use(async (c) => {
      const mine = c.query["token"] as string;
      c.state["token"] = mine;
      await delay(Number(mine) % 4);
      if (c.state["token"] !== mine) violations.push(`token:${mine}->${String(c.state["token"])}`);
      const extra = Object.keys(c.state).filter((k) => k !== "token");
      if (extra.length > 0) violations.push(`extra:${mine}:${extra.join(",")}`);
      c.body = String(c.state["token"]);
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

  it("语义锁定: concurrent 405s each produce the right Allow header", async () => {
    const app = new Eleu(quiet);
    app.use(async (_c, next) => {
      await next();
    });
    app.get("/only-get", (c) => {
      c.body = "g";
    });
    app.put("/only-put", (c) => {
      c.body = "p";
    });
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

  // the 405 bookkeeping is per-request state (`routerAllowed` on the context,
  // nulled by initContext/resetContext), so a recycled context cannot leak a
  // foreign request's allowed-methods set — the old pooled leak is structurally
  // gone. The recycling contract itself is locked in test/pooling.test.ts
  // (resetContext field conservation); this locks the observable sequence.
  it("语义锁定: a 405 answer never bleeds into the next request's 404", async () => {
    const app = new Eleu(quiet);
    app.use(async (_c, next) => {
      await next();
    });
    app.get("/only-get", (c) => {
      c.body = "g";
    });
    app.post("/only-post", async (_c, next) => {
      // Defers downstream (fall-through style): the route's handler wrote
      // nothing, so status stays 404 with no Allow header.
      await next();
    });
    const first = await app.handle(
      new Request("http://localhost:3000/only-get", { method: "POST" }),
    );
    expect(first.status).toBe(405);
    const second = await app.handle(
      new Request("http://localhost:3000/only-post", { method: "POST" }),
    );
    expect(second.status).toBe(404);
    expect(second.headers.get("allow")).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// 3. Error-path lifecycle
// ---------------------------------------------------------------------------
describe("error path lifecycle", () => {
  it("语义锁定: a failed response keeps staged headers and set-cookie, drops the failed body (koa parity)", async () => {
    // Verified against koa 3.2.1: the error response carries headers the
    // chain already staged (middleware security headers must reach error
    // pages); the failed BODY is discarded and the 5xx message stays hidden.
    const errors: unknown[] = [];
    const app = new Eleu(quiet);
    app.onError((e) => errors.push(e));
    app.use(async (c) => {
      c.set("X-Custom", "leak");
      c.append("Set-Cookie", "sid=dead; Path=/");
      c.status = 200;
      c.body = "partial";
      throw createError(500, "boom");
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(500);
    expect(res.headers.get("x-custom")).toBe("leak");
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).toBe("Internal Server Error");
    expect(res.headers.getSetCookie()).toEqual(["sid=dead; Path=/"]);
    expect(errors).toHaveLength(1);
  });

  it("语义锁定: upstream middleware may recover after a downstream error", async () => {
    const app = new Eleu(quiet);
    app.onError(() => {});
    app.use(async (c, next) => {
      try {
        await next();
      } catch {
        c.status = 200;
        c.body = "recovered";
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
    const app = new Eleu(quiet);
    app.onError((e: Error) => messages.push(e.message));
    app.use(async (_c, next) => {
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
    const app = new Eleu(quiet);
    app.onError(() => {
      throw new Error("listener exploded");
    });
    app.use(async () => {
      throw new Error("original");
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Internal Server Error");
  });

  it("语义锁定: the built-in 405 layer stays silent when the matched route itself errors", async () => {
    // The route handler runs (method matched) and throws: the rejection skips
    // the 405/Allow fixup and the error path owns the response, exactly like
    // @koa/router under koa-compose.
    const app = new Eleu(quiet);
    app.onError(() => {});
    app.get("/get-only", () => {
      throw createError(410, "gone");
    });
    const res = await app.handle(new Request("http://localhost:3000/get-only"));
    expect(res.status).toBe(410);
    expect(res.headers.get("allow")).toBe(null);
  });

  // Fixed (was an inherited koa CONFIRMED-BUG): buildErrorResponse now resets
  // `messageValue`, so a custom status phrase set before the failure cannot
  // leak onto the error response's status line.
  it("语义锁定: the error response does not inherit the failed response's custom statusText", async () => {
    const app = new Eleu(quiet);
    app.onError(() => {});
    app.use(async (c) => {
      c.status = 500;
      c.message = "Custom Phrase";
      throw createError(500, "boom");
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(500);
    expect(res.statusText).toBe("");
  });
});
