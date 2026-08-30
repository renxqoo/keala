/**
 * Koa 3.2.1 parity tests.
 *
 * The official koa test suite is not shipped in the npm package, so these are
 * behavior-equivalent ports of the assertions in koa's
 * test/{context,response,request,application}.js, verified against the
 * koa@3.2.1 sources in node_modules/koa/lib.
 */

import { describe, expect, it } from "vitest";

import { createApp } from "../src/application/app.ts";
import type { Context } from "../src/context/context.ts";
import { createRouter } from "../src/router/router.ts";

const quiet = { env: "test" } as const;

const probe = async (
  setup: Parameters<ReturnType<typeof createApp>["use"]>[0] extends never
    ? never
    : (ctx: Context) => void,
  url = "http://localhost:3000/",
  init?: RequestInit,
): Promise<Response> => {
  const app = createApp(quiet);
  app.use(async (ctx) => {
    await setup(ctx);
  });
  return app.handle(new Request(url, init));
};

const capture = async (url = "http://localhost:3000/", init?: RequestInit): Promise<Context> => {
  const app = createApp(quiet);
  let ctx: Context | undefined;
  app.use(async (c) => {
    ctx = c;
    c.status = 204;
  });
  await app.handle(new Request(url, init));
  if (ctx === undefined) throw new Error("probe failed");
  return ctx;
};

describe("koa parity: response body semantics (response.js)", () => {
  it("string bodies sniff html vs text", async () => {
    const html = await probe((ctx) => {
      ctx.body = "<h1>hi</h1>";
    });
    expect(html.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const text = await probe((ctx) => {
      ctx.body = "just words";
    });
    expect(text.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const indentedHtml = await probe((ctx) => {
      ctx.body = "  <p>spaced markup</p>";
    });
    expect(indentedHtml.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it("JSON-typed body=null yields the literal string null (koa 3)", async () => {
    const res = await probe((ctx) => {
      ctx.type = "application/json";
      ctx.body = { a: 1 };
      ctx.body = null;
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("null");
    expect(res.headers.get("content-type")).toBe("application/json");
  });

  it("non-JSON body=null maps to 204", async () => {
    const res = await probe((ctx) => {
      ctx.body = "temp";
      ctx.body = null;
    });
    expect(res.status).toBe(204);
  });

  it("explicit null body on an empty status keeps it bodyless", async () => {
    const res = await probe((ctx) => {
      ctx.status = 304;
      ctx.body = null;
    });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
    expect(res.headers.get("content-type")).toBe(null);
  });

  it("objects are JSON stringified with charset", async () => {
    const res = await probe((ctx) => {
      ctx.body = { east: "北京", n: 1 };
    });
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await res.json()).toEqual({ east: "北京", n: 1 });
  });

  it("Uint8Array bodies default to application/octet-stream", async () => {
    const res = await probe((ctx) => {
      ctx.body = new Uint8Array([104, 105]);
    });
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(await res.text()).toBe("hi");
  });

  it("Blob bodies carry their size as Content-Length and default to bin (koa parity)", async () => {
    const res = await probe(
      (ctx) => {
        ctx.body = new Blob(["blob!"], { type: "text/plain" });
      },
      "http://localhost:3000/",
      { method: "HEAD" },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("5");
    // koa 3 forces 'bin' when no type was set explicitly
    expect(res.headers.get("content-type")).toBe("application/octet-stream");

    const typed = await probe((ctx) => {
      ctx.type = "text/plain";
      ctx.body = new Blob(["blob!"]);
    });
    expect(typed.headers.get("content-type")).toBe("text/plain");
  });

  it("a web Response can be assigned directly as the body", async () => {
    const upstream = new Response("from upstream", {
      status: 201,
      headers: { "X-From": "upstream", "Content-Type": "text/csv" },
    });
    const res = await probe((ctx) => {
      ctx.body = upstream;
    });
    expect(res.status).toBe(201);
    expect(await res.text()).toBe("from upstream");
    expect(res.headers.get("x-from")).toBe("upstream");
    expect(res.headers.get("content-type")).toBe("text/csv");
  });

  it("setting an empty status clears the body immediately (koa parity)", async () => {
    const ctx = await capture();
    ctx.body = "will vanish";
    ctx.status = 204;
    expect(ctx.body).toBe(null);
  });

  it("streams default to application/octet-stream", async () => {
    const res = await probe((ctx) => {
      ctx.body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("chunk"));
          controller.close();
        },
      });
    });
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(await res.text()).toBe("chunk");
  });
});

describe("koa parity: query and url (request.js)", () => {
  it("set query rewrites the querystring (koa search-params semantics)", async () => {
    const ctx = await capture("http://localhost:3000/search?old=1&page=9");
    ctx.query = Object.assign(Object.create(null), {
      keywords: ["a", "b"],
      page: "2",
      empty: "",
    });
    expect(ctx.querystring).toBe("keywords=a&keywords=b&page=2&empty=");
    expect(ctx.path).toBe("/search");
  });

  it("query getter caches and supports arrays", async () => {
    const ctx = await capture("http://localhost:3000/?tag=x&tag=y&single=1");
    expect(ctx.query).toEqual({ tag: ["x", "y"], single: "1" });
    expect(ctx.query).toBe(ctx.query);
    expect(ctx.search).toBe("?tag=x&tag=y&single=1");
  });

  it("url rewrite keeps originalUrl intact", async () => {
    const ctx = await capture("http://localhost:3000/old?x=1");
    ctx.url = "/rewritten";
    expect(ctx.url).toBe("/rewritten");
    expect(ctx.path).toBe("/rewritten");
    expect(ctx.originalUrl).toBe("/old?x=1");
  });
});

describe("koa parity: context delegates (context.js)", () => {
  it("ctx.status/message defaults and overrides", async () => {
    const res = await probe((ctx) => {
      expect(ctx.status).toBe(404);
      expect(ctx.message).toBe("Not Found");
      ctx.status = 418;
      expect(ctx.message).toBe("I'm a teapot");
      ctx.message = "short and stout";
      ctx.body = "x";
    });
    expect(res.status).toBe(418);
    expect(res.statusText).toBe("short and stout");
  });

  it("redirect(back) prefers Referrer then alt then /", async () => {
    const referrer = await probe(
      (ctx) => {
        ctx.redirect("back", "/alt");
      },
      "http://localhost:3000/",
      { headers: { Referrer: "/previous-page" } },
    );
    expect(referrer.headers.get("location")).toBe("/previous-page");

    const alt = await probe((ctx) => {
      ctx.redirect("back", "/alt");
    });
    expect(alt.headers.get("location")).toBe("/alt");

    const root = await probe((ctx) => {
      ctx.redirect("back");
    });
    expect(root.headers.get("location")).toBe("/");
  });

  it("attachment with unicode filenames emits RFC 5987 encoding", async () => {
    const res = await probe((ctx) => {
      ctx.attachment("年度报告.csv");
    });
    expect(res.headers.get("content-disposition")).toContain("filename*=UTF-8''");
    expect(res.headers.get("content-type")).toBe("text/csv");
  });

  it("etag setter quotes bare values", async () => {
    const res = await probe((ctx) => {
      ctx.etag = "v42";
      ctx.body = "x";
    });
    expect(res.headers.get("etag")).toBe('"v42"');
  });

  it("subdomains respect subdomainOffset", async () => {
    const ctx = await capture("http://a.b.c.example.com/", {
      headers: { Host: "a.b.c.example.com" },
    });
    expect(ctx.subdomains).toEqual(["c", "b", "a"]); // offset 2 skips com+example
    ctx.app.subdomainOffset = 3;
    expect(ctx.subdomains).toEqual(["b", "a"]); // offset 3 also skips c
  });
});

describe("koa parity: application behavior (application.js)", () => {
  it("unhandled requests answer 404 Not Found", async () => {
    const app = createApp(quiet);
    const res = await app.handle(new Request("http://localhost:3000/nowhere"));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not Found");
  });

  it("app.toJSON shape matches koa", () => {
    expect(createApp({ proxy: true, env: "prod" }).toJSON()).toEqual({
      subdomainOffset: 2,
      proxy: true,
      env: "prod",
    });
  });

  it("error events receive (err, ctx) and headerSent stays false pre-respond", async () => {
    const app = createApp(quiet);
    const seen: Array<{ message: string; url: string; headerSent: boolean }> = [];
    app.on("error", (err, ctx) => {
      seen.push({
        message: (err as Error).message,
        url: ctx?.request.url ?? "",
        headerSent: ctx?.response.headerSent ?? false,
      });
    });
    app.use(async () => {
      throw new Error("planned");
    });
    const res = await app.handle(new Request("http://localhost:3000/boom"));
    expect(res.status).toBe(500);
    expect(seen).toEqual([{ message: "planned", url: "/boom", headerSent: false }]);
  });

  it("onerror tolerates null errors (koa context.onerror contract)", () => {
    const app = createApp(quiet);
    expect(() => app.onerror(null as unknown as Error)).not.toThrow();
  });
});

describe("koa parity: router (@koa/router)", () => {
  it("custom param patterns constrain matches", async () => {
    const app = createApp(quiet);
    const router = createRouter();
    router.get("/posts/:id(\\d+)", (ctx) => {
      ctx.body = `post:${ctx.params.id}`;
    });
    app.use(router.routes()).use(router.allowedMethods());
    const hit = await app.handle(new Request("http://localhost:3000/posts/99"));
    expect(await hit.text()).toBe("post:99");
    const miss = await app.handle(new Request("http://localhost:3000/posts/abc"));
    expect(miss.status).toBe(404);
  });

  it("optional params match with and without the segment", async () => {
    const app = createApp(quiet);
    const router = createRouter();
    router.get("/docs/:section?/intro", (ctx) => {
      ctx.body = JSON.stringify(ctx.params);
    });
    app.use(router.routes());
    const withParam = await app.handle(new Request("http://localhost:3000/docs/api/intro"));
    expect(await withParam.text()).toBe(JSON.stringify({ section: "api" }));
    const without = await app.handle(new Request("http://localhost:3000/docs/intro"));
    expect(await without.text()).toBe(JSON.stringify(Object.create(null)));
  });

  it("multi-handler routes run in onion order with downstream access", async () => {
    const app = createApp(quiet);
    const router = createRouter();
    router.get(
      "/chain",
      async (ctx, next) => {
        ctx.set("X-First", "in");
        await next();
        ctx.set("X-First", "out");
      },
      async (ctx) => {
        ctx.set("X-Second", "yes");
        ctx.body = "chain";
      },
    );
    app.use(router.routes());
    const res = await app.handle(new Request("http://localhost:3000/chain"));
    expect(res.headers.get("x-first")).toBe("out");
    expect(res.headers.get("x-second")).toBe("yes");
  });

  it("router.url builds paths from params (koa-router url())", () => {
    const router = createRouter();
    router.get("user-posts", "/users/:user_id/posts/:post_id(\\d+)", (ctx) => void ctx);
    expect(router.url("user-posts", { user_id: "alice", post_id: "7" })).toBe(
      "/users/alice/posts/7",
    );
  });

  it("wildcards capture the tail including slashes", async () => {
    const app = createApp(quiet);
    const router = createRouter();
    router.get("/static/*", (ctx) => {
      ctx.body = ctx.params.wildcard ?? "";
    });
    app.use(router.routes());
    const res = await app.handle(new Request("http://localhost:3000/static/js/app/main.js"));
    expect(await res.text()).toBe("js/app/main.js");
  });
});
