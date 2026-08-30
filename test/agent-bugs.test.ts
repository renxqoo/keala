import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/application/app.ts";
import { createResponse, linkResponsePeer } from "../src/http/response.ts";
import { isRedirectStatus } from "../src/http/status.ts";
import { createRouter } from "../src/router/router.ts";
import type { Context } from "../src/context/context.ts";

const quiet = { env: "test" as const };

/** Drive a request through an app and capture the ctx for inspection. */
const probe = async (
  init: { url: string; method?: string; headers?: Record<string, string> },
  setup?: (app: ReturnType<typeof createApp>) => void,
): Promise<Context> => {
  let captured: Context | undefined;
  const app = createApp(quiet);
  app.use(async (ctx) => {
    captured = ctx;
    ctx.status = 204;
  });
  setup?.(app);
  await app.handle(new Request(init.url, init));
  if (captured === undefined) throw new Error("probe middleware did not run");
  return captured;
};

describe("agent audit: request url/query cache chain", () => {
  it("re-assigning url invalidates the parsed query cache", async () => {
    const ctx = await probe({ url: "http://localhost:3000/old?a=1" });
    expect(ctx.query).toEqual({ a: "1" }); // build the cache first
    ctx.url = "/new?b=2";
    expect(ctx.url).toBe("/new?b=2");
    expect(ctx.querystring).toBe("b=2");
    expect(ctx.search).toBe("?b=2");
    expect(ctx.query).toEqual({ b: "2" });
    expect(ctx.request.query).toEqual({ b: "2" });
    expect(ctx.originalUrl).toBe("/old?a=1");
  });

  it("url rewrites to a query-less target clear the parsed query", async () => {
    const ctx = await probe({ url: "http://localhost:3000/old?a=1&b=2" });
    expect(ctx.query).toEqual({ a: "1", b: "2" });
    ctx.url = "/plain";
    expect(ctx.querystring).toBe("");
    expect(ctx.query).toEqual({});
  });

  it("path setter rewrites the pathname while keeping the query string", async () => {
    const ctx = await probe({ url: "http://localhost:3000/old?a=1&b=2" });
    const before = ctx.query;
    ctx.path = "/rewritten";
    expect(ctx.path).toBe("/rewritten");
    expect(ctx.url).toBe("/rewritten?a=1&b=2");
    expect(ctx.querystring).toBe("a=1&b=2");
    expect(ctx.query).toBe(before); // cache not invalidated: query is unchanged
    expect(ctx.originalUrl).toBe("/old?a=1&b=2");
  });

  it("path setter works without a query and on the request facade directly", async () => {
    const ctx = await probe({ url: "http://localhost:3000/a/b" });
    ctx.request.path = "/c";
    expect(ctx.request.path).toBe("/c");
    expect(ctx.request.url).toBe("/c");
    expect(ctx.request.querystring).toBe("");
  });
});

describe("agent audit: freshness (fresh@0.5.2 semantics)", () => {
  const freshProbe = async (
    responseSetup: (ctx: Context) => void,
    headers: Record<string, string>,
  ): Promise<boolean> => {
    let fresh: boolean | undefined;
    const app = createApp(quiet);
    app.use(async (ctx) => {
      ctx.status = 200;
      responseSetup(ctx);
      fresh = ctx.fresh;
      ctx.body = "x";
    });
    await app.handle(new Request("http://localhost:3000/", { headers }));
    return fresh === true;
  };

  it("Cache-Control: no-cache forces a stale response even when the etag matches", async () => {
    const fresh = await freshProbe(
      (ctx) => {
        ctx.etag = "v1";
      },
      { "if-none-match": '"v1"', "cache-control": "no-cache" },
    );
    expect(fresh).toBe(false);
  });

  it("a matching etag is not enough when If-Modified-Since has no validator", async () => {
    const fresh = await freshProbe(
      (ctx) => {
        ctx.etag = "v1";
      },
      { "if-none-match": '"v1"', "if-modified-since": "Mon, 01 Jan 2024 00:00:00 GMT" },
    );
    expect(fresh).toBe(false);
  });

  it("a matching etag with an outdated If-Modified-Since is stale (both validators)", async () => {
    const fresh = await freshProbe(
      (ctx) => {
        ctx.etag = "v1";
        ctx.lastModified = new Date(Date.UTC(2025, 0, 1));
      },
      {
        "if-none-match": '"v1"',
        "if-modified-since": "Mon, 01 Jan 2024 00:00:00 GMT", // predates Last-Modified
      },
    );
    expect(fresh).toBe(false);
  });

  it("etag and last-modified both matching is fresh", async () => {
    const fresh = await freshProbe(
      (ctx) => {
        ctx.etag = "v1";
        ctx.lastModified = new Date(Date.UTC(2024, 0, 1));
      },
      {
        "if-none-match": '"v1"',
        "if-modified-since": "Mon, 01 Jan 2024 00:00:00 GMT",
      },
    );
    expect(fresh).toBe(true);
  });

  it("If-None-Match without a response etag never falls back to last-modified", async () => {
    const fresh = await freshProbe(
      (ctx) => {
        ctx.lastModified = new Date(Date.UTC(2020, 0, 1));
      },
      {
        "if-none-match": '"unrelated"',
        "if-modified-since": "Wed, 01 Jan 2025 00:00:00 GMT",
      },
    );
    expect(fresh).toBe(false);
  });

  it("If-None-Match: * means fresh with no validators at all", async () => {
    const fresh = await freshProbe(() => {}, { "if-none-match": "*" });
    expect(fresh).toBe(true);
  });
});

describe("agent audit: Referrer alias and back()", () => {
  it("get() reads the Referer header through both spellings", async () => {
    const ctx = await probe({
      url: "http://localhost:3000/",
      headers: { Referer: "http://localhost:3000/login" },
    });
    expect(ctx.get("Referrer")).toBe("http://localhost:3000/login");
    expect(ctx.get("referrer")).toBe("http://localhost:3000/login");
    expect(ctx.get("Referer")).toBe("http://localhost:3000/login");
  });

  it("back() redirects to a same-origin Referer from a real request", async () => {
    const app = createApp(quiet);
    app.use((ctx) => ctx.back("/alt"));
    const res = await app.handle(
      new Request("http://example.com:3000/target", {
        headers: { Referer: "http://example.com:3000/login" },
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://example.com:3000/login");
  });

  it('redirect("back") resolves through the Referer header', async () => {
    const app = createApp(quiet);
    app.use((ctx) => ctx.redirect("back"));
    const res = await app.handle(
      new Request("http://example.com/", { headers: { Referer: "/previous" } }),
    );
    expect(res.headers.get("location")).toBe("/previous");
  });
});

describe("agent audit: redirect status classification (statuses.redirect)", () => {
  it("matches Koa's redirect class exactly", () => {
    for (const code of [300, 301, 302, 303, 305, 307, 308]) {
      expect(isRedirectStatus(code), `isRedirectStatus(${code})`).toBe(true);
    }
    for (const code of [200, 204, 304, 306, 400]) {
      expect(isRedirectStatus(code), `isRedirectStatus(${code})`).toBe(false);
    }
  });

  it("redirect() replaces a previously-set 304 instead of keeping it", async () => {
    const app = createApp(quiet);
    app.use((ctx) => {
      ctx.status = 304;
      ctx.redirect("/next");
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/next");
  });

  it("redirect() keeps 305 (a real redirect status)", async () => {
    const app = createApp(quiet);
    app.use((ctx) => {
      ctx.status = 305;
      ctx.redirect("/proxy");
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(305);
    expect(res.headers.get("location")).toBe("/proxy");
  });

  it("redirect() resets a custom status message when coercing to 302", () => {
    const response = createResponse();
    linkResponsePeer(response, {
      request: {
        method: "GET",
        href: "http://localhost:3000/",
        host: "localhost:3000",
        get: () => "",
        accepts: () => "text/plain",
      },
    });
    response.status = 404;
    response.message = "Custom Phrase";
    response.redirect("/elsewhere");
    expect(response.status).toBe(302);
    expect(response.message).toBe("Found");
  });
});

describe("agent audit: emitter once/off edges", () => {
  it("off() with an unknown listener is a no-op and keeps other listeners", () => {
    const app = createApp(quiet);
    const keep = vi.fn();
    app.on("error", keep);
    app.off("error", vi.fn());
    expect(app.listenerCount("error")).toBe(1);
    app.emit("error", new Error("x"));
    expect(keep).toHaveBeenCalledTimes(1);
  });

  it("the disposer returned by once() unsubscribes the wrapper", () => {
    const app = createApp(quiet);
    const spy = vi.fn();
    const dispose = app.once("error", spy);
    dispose();
    expect(app.emit("error", new Error("x"))).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    expect(app.listenerCount("error")).toBe(0);
  });

  it("once() fires exactly once across repeated emits", () => {
    const app = createApp(quiet);
    const spy = vi.fn();
    app.once("error", spy);
    app.emit("error", new Error("a"));
    app.emit("error", new Error("b"));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("re-subscribing after the last off() works on a fresh list", () => {
    const app = createApp(quiet);
    const first = vi.fn();
    const sub = app.on("error", first);
    sub();
    expect(app.listenerCount("error")).toBe(0);
    const second = vi.fn();
    app.on("error", second);
    app.emit("error", new Error("c"));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe("agent audit: router mount and trie encoding", () => {
  it("router.use(prefix) keeps the query string visible downstream", async () => {
    const router = createRouter();
    const app = createApp(quiet);
    const seen: string[] = [];
    // Upstream of the router: after next() resolves the url is restored.
    app.use(async (ctx, next) => {
      await next();
      seen.push(`upstream-after:${ctx.url}`);
    });
    router.use("/api", async (ctx, next) => {
      seen.push(`mounted:${ctx.url}`, `query:${JSON.stringify(ctx.query)}`);
      await next();
      // koa-mount semantics: the mounted subtree still sees the stripped url.
      seen.push(`mounted-after:${ctx.url}`);
    });
    router.get("/api/users", (ctx) => {
      ctx.body = { page: ctx.query["page"] };
    });
    app.use(router.routes());
    const res = await app.handle(new Request("http://localhost:3000/api/users?page=2&size=10"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ page: "2" });
    expect(seen[0]).toBe("mounted:/users?page=2&size=10");
    expect(seen[1]).toBe(`query:${JSON.stringify({ page: "2", size: "10" })}`);
    expect(seen[2]).toBe("mounted-after:/users?page=2&size=10");
    expect(seen[3]).toBe("upstream-after:/api/users?page=2&size=10");
  });

  it("percent-encoded static segments inside dynamic routes match", async () => {
    const router = createRouter();
    const app = createApp(quiet);
    router.get("/caf%C3%A9/:id", (ctx) => {
      ctx.body = { id: ctx.params["id"] };
    });
    app.use(router.routes());
    const res = await app.handle(new Request("http://localhost:3000/caf%C3%A9/42"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "42" });
  });

  it("unicode route patterns match percent-encoded requests", async () => {
    const router = createRouter();
    const app = createApp(quiet);
    router.get("/café/:id", (ctx) => {
      ctx.body = `ok:${ctx.params["id"]}`;
    });
    app.use(router.routes());
    const res = await app.handle(new Request("http://localhost:3000/caf%C3%A9/7"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok:7");
  });

  it("keeps %2F inside a single param segment (no path splitting)", async () => {
    const router = createRouter();
    const app = createApp(quiet);
    router.get("/files/:name", (ctx) => {
      ctx.body = `file:${ctx.params["name"]}`;
    });
    app.use(router.routes());
    // %2F stays a single segment for matching purposes (no path splitting).
    const res = await app.handle(new Request("http://localhost:3000/files/a%2Fb"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("file:a/b");
  });
});

describe("agent audit: response details", () => {
  it("length setter is a no-op while Transfer-Encoding is set", () => {
    const response = createResponse();
    response.set("Transfer-Encoding", "chunked");
    response.length = 99;
    expect(response.get("Content-Length")).toBe("");
    response.remove("Transfer-Encoding");
    response.length = 99;
    expect(response.get("Content-Length")).toBe("99");
  });
});

describe("agent audit: is() array form (type-is compatibility)", () => {
  it("ctx.is() accepts a single array of candidate types", async () => {
    const ctx = await probe({
      url: "http://localhost:3000/",
      headers: { "Content-Type": "application/json" },
    });
    expect(ctx.is(["json", "html"])).toBe("json");
    expect(ctx.is(["html", "xml"])).toBe(false);
  });

  it("response.is() accepts a single array of candidate types", async () => {
    const app = createApp(quiet);
    let matched: string | false = "";
    app.use((ctx) => {
      ctx.type = "image/png";
      matched = ctx.response.is(["png", "jpeg"]);
      ctx.status = 204;
    });
    await app.handle(new Request("http://localhost:3000/"));
    expect(matched).toBe("png");
  });

  it("varargs form is unchanged", async () => {
    const ctx = await probe({
      url: "http://localhost:3000/",
      headers: { "Content-Type": "text/html" },
    });
    expect(ctx.is("html", "json")).toBe("html");
  });
});

describe("agent audit: app.onerror contract", () => {
  it("tolerates a null error outside the test env", () => {
    const app = createApp({ env: "development" });
    expect(() => app.onerror(null as unknown as Error)).not.toThrow();
  });

  it("still forwards real errors to listeners", () => {
    const app = createApp({ env: "development" });
    const spy = vi.fn();
    app.on("error", spy);
    app.onerror(new Error("real"));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("agent audit: compose next() guard under nesting", () => {
  it("rejects a second next() from a route handler nested in app middleware", async () => {
    const app = createApp(quiet);
    const router = createRouter();
    let message = "";
    app.use(async (_ctx, next) => {
      try {
        await next();
      } catch (err) {
        message = (err as Error).message;
      }
    });
    router.get("/double", async (_ctx, next) => {
      await next();
      await next(); // the bug pattern: calling next twice
    });
    app.use(router.routes());
    await app.handle(new Request("http://localhost:3000/double"));
    expect(message).toBe("next() called multiple times in the same middleware");
  });

  it("still resolves when the same handler serves many sequential requests", async () => {
    const app = createApp(quiet);
    const router = createRouter();
    router.get("/seq", async (ctx, next) => {
      await next();
      ctx.body = "done";
    });
    app.use(async (_ctx, next) => next());
    app.use(router.routes());
    for (let i = 0; i < 5; i++) {
      const res = await app.handle(new Request("http://localhost:3000/seq"));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("done");
    }
  });
});
