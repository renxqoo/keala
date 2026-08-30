/**
 * Router/trie edge matrix: patterns, precedence, encoding, methods,
 * nesting and URL generation corners.
 */

import { describe, expect, it } from "vitest";

import { createApp } from "../src/application/app.ts";
import { createRouter } from "../src/router/router.ts";
import { compilePattern, createNode, insertPattern, matchPattern } from "../src/router/trie.ts";

const quiet = { env: "test" } as const;

const appWith = (setup: (router: ReturnType<typeof createRouter>) => void) => {
  const app = createApp(quiet);
  const router = createRouter();
  setup(router);
  app.use(router.routes()).use(router.allowedMethods());
  return (path: string, init?: RequestInit) =>
    app.handle(new Request(`http://localhost:3000${path}`, init));
};

describe("router matrix: pattern compilation", () => {
  const patterns: [string, Record<string, string> | null, string | null][] = [
    ["/a", {}, "/a"],
    ["/a/b/c", {}, "/a/b/c"],
    ["/users/:id", { id: "1" }, "/users/1"],
    ["/files/:name?", { name: "f" }, "/files/f"],
    ["/files/:name?", {}, "/files"],
    ["/n/:num(\\d+)", { num: "7" }, "/n/7"],
    ["/hex/:h([0-9a-f]+)", { h: "abc123" }, "/hex/abc123"],
    ["/assets/*", { wildcard: "a/b/c" }, "/assets/a/b/c"],
    ["/x/:a/:b?", { a: "1", b: "2" }, "/x/1/2"],
    ["/x/:a/:b?", { a: "1" }, "/x/1"],
  ];
  it.each(patterns)("compile+match %s on %s", (pattern, params, path) => {
    const root = createNode();
    const segments = compilePattern(pattern);
    const node = insertPattern(root, segments);
    node.target = { methods: new Map(), allowed: new Set() };
    const match = path === null ? null : matchPattern(root, path);
    if (path === null || params === null) {
      expect(match?.params ?? null).toEqual(params);
      return;
    }
    expect(matchPattern(root, path)?.params).toEqual(params);
  });
});

describe("router matrix: static-over-param precedence", () => {
  it.each([
    ["/shop/new", "static"],
    ["/shop/abc", "param"],
    ["/shop/new/extra", "wildcard"],
  ])("%s wins", async (path, expected) => {
    const request = appWith((router) => {
      router.get("/shop/*", (ctx) => {
        ctx.body = "wildcard";
      });
      router.get("/shop/:name", (ctx) => {
        ctx.body = "param";
      });
      router.get("/shop/new", (ctx) => {
        ctx.body = "static";
      });
    });
    const res = await request(path);
    expect(await res.text()).toBe(expected);
  });
});

describe("router matrix: methods and 405/501", () => {
  const methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
  it.each(methods)("%s-only routes answer 405 to the others", async (method) => {
    const request = appWith((router) => {
      router[method.toLowerCase() as "get"]("/only", (ctx) => {
        ctx.body = method;
      });
    });
    const hit = await request("/only", { method });
    expect(hit.status).toBe(200);
    for (const other of methods) {
      if (other === method || other === "OPTIONS") continue;
      if (method === "GET" && other === "HEAD") continue; // HEAD falls back to GET
      const miss = await request("/only", { method: other });
      expect(miss.status).toBe(405);
      expect(miss.headers.get("allow")).toContain(method);
    }
    if (method === "GET") {
      // GET routes advertise HEAD in Allow (koa-router convention).
      const miss = await request("/only", { method: "DELETE" });
      expect(miss.headers.get("allow")).toContain("HEAD");
    }
    // OPTIONS answers 200 with an empty body + Allow (allowedMethods contract).
    const options = await request("/only", { method: "OPTIONS" });
    expect(options.status).toBe(200);
    if (method !== "OPTIONS") {
      // synthesized by allowedMethods: empty body + Allow
      // An explicit OPTIONS route handles the request itself (no Allow needed).
      expect(options.headers.get("allow")).toContain(method);
    }
  });

  it.each(["PROPFIND", "MKCOL", "REPORT", "CHECKOUT"])("%s yields 501", async (method) => {
    const request = appWith((router) => {
      router.get("/x", (ctx) => {
        ctx.body = "x";
      });
    });
    const res = await request("/x", { method });
    expect(res.status).toBe(501);
  });

  it("allowedMethods with throw:true converts to an HttpError", async () => {
    const app = createApp(quiet);
    const router = createRouter();
    router.get("/t", (ctx) => void ctx);
    app.use(router.routes()).use(router.allowedMethods({ throw: true }));
    const res = await app.handle(new Request("http://localhost:3000/t", { method: "POST" }));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("HEAD, GET");
  });
});

describe("router matrix: encoding corners", () => {
  it.each([
    ["/users/%E4%B8%AD", "中"],
    ["/users/a%20b", "a b"],
    ["/users/a+b", "a+b"],
    ["/users/%2F", "/"],
    ["/users/%3F", "?"],
    ["/users/100%25", "100%"],
  ])("%s captures %s", async (path, expected) => {
    const request = appWith((router) => {
      router.get("/users/:name", (ctx) => {
        ctx.body = ctx.params.name ?? "";
      });
    });
    const res = await request(path);
    expect(await res.text()).toBe(expected);
  });

  it("trailing slashes are normalized on both sides", async () => {
    const request = appWith((router) => {
      router.get("/page/", (ctx) => {
        ctx.body = "page";
      });
    });
    expect((await request("/page")).status).toBe(200);
    expect((await request("/page/")).status).toBe(200);
  });

  it("case-sensitive matching (no lowercase folding)", async () => {
    const request = appWith((router) => {
      router.get("/Case", (ctx) => {
        ctx.body = "exact";
      });
    });
    expect((await request("/Case")).status).toBe(200);
    expect((await request("/case")).status).toBe(404);
  });
});

describe("router matrix: nesting and prefix", () => {
  it.each([
    ["/v1/users", 200],
    ["/v1/users/42", 200],
    ["/v1/admin/panel", 200],
    ["/v1/missing", 404],
    ["/users", 404],
  ])("%s → %d", async (path, status) => {
    const app = createApp(quiet);
    const api = createRouter({ prefix: "/v1" });
    // koa-router convention: nested routers carry the full mount prefix.
    const users = createRouter({ prefix: "/v1/users" });
    users.get("/:id", (ctx) => {
      ctx.body = ctx.params.id ?? "";
    });
    users.get("/", (ctx) => {
      ctx.body = "index";
    });
    api.use(users.routes());
    api.get("/admin/panel", (ctx) => {
      ctx.body = "panel";
    });
    app.use(api.routes()).use(api.allowedMethods());
    const res = await app.handle(new Request(`http://localhost:3000${path}`));
    expect(res.status).toBe(status);
  });

  it("prefix() after registration rebuilds everything", async () => {
    const router = createRouter();
    router.get("/a", (ctx) => {
      ctx.body = "a";
    });
    router.get("/b/:x", (ctx) => {
      ctx.body = ctx.params.x ?? "";
    });
    router.prefix("/pre");
    const app = createApp(quiet);
    app.use(router.routes());
    expect((await app.handle(new Request("http://localhost:3000/pre/a"))).status).toBe(200);
    expect((await app.handle(new Request("http://localhost:3000/pre/b/9"))).status).toBe(200);
    expect((await app.handle(new Request("http://localhost:3000/a"))).status).toBe(404);
  });

  it("double prefix application is idempotent", () => {
    const router = createRouter({ prefix: "/x" });
    router.get("/y", () => undefined);
    router.prefix("/x");
    expect(router.stack.every((entry) => entry.path === "/y")).toBe(true);
  });
});

describe("router matrix: url() generation", () => {
  it.each([
    [["user", { id: "1" }], "/users/1"],
    [["user", { id: "42" }], "/users/42"],
    [["file", {}], "/files"],
    [["file", { name: "a.txt" }], "/files/a.txt"],
    [["file", { name: "中文.txt" }], "/files/%E4%B8%AD%E6%96%87.txt"],
    [["wild", { wildcard: "a/b" }], "/w/a/b"],
  ])("url(%p, %p) → %s", (args, expected) => {
    const router = createRouter();
    router.get("user", "/users/:id(\\d+)", (ctx) => void ctx);
    router.get("file", "/files/:name?", (ctx) => void ctx);
    router.get("wild", "/w/*", (ctx) => void ctx);
    expect(router.url(args[0] as string, args[1] as Record<string, string>)).toBe(expected);
  });
});

describe("router matrix: param middleware ordering", () => {
  it("param middleware runs before handlers in registration order", async () => {
    const order: string[] = [];
    const request = appWith((router) => {
      router.param("pid", async (ctx, next) => {
        order.push("param");
        ctx.set("X-Param", ctx.params.pid ?? "");
        await next();
      });
      router.get(
        "/p/:pid",
        async (_ctx, next) => {
          order.push("mw1");
          await next();
        },
        (ctx) => {
          order.push("handler");
          ctx.body = "done";
        },
      );
    });
    const res = await request("/p/77");
    expect(await res.text()).toBe("done");
    expect(order).toEqual(["param", "mw1", "handler"]);
    expect(res.headers.get("x-param")).toBe("77");
  });

  it("param middleware applies only to routes using that param", async () => {
    let paramRuns = 0;
    const request = appWith((router) => {
      router.param("only", async (_ctx, next) => {
        paramRuns += 1;
        await next();
      });
      router.get("/a/:other", (ctx) => {
        ctx.body = "a";
      });
      router.get("/b/:only", (ctx) => {
        ctx.body = "b";
      });
    });
    await request("/a/1");
    expect(paramRuns).toBe(0);
    await request("/b/2");
    expect(paramRuns).toBe(1);
  });
});
