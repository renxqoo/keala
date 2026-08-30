/**
 * it-level parity gaps for the router, distilled from the official
 * @koa/router@13 suite in .parity/router/test/lib/router.js — every case
 * names the upstream `it()` (gh-NN regression ids included).
 *
 * Green cases: behavior verified equivalent. `it.skip` cases carry a
 * TODO-BUG note: the official assertion applies but our implementation
 * diverges (missing option or different dispatch semantics) — details live
 * in the agent report.
 */

import { describe, expect, it } from "vitest";

import { createApp } from "../src/application/app.ts";
import type { Context } from "../src/context/context.ts";
import { createRouter } from "../src/router/router.ts";

const quiet = { env: "test" } as const;

type Aug = Record<string, unknown>;

const harness = () => {
  const app = createApp(quiet);
  return app;
};

const get = (app: ReturnType<typeof createApp>, path: string, init?: RequestInit) =>
  app.handle(new Request(`http://localhost:3000${path}`, init));

describe("router.js gh-* regressions — context sharing and nesting", () => {
  it("shares context between routers (gh-205)", async () => {
    const app = harness();
    const router1 = createRouter();
    const router2 = createRouter();
    router1.get("/", async (ctx, next) => {
      (ctx as Context & Aug)["foo"] = "bar";
      await next();
    });
    router2.get("/", (ctx) => {
      ctx.body = { foo: (ctx as Context & Aug)["foo"] };
    });
    app.use(router1.routes()).use(router2.routes());
    const res = await get(app, "/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ foo: "bar" });
  });

  it("does not register middleware more than once (gh-184)", async () => {
    const app = harness();
    const parent = createRouter();
    const nested = createRouter();
    nested
      .get("/first-nested-route", (ctx) => {
        ctx.body = { n: (ctx as Context & Aug)["n"] };
      })
      .get("/second-nested-route", async (_ctx, next) => void (await next()))
      .get("/third-nested-route", async (_ctx, next) => void (await next()));
    parent.use(
      "/parent-route",
      async (ctx, next) => {
        const c = ctx as Context & { n?: number };
        c.n = c.n ? c.n + 1 : 1;
        await next();
      },
      nested.routes(),
    );
    app.use(parent.routes());
    const res = await get(app, "/parent-route/first-nested-route");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ n: 1 });
  });

  it("without path, does not set params.0 to the matched path (gh-247)", async () => {
    const app = harness();
    const router = createRouter();
    router.use(async (_ctx, next) => void (await next()));
    router.get("/foo/:id", (ctx) => {
      ctx.body = { ...(ctx.params as Record<string, string>) };
    });
    app.use(router.routes());
    const res = await get(app, "/foo/815");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, string>;
    expect(body["id"]).toBe("815");
    expect("0" in body).toBe(false);
  });

  it("with .use(fn) and a later prefix, params stay clean (gh-247)", async () => {
    const app = harness();
    const router = createRouter();
    router.use(async (_ctx, next) => void (await next()));
    router.get("/foo/:id", (ctx) => {
      ctx.body = { ...(ctx.params as Record<string, string>) };
    });
    router.prefix("/things");
    app.use(router.routes());
    const res = await get(app, "/things/foo/108");
    const body = (await res.json()) as Record<string, string>;
    expect(body["id"]).toBe("108");
    expect("0" in body).toBe(false);
  });

  it("does not add an erroneous (.*) to unprefixed nested routers (gh-369 gh-410)", async () => {
    const app = harness();
    const router = createRouter();
    const nested = createRouter();
    let called = 0;
    nested
      .get("/", async (ctx, next) => {
        ctx.body = "root";
        called += 1;
        await next();
      })
      .get("/test", async (ctx, next) => {
        ctx.body = "test";
        called += 1;
        await next();
      });
    router.use(nested.routes());
    app.use(router.routes());
    const res = await get(app, "/test");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("test");
    expect(called).toBe(1); // "too many routes matched" would be a regression
  });

  // gh-182: @koa/router only runs a router's middleware when one of its own
  // routes matched (match.route gate). Ours runs router.use() middleware
  // unconditionally, so the first router's body survives.
  it.skip("TODO-BUG matches middleware only if route was matched (gh-182)", async () => {
    const app = harness();
    const router = createRouter();
    const other = createRouter();
    router.use(async (ctx, next) => {
      ctx.body = { bar: "baz" };
      await next();
    });
    other.get("/bar", (ctx) => {
      ctx.body = ctx.body || { foo: "bar" };
    });
    app.use(router.routes()).use(other.routes());
    const res = await get(app, "/bar");
    const body = (await res.json()) as Record<string, string>;
    expect(body["foo"]).toBe("bar");
    expect("bar" in body).toBe(false);
  });

  // gh-244/gh-18: the same nested router mounted at two paths under a
  // prefixed parent. Ours ignores the router's own prefix for use() mounts,
  // so /api/<path>/qux/baz never matches (404).
  it("FIXED uses a same router middleware at given paths continuously (gh-244 gh-18)", async () => {
    const app = harness();
    const base = createRouter({ prefix: "/api" });
    const nested = createRouter({ prefix: "/qux" });
    nested.get("/baz", (ctx) => {
      ctx.body = {
        foo: (ctx as Context & Aug)["foo"],
        bar: (ctx as Context & Aug)["bar"],
        baz: "baz",
      };
    });
    const gate = async (ctx: Context, next: () => Promise<void>) => {
      (ctx as Context & Aug)["foo"] = "foo";
      (ctx as Context & Aug)["bar"] = "bar";
      await next();
    };
    base.use("/foo", gate, nested.routes()).use("/bar", gate, nested.routes());
    app.use(base.routes());
    for (const path of ["/api/foo/qux/baz", "/api/bar/qux/baz"]) {
      const res = await get(app, path);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ foo: "foo", bar: "bar", baz: "baz" });
    }
  });

  // gh-22: base.use(['/foo','/bar'], gate, nested.routes()) — arrays of paths
  // must expand into one mount per path. Ours silently drops the array
  // (use() filters non-function args).
  it("FIXED assigns middleware to array of paths (gh-22)", async () => {
    const app = harness();
    const base = createRouter({ prefix: "/api" });
    const nested = createRouter({ prefix: "/qux" });
    nested.get("/baz", (ctx) => {
      ctx.body = { foo: (ctx as Context & Aug)["foo"], baz: "baz" };
    });
    base.use(
      ["/foo", "/bar"] as unknown as string,
      async (ctx, next) => {
        (ctx as Context & Aug)["foo"] = "foo";
        await next();
      },
      nested.routes(),
    );
    app.use(base.routes());
    for (const path of ["/api/foo/qux/baz", "/api/bar/qux/baz"]) {
      const res = await get(app, path);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ foo: "foo", baz: "baz" });
    }
  });
});

describe("router.js gh-* regressions — registration API", () => {
  it("resolves non-parameterized routes without attached parameters", async () => {
    const app = harness();
    const router = createRouter();
    router.get("/notparameter", (ctx) => {
      ctx.body = { param: (ctx.params as Record<string, string>)["parameter"] };
    });
    router.get("/:parameter", (ctx) => {
      ctx.body = { param: (ctx.params as Record<string, string>)["parameter"] };
    });
    app.use(router.routes());
    const res = await get(app, "/notparameter");
    const body = (await res.json()) as Record<string, string>;
    expect("param" in body).toBe(false);
  });

  // gh-203: router.get(['/one','/two'], fn) registers two stack entries.
  // Ours stores the array itself as one entry's path.
  it("FIXED registers array of paths (gh-203)", () => {
    const router = createRouter();
    router.get(["/one", "/two"] as unknown as string, async () => {});
    expect(router.stack.length).toBe(2);
    expect(router.stack[0]?.path).toBe("/one");
    expect(router.stack[1]?.path).toBe("/two");
  });

  // gh-147: koa-router throws a descriptive error when the path argument is
  // missing. Ours throws "Route handlers must be functions" instead (wrong
  // message, and `all` behaves the same).
  it.skip("TODO-BUG verb registration without a path throws a path-specific error (gh-147)", () => {
    const router = createRouter();
    // The official suite calls router[verb](() => {}) with no path at all.
    const getWithoutPath = router.get.bind(router) as unknown as (
      mw: () => Promise<void>,
    ) => unknown;
    const allWithoutPath = router.all.bind(router) as unknown as (
      mw: () => Promise<void>,
    ) => unknown;
    expect(() => getWithoutPath(async () => {})).toThrow(
      "You have to provide a path when adding a get handler",
    );
    expect(() => allWithoutPath(async () => {})).toThrow(
      "You have to provide a path when adding an all handler",
    );
  });

  // "runs multiple controllers when there are multiple matches": both
  // /users/:id(.*) and /users/all must run for GET /users/all. Ours stops at
  // the static match — the dynamic route never runs.
  it.skip("TODO-BUG runs multiple controllers when there are multiple matches", async () => {
    const app = harness();
    const router = createRouter();
    router.get("/users/:id(.*)", async (ctx, next) => {
      ctx.body = { single: true };
      await next();
    });
    router.get("/users/all", async (ctx, next) => {
      ctx.body = { ...(ctx.body as object), all: true };
      await next();
    });
    app.use(router.routes());
    const res = await get(app, "/users/all");
    const body = (await res.json()) as Record<string, boolean>;
    expect("single" in body).toBe(true);
    expect("all" in body).toBe(true);
  });
});

describe("router.js — allowedMethods() and prefix corners", () => {
  it("does not send 405 if the route matched but status is 404", async () => {
    const app = harness();
    const router = createRouter();
    router.get("/users", (ctx) => void (ctx.status = 404));
    app.use(router.routes()).use(router.allowedMethods());
    const res = await get(app, "/users");
    expect(res.status).toBe(404);
    expect(res.headers.get("allow")).toBe(null);
  });

  it("root-level router middleware survives a prefix with trailing slash", async () => {
    const app = harness();
    const router = createRouter();
    let middlewareCount = 0;
    router.use(async (ctx, next) => {
      middlewareCount += 1;
      ctx.body = { name: "worked" };
      await next();
    });
    router.get("/", async (_ctx, next) => {
      middlewareCount += 1;
      await next();
    });
    router.prefix("/admin/");
    app.use(router.routes());
    for (const path of ["/admin", "/admin/"]) {
      middlewareCount = 0;
      const res = await get(app, path);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ name: "worked" });
      expect(middlewareCount).toBe(2);
    }
  });

  // "responds to OPTIONS requests": 200 + empty body + 'Allow: HEAD, GET, PUT'
  // (GET routes advertise HEAD; single Allow header, gh#273). Ours answers
  // 405 'Method Not Allowed' with 'Allow: GET, PUT'.
  it("FIXED allowedMethods answers OPTIONS with 200 and the full Allow set", async () => {
    const app = harness();
    const router = createRouter();
    router.get("/users", async () => {});
    router.put("/users", async () => {});
    app.use(router.routes()).use(router.allowedMethods());
    const res = await get(app, "/users", { method: "OPTIONS" });
    expect(res.status).toBe(200);
    expect(res.headers.get("allow")).toBe("HEAD, GET, PUT");
    expect(await res.text()).toBe("");
  });

  // "prefix and '/' route behavior": strict routers must NOT match the
  // unprefixed '/bar' (404), only '/bar/'. Ours has no strict option and
  // matches both.
  it.skip("TODO-BUG strict routers reject the prefix without a trailing slash", async () => {
    const app = harness();
    const loose = createRouter({ prefix: "/foo" });
    const strict = createRouter({ prefix: "/bar", strict: true } as never);
    loose.get("/", (ctx) => void (ctx.body = ""));
    strict.get("/", (ctx) => void (ctx.body = ""));
    app.use(loose.routes()).use(strict.routes());
    expect((await get(app, "/foo")).status).toBe(200);
    expect((await get(app, "/foo/")).status).toBe(200);
    expect((await get(app, "/bar")).status).toBe(404);
    expect((await get(app, "/bar/")).status).toBe(200);
  });

  // "Support host / should support host match": routes bound to a host option
  // 404 on other hosts. Ours accepts the option but never enforces it.
  it.skip("TODO-BUG router host option constrains matching", async () => {
    const app = harness();
    const router = createRouter({ host: "test.domain" } as never);
    router.get("/", (ctx) => {
      ctx.body = { url: "/" };
    });
    app.use(router.routes());
    const hit = await get(app, "/", { headers: { host: "test.domain" } });
    const miss = await get(app, "/", { headers: { host: "a.domain" } });
    expect(hit.status).toBe(200);
    expect(miss.status).toBe(404);
  });

  // "runs only the last match when the 'exclusive' option is enabled": with
  // exclusive:true only the last matching route's controller runs.
  it.skip("TODO-BUG exclusive option runs only the last match", async () => {
    const app = harness();
    const router = createRouter({ exclusive: true } as never);
    router.get("/users/:id(.*)", async (ctx, next) => {
      ctx.body = { single: true };
      await next();
    });
    router.get("/users/all", async (ctx, next) => {
      ctx.body = { ...(ctx.body as object), all: true };
      await next();
    });
    app.use(router.routes());
    const res = await get(app, "/users/all");
    const body = (await res.json()) as Record<string, boolean>;
    expect("single" in body).toBe(false);
    expect("all" in body).toBe(true);
  });
});
