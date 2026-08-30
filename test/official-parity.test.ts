/**
 * Parity tests ported from the official suites in the cloned source repos
 * (koa@3.2.1 __tests__, @koa/router@13 test/lib, hono@4.13.5 src/*.test.ts).
 * Each group names the upstream file it mirrors.
 */

import { describe, expect, it } from "vitest";

import { createApp } from "../src/application/app.ts";
import { createResponse, linkResponsePeer } from "../src/http/response.ts";
import type { Context } from "../src/context/context.ts";
import { contentDisposition } from "../src/utils/text.ts";

const quiet = { env: "test" } as const;

const drive = (app: ReturnType<typeof createApp>, url: string, init?: RequestInit) =>
  app.handle(new Request(url, init));

const capture = async (
  app: ReturnType<typeof createApp>,
  url = "http://localhost:3000/",
): Promise<Context> => {
  let ctx: Context | undefined;
  app.use(async (c) => {
    ctx = c;
    c.status = 204;
  });
  await app.handle(new Request(url));
  if (ctx === undefined) throw new Error("probe failed");
  return ctx;
};

describe("koa __tests__/context/onerror.test.js", () => {
  it("unsets all previous headers on error responses", async () => {
    const app = createApp(quiet);
    app.use(async (ctx) => {
      ctx.set("Vary", "Accept-Encoding");
      ctx.set("X-CSRF-Token", "asdf");
      ctx.body = "response";
      ctx.throw(418, "boom");
    });
    const res = await drive(app, "http://localhost:3000/");
    expect(res.status).toBe(418);
    expect(await res.text()).toBe("boom");
    expect(res.headers.get("vary")).toBe(null);
    expect(res.headers.get("x-csrf-token")).toBe(null);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });

  it("still applies headers carried by the error", async () => {
    const app = createApp(quiet);
    app.use(async (ctx) => {
      ctx.set("X-Doomed", "gone");
      ctx.throw(429, "slow", { headers: { "Retry-After": "10" } });
    });
    const res = await drive(app, "http://localhost:3000/");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("10");
    expect(res.headers.get("x-doomed")).toBe(null);
  });

  it("honors err.statusCode (node-style)", async () => {
    const app = createApp(quiet);
    app.use(async () => {
      const err = new Error("Not found");
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    });
    const res = await drive(app, "http://localhost:3000/");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not Found");
  });

  it("ignores props.status in throw (status comes from the first arg)", async () => {
    const app = createApp(quiet);
    app.use(async (ctx) => {
      ctx.throw(400, "bad", { status: 500 } as never);
    });
    const res = await drive(app, "http://localhost:3000/");
    expect(res.status).toBe(400);
  });

  it("responds 500 for invalid err.status values", async () => {
    const app = createApp(quiet);
    app.use(async () => {
      const err = new Error("weird") as Error & { status: number };
      err.status = 9999;
      throw err;
    });
    const res = await drive(app, "http://localhost:3000/");
    expect(res.status).toBe(500);
  });
});

describe("koa __tests__/response/type.test.js", () => {
  it("expands extension shorthands with charset", async () => {
    const ctx = await capture(createApp());
    ctx.type = "json";
    expect(ctx.type).toBe("application/json");
    expect(ctx.response.get("Content-Type")).toBe("application/json; charset=utf-8");
    ctx.type = "html";
    expect(ctx.response.get("Content-Type")).toBe("text/html; charset=utf-8");
    ctx.type = "png";
    expect(ctx.response.get("Content-Type")).toBe("image/png");
    ctx.type = "bin";
    expect(ctx.response.get("Content-Type")).toBe("application/octet-stream");
  });

  it("keeps full MIME values untouched", async () => {
    const ctx = await capture(createApp());
    ctx.type = "application/vnd.api+json";
    expect(ctx.response.get("Content-Type")).toBe("application/vnd.api+json");
  });
});

describe("koa __tests__/response/set.test.js", () => {
  it("sets multiple fields from an object", async () => {
    const app = createApp(quiet);
    app.use(async (ctx) => {
      ctx.set({ foo: "1", bar: "2" } as unknown as Parameters<typeof ctx.set>[0]);
      ctx.body = "ok";
    });
    const res = await drive(app, "http://localhost:3000/");
    expect(res.headers.get("foo")).toBe("1");
    expect(res.headers.get("bar")).toBe("2");
  });
});

describe("koa __tests__/response/status.test.js", () => {
  it("204/205/304 strip content headers immediately", async () => {
    const ctx = await capture(createApp());
    ctx.type = "text/html";
    ctx.body = "body";
    ctx.status = 204;
    expect(ctx.body).toBe(null);
    expect(ctx.response.get("Content-Type")).toBe("");
    expect(ctx.response.get("Content-Length")).toBe("");
  });
});

describe("koa __tests__/response/attachment.test.js (incl. GHSA-c5vw-j4hf-j526)", () => {
  it("does NOT override an already-set Content-Type", async () => {
    const ctx = await capture(createApp());
    ctx.response.set("Content-Type", "application/octet-stream");
    ctx.attachment("malicious.html");
    expect(ctx.response.get("Content-Type")).toBe("application/octet-stream");
    expect(ctx.response.get("Content-Disposition")).toBe('attachment; filename="malicious.html"');
  });

  it("strips directory components from filenames", async () => {
    const ctx = await capture(createApp());
    ctx.attachment("path/to/report.pdf");
    expect(ctx.response.get("Content-Disposition")).toBe('attachment; filename="report.pdf"');
    expect(ctx.response.get("Content-Type")).toBe("application/pdf");
  });

  it("masks non-ascii filenames with ? by default (content-disposition pkg)", () => {
    expect(contentDisposition("中文名-ok.png")).toBe(
      "attachment; filename=\"???-ok.png\"; filename*=UTF-8''%E4%B8%AD%E6%96%87%E5%90%8D-ok.png",
    );
    expect(contentDisposition("a.png", false)).toBe(
      "attachment; filename*=UTF-8''a.png".replace("a.png", "a.png"),
    );
    expect(contentDisposition("a.png", false)).toBe("attachment; filename*=UTF-8''a.png");
  });

  it("supports the type option (inline) with normalization and validation", async () => {
    const ctx = await capture(createApp());
    ctx.attachment(undefined, { type: "inline" });
    expect(ctx.response.get("Content-Disposition")).toBe("inline");
    ctx.attachment("plans.pdf", { type: "INLINE" });
    expect(ctx.response.get("Content-Disposition")).toBe('inline; filename="plans.pdf"');
    expect(() => ctx.attachment("a.pdf", { type: 42 as unknown as string })).toThrow(
      /invalid type/,
    );
    expect(() => ctx.attachment("a.pdf", { type: "bad;type" })).toThrow(/invalid type/);
  });
});

describe("koa __tests__/request/search + querystring setters", () => {
  it("search= rewrites url, querystring and query", async () => {
    const ctx = await capture(createApp(), "http://localhost:3000/store/shoes");
    ctx.search = "?page=2&color=blue";
    expect(ctx.url).toBe("/store/shoes?page=2&color=blue");
    expect(ctx.search).toBe("?page=2&color=blue");
    expect(ctx.querystring).toBe("page=2&color=blue");
    expect(ctx.query.page).toBe("2");
    expect(ctx.originalUrl).toBe("/store/shoes");
  });

  it("querystring= rewrites the raw query string", async () => {
    const ctx = await capture(createApp(), "http://localhost:3000/a?old=1");
    ctx.querystring = "x=1&x=2";
    expect(ctx.url).toBe("/a?x=1&x=2");
    expect(ctx.query).toEqual({ x: ["1", "2"] });
  });

  it("empty search/querystring clears the query", async () => {
    const ctx = await capture(createApp(), "http://localhost:3000/a?old=1");
    ctx.search = "";
    expect(ctx.url).toBe("/a");
    ctx.querystring = "again=1";
    ctx.querystring = "";
    expect(ctx.url).toBe("/a");
  });
});

describe("koa __tests__/request/misc", () => {
  it("exposes req.URL", async () => {
    const ctx = await capture(createApp(), "http://localhost:3000/p?x=1");
    expect(ctx.request.URL?.pathname).toBe("/p");
    expect(ctx.URL?.search).toBe("?x=1");
  });

  it("accepts() resolves extension shorthands", async () => {
    const app = createApp(quiet);
    let result: string | string[] | false = false;
    app.use(async (ctx) => {
      result = ctx.accepts("png", "html");
      ctx.status = 204;
    });
    await drive(app, "http://localhost:3000/", { headers: { Accept: "image/png" } });
    expect(result).toBe("png");
  });

  it("length is undefined without a body or header", async () => {
    const ctx = await capture(createApp());
    expect(ctx.response.length).toBeUndefined();
    ctx.response.set("Content-Length", "abc");
    expect(ctx.response.length).toBe(0); // koa: parseInt || 0
  });
});

describe("koa __tests__/application/context.test.js — extension layers", () => {
  it("app.context properties reach middleware and stay app-scoped", async () => {
    const app1 = createApp(quiet);
    (app1.context as Record<string, unknown>).msg = "hello";
    const app2 = createApp(quiet);

    let seen1: unknown;
    app1.use(async (ctx) => {
      seen1 = (ctx as unknown as Record<string, unknown>).msg;
      ctx.status = 204;
    });
    await app1.handle(new Request("http://localhost:3000/"));
    expect(seen1).toBe("hello");

    let seen2: unknown;
    app2.use(async (ctx) => {
      seen2 = (ctx as unknown as Record<string, unknown>).msg;
      ctx.status = 204;
    });
    await app2.handle(new Request("http://localhost:3000/"));
    expect(seen2).toBeUndefined();
  });

  it("app.request / app.response extension layers work", async () => {
    const app = createApp(quiet);
    (app.request as Record<string, unknown>).traceId = "fixed";
    (app.response as Record<string, unknown>).branded = true;
    let requestTrace: unknown;
    let responseBranded: unknown;
    app.use(async (ctx) => {
      requestTrace = (ctx.request as unknown as Record<string, unknown>).traceId;
      responseBranded = (ctx.response as unknown as Record<string, unknown>).branded;
      ctx.status = 204;
    });
    await app.handle(new Request("http://localhost:3000/"));
    expect(requestTrace).toBe("fixed");
    expect(responseBranded).toBe(true);
  });
});

describe("koa app.currentContext (opt-in)", () => {
  it("exposes the running context across awaits", async () => {
    const app = createApp({ ...quiet, currentContext: true });
    const observed: (Context | undefined)[] = [];
    app.use(async (ctx) => {
      observed.push(app.currentContext);
      await new Promise((resolve) => setTimeout(resolve, 1));
      observed.push(app.currentContext);
      ctx.body = "done";
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(await res.text()).toBe("done");
    expect(observed[0]).toBe(observed[1]);
    expect(observed[0]?.url).toBe("/");
    expect(app.currentContext).toBeUndefined();
  });

  it("is undefined unless enabled", async () => {
    const app = createApp(quiet);
    let seen: Context | undefined = "unset" as unknown as Context;
    app.use(async (ctx) => {
      seen = app.currentContext;
      ctx.status = 204;
    });
    await app.handle(new Request("http://localhost:3000/"));
    expect(seen).toBeUndefined();
  });
});

describe("koa ctx.toJSON / inspect", () => {
  it("serializes request and response state", async () => {
    const app = createApp(quiet);
    let json: ReturnType<Context["toJSON"]> | undefined;
    app.use(async (ctx) => {
      ctx.set("X-Mark", "1");
      ctx.body = "payload";
      json = ctx.toJSON();
    });
    await app.handle(new Request("http://localhost:3000/x?a=1", { headers: { "X-Probe": "yes" } }));
    const request = json?.request as
      | { method: string; url: string; header: Record<string, string> }
      | undefined;
    const response = json?.response as
      | { status: number; headers: Record<string, string> }
      | undefined;
    expect(request?.method).toBe("GET");
    expect(request?.url).toBe("/x?a=1");
    expect(request?.header["x-probe"]).toBe("yes");
    expect(response?.status).toBe(200);
    expect(response?.headers["x-mark"]).toBe("1");
  });
});

/** Koa's suite drives contexts directly via test-helpers (no real HTTP);
 * the equivalent here is a hand-built response with a fake request peer. */
const makeBackResponse = (host: string, referrer: string) => {
  const response = createResponse();
  linkResponsePeer(response, {
    request: {
      method: "GET",
      href: `http://${host}/`,
      host,
      get: (field: string) => (field.toLowerCase() === "referrer" ? referrer : ""),
      accepts: () => "text/plain",
    },
  });
  return response;
};

describe("koa __tests__/response/back.test.js", () => {
  it("redirects to a relative Referrer", () => {
    const response = makeBackResponse("example.com", "/login");
    response.back();
    expect(response.get("Location")).toBe("/login");
  });

  it("redirects to a same-origin absolute referrer", () => {
    const response = makeBackResponse("example.com", "https://example.com/login");
    response.back();
    expect(response.get("Location")).toBe("https://example.com/login");
  });

  it("falls back to root on cross-origin referrer", () => {
    const response = makeBackResponse("example.com", "https://other.com/login");
    response.back();
    expect(response.get("Location")).toBe("/");
  });

  it("falls back to alt on cross-origin referrer", () => {
    const response = makeBackResponse("example.com", "https://other.com/login");
    response.back("/home");
    expect(response.get("Location")).toBe("/home");
  });

  it("falls back to alt when no referrer exists", () => {
    const response = makeBackResponse("example.com", "");
    response.back("/alt");
    expect(response.get("Location")).toBe("/alt");
    response.remove("Location");
    response.back();
    expect(response.get("Location")).toBe("/");
  });

  it("back() through the ctx delegate matches", async () => {
    const app = createApp(quiet);
    let location = "";
    app.use(async (ctx) => {
      ctx.back("/ctx-alt");
      location = ctx.response.get("Location");
    });
    await app.handle(new Request("http://localhost:3000/"));
    expect(location).toBe("/ctx-alt");
  });
});

describe("koa __tests__/response/is.test.js", () => {
  const withType = async (type: string | null) => {
    const app = createApp(quiet);
    let result: string | false | null = null;
    let argless: string | false | null = null;
    app.use(async (ctx) => {
      if (type !== null) ctx.response.type = type;
      argless = ctx.response.is();
      result = ctx.response.is("png", "text/*", "*/png", ".png", "jpeg");
      ctx.status = 204;
    });
    await app.handle(new Request("http://localhost:3000/"));
    return { argless, result };
  };

  it("returns false when no type is set", async () => {
    const { argless, result } = await withType(null);
    expect(argless).toBe(false);
    expect(result).toBe(false);
  });

  it("returns the type with no arguments", async () => {
    const { argless } = await withType("text/html; charset=utf-8");
    expect(argless).toBe("text/html");
  });

  it("matches shorthands, extensions, type and subtype wildcards", async () => {
    const app = createApp(quiet);
    const seen: (string | false)[] = [];
    app.use(async (ctx) => {
      ctx.response.type = "image/png";
      seen.push(ctx.response.is("png"));
      seen.push(ctx.response.is(".png"));
      seen.push(ctx.response.is("image/png"));
      seen.push(ctx.response.is("image/*"));
      seen.push(ctx.response.is("*/png"));
      seen.push(ctx.response.is("jpeg"));
      seen.push(ctx.response.is(".jpeg"));
      seen.push(ctx.response.is("text/*"));
      seen.push(ctx.response.is("*/jpeg"));
      ctx.status = 204;
    });
    await app.handle(new Request("http://localhost:3000/"));
    expect(seen).toEqual([
      "png",
      ".png",
      "image/png",
      "image/*",
      "*/png",
      false,
      false,
      false,
      false,
    ]);
  });
});
