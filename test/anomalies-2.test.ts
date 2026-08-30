/**
 * Anomaly-path matrix, part 2: query/URL stress, compose misuse, router
 * illegal inputs, exotic throwables and hostile requests.
 */

import { describe, expect, it } from "vitest";

import { createApp } from "../src/application/app.ts";
import { compose, NOOP_TAIL, type Middleware } from "../src/application/compose.ts";
import { createRouter } from "../src/router/router.ts";
import { parseQuery } from "../src/utils/query.ts";

const quiet = { env: "test" } as const;

describe("anomalies: query and URL parsing stress", () => {
  it.each([
    ["", {}],
    ["?", {}],
    ["&&&&", {}],
    ["=&=&=", { "": ["", "", ""] }],
    ["a", { a: "" }],
    ["a=", { a: "" }],
    ["=b", { "": "b" }],
    ["a=1&a=2&a=3", { a: ["1", "2", "3"] }],
    ["a=1&b&a=2", { a: ["1", "2"], b: "" }],
    ["%2F=%3F", { "/": "?" }],
    ["a+b=c+d", { "a b": "c d" }],
    ["%zz=%zz", { "%zz": "%zz" }],
    ["a%00b=1", { "a\0b": "1" }],
  ])("parseQuery(%p) → %p", (input, expected) => {
    expect(parseQuery(input)).toEqual(expected);
  });

  it("10k query parameters parse without hanging", () => {
    const search = Array.from({ length: 10_000 }, (_, i) => `k${i}=${i}`).join("&");
    const start = Date.now();
    const parsed = parseQuery(search);
    expect(Object.keys(parsed)).toHaveLength(10_000);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("deeply nested percent escapes do not blow the stack", () => {
    const encoded = "%25".repeat(2000);
    expect(parseQuery(`k=${encoded}`)).toBeDefined();
  });
});

describe("anomalies: compose illegal usage", () => {
  it.each([undefined, null, 42, "fn", {}, []])("compose([%p]) throws TypeError", (value) => {
    expect(() => compose([value as Middleware])).toThrow(TypeError);
  });

  it("empty stack invokes tail exactly once", async () => {
    let calls = 0;
    await compose([])({ state: {} }, async () => {
      calls += 1;
    });
    expect(calls).toBe(1);
  });

  it("triple next() call surfaces the guard error", async () => {
    const chain = compose([
      async (_ctx, next) => {
        await next();
        await next().catch(() => undefined);
        await next().catch(() => undefined);
      },
    ]);
    await expect(chain({ state: {} }, NOOP_TAIL)).rejects.toThrow(/multiple times/);
  });

  it("sync throw in the innermost middleware propagates to the outermost catch", async () => {
    const seen: string[] = [];
    const chain = compose([
      async (_ctx, next) => {
        try {
          await next();
        } catch {
          seen.push("outer");
          throw new Error("reraised");
        }
      },
      () => {
        throw new Error("inner");
      },
    ]);
    await expect(chain({ state: {} }, NOOP_TAIL)).rejects.toThrow("reraised");
    expect(seen).toEqual(["outer"]);
  });

  it("middleware rejecting non-error still settles the chain", async () => {
    const chain = compose([
      () =>
        Promise.reject("string rejection").catch(() => {
          throw "string rejection";
        }),
    ]);
    await expect(chain({ state: {} }, NOOP_TAIL)).rejects.toBe("string rejection");
  });
});

describe("anomalies: router illegal inputs", () => {
  const badPaths = ["no-slash", "/a//b", "/:x(unbalanced", "/:?", "/a/*/b", "/:x("];
  it.each(badPaths)("route path %p throws", (path) => {
    const router = createRouter();
    expect(() => router.get(path, (ctx) => void ctx)).toThrow();
  });

  it.each(["", "//"])("edge path %p is treated as the root route", (path) => {
    const router = createRouter();
    expect(() => router.get(path, (ctx) => void ctx)).not.toThrow();
  });

  it.each([undefined, null, 42, "GET"])("register middleware %p throws", (mw) => {
    const router = createRouter();
    expect(() => router.get("/ok", mw as never)).toThrow(TypeError);
  });

  it.each(["", " ", "GET;POST", "GE T"])("method %p throws", (method) => {
    const router = createRouter();
    expect(() => router.register(method, "/x", [])).toThrow(TypeError);
  });

  it("url() for an unknown name throws a helpful error", () => {
    const router = createRouter();
    expect(() => router.url("ghost")).toThrow(/No route registered/);
  });

  it("url() missing required params throws", () => {
    const router = createRouter();
    router.get("detail", "/items/:id(\\d+)", (ctx) => void ctx);
    expect(() => router.url("detail", {})).toThrow(/Missing required parameter/);
  });

  it("param() validates both arguments", () => {
    const router = createRouter();
    expect(() => router.param("", (ctx) => void ctx)).toThrow(TypeError);
    expect(() => router.param("x", undefined as never)).toThrow(TypeError);
  });

  it("matching a path with an unmatched custom pattern 404s cleanly", async () => {
    const app = createApp(quiet);
    const router = createRouter();
    router.get("/n/:num(\\d+)", (ctx) => void ctx);
    app.use(router.routes());
    const res = await app.handle(new Request("http://localhost:3000/n/not-a-number"));
    expect(res.status).toBe(404);
  });

  it("deep path (30 segments) matches and captures correctly", async () => {
    const app = createApp(quiet);
    const router = createRouter();
    router.get("/a/:p1/b/:p2/c/*", (ctx) => {
      ctx.body = `${ctx.params.p1}-${ctx.params.p2}-${ctx.params.wildcard}`;
    });
    app.use(router.routes());
    const tail = Array.from({ length: 30 }, (_, i) => `s${i}`).join("/");
    const res = await app.handle(new Request(`http://localhost:3000/a/ONE/b/TWO/c/${tail}`));
    expect(await res.text()).toBe(`ONE-TWO-${tail}`);
  });
});

describe("anomalies: non-Error throwables from middleware", () => {
  it.each([
    ["string", "boom"],
    ["object", { deep: true }],
    ["number", 42],
    ["null-ish", null],
    ["array", [1, 2]],
  ])("%s throwables answer 500 with a clean body", async (_label, value) => {
    const app = createApp(quiet);
    app.on("error", () => {});
    app.use(async () => {
      throw value;
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Internal Server Error");
  });
});

describe("anomalies: exotic requests never crash the app", () => {
  const requests: [string, string][] = [
    ["root", "http://localhost:3000/"],
    ["double slash", "http://localhost:3000//"],
    ["encoded slash", "http://localhost:3000/a%2Fb"],
    ["dot segments", "http://localhost:3000/a/../b"],
    ["double encoded dots", "http://localhost:3000/%252e%252e/secret"],
    ["fragment", "http://localhost:3000/a#frag"],
    ["query in fragment", "http://localhost:3000/a#f?not=query"],
    ["many params", `http://localhost:3000/?${"a=1&".repeat(500)}`],
    ["long path", `http://localhost:3000/${"d/".repeat(200)}`],
    ["unicode path", "http://localhost:3000/中文/é"],
    ["bad utf8 percent", "http://localhost:3000/%FF%FE"],
  ];
  it.each(requests)("%s yields a well-formed response", async (_label, url) => {
    const app = createApp(quiet);
    app.use(async (ctx) => {
      ctx.body = `hit:${ctx.path}`;
    });
    const res = await app.handle(new Request(url));
    expect([200, 404, 500]).toContain(res.status);
    expect(res.headers.get("content-type")).toContain("text/");
  });

  it.each([
    "get",
    "GET",
    "Get",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "OPTIONS",
    "HEAD",
    "PROPFIND",
    "FANCY-CUSTOM",
  ])("method %s dispatches without crashing", async (method) => {
    const app = createApp(quiet);
    const router = createRouter();
    router.get("/x", (ctx) => {
      ctx.body = "ok";
    });
    app.use(router.routes()).use(router.allowedMethods());
    const res = await app.handle(new Request("http://localhost:3000/x", { method }));
    expect([200, 404, 405, 501]).toContain(res.status);
  });
});
