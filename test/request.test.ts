import { describe, expect, it } from "vitest";

import { createApp } from "../src/application/app.ts";
import type { Context } from "../src/context/context.ts";

const probe = async (
  init: { url: string; method?: string; headers?: Record<string, string> },
  proxy = false,
): Promise<Context> => {
  let captured: Context | undefined;
  const probing = createApp({ keys: ["k"], proxy, proxyIpHeader: "x-forwarded-for" });
  probing.use(async (ctx) => {
    captured = ctx;
    ctx.status = 204;
  });
  await probing.handle(new Request(init.url, init));
  if (captured === undefined) throw new Error("probe middleware did not run");
  return captured;
};

describe("request facade", () => {
  it("exposes method, url, path and originalUrl", async () => {
    const ctx = await probe({
      url: "http://localhost:3000/users/42?page=2&size=10",
      method: "GET",
    });
    expect(ctx.method).toBe("GET");
    expect(ctx.url).toBe("/users/42?page=2&size=10");
    expect(ctx.originalUrl).toBe("/users/42?page=2&size=10");
    expect(ctx.path).toBe("/users/42");
    expect(ctx.querystring).toBe("page=2&size=10");
    expect(ctx.search).toBe("?page=2&size=10");
  });

  it("supports url rewriting for routing", async () => {
    const ctx = await probe({ url: "http://localhost:3000/old?q=1", method: "GET" });
    ctx.url = "/new";
    expect(ctx.url).toBe("/new");
    expect(ctx.path).toBe("/new");
    expect(ctx.originalUrl).toBe("/old?q=1");
  });

  it("parses and caches the query", async () => {
    const ctx = await probe({ url: "http://localhost:3000/?tags=a&tags=b", method: "GET" });
    expect(ctx.query).toEqual({ tags: ["a", "b"] });
    expect(ctx.query).toBe(ctx.query);
    const replacement = Object.create(null) as Record<string, string>;
    ctx.query = replacement;
    expect(ctx.query).toBe(replacement);
  });

  it("reads headers case-insensitively", async () => {
    const ctx = await probe({
      url: "http://localhost:3000/",
      method: "GET",
      headers: { "X-Custom": "yes", "Content-Type": "application/json; charset=utf-8" },
    });
    expect(ctx.get("X-CUSTOM")).toBe("yes");
    expect(ctx.get("x-custom")).toBe("yes");
    expect(ctx.get("missing")).toBe("");
    expect(ctx.header.get("x-custom")).toBe("yes");
    expect(ctx.headers).toBe(ctx.request.header);
    expect(ctx.request.type).toBe("application/json");
    expect(ctx.charset).toBe("utf-8");
    expect(ctx.is("json")).toBe("json");
    expect(ctx.is()).toBe("application/json");
    expect(ctx.is("html")).toBe(false);
  });

  it("reports length, idempotency and href", async () => {
    const ctx = await probe({
      url: "http://localhost:3000/a/b?x=1",
      method: "PUT",
      headers: { "Content-Length": "42" },
    });
    expect(ctx.request.length).toBe(42);
    expect(ctx.idempotent).toBe(true);
    expect(ctx.host).toBe("localhost:3000");
    expect(ctx.hostname).toBe("localhost");
    expect(ctx.protocol).toBe("http");
    expect(ctx.secure).toBe(false);
    expect(ctx.origin).toBe("http://localhost:3000");
    expect(ctx.href).toBe("http://localhost:3000/a/b?x=1");
  });

  it("derives host from the URL when the Host header is absent", async () => {
    const app = createApp();
    let captured: Context | undefined;
    app.use(async (ctx) => {
      captured = ctx;
      ctx.status = 204;
    });
    await app.handle(new Request("http://localhost:3000/x"));
    expect(captured?.host).toBe("localhost:3000");
    expect(captured?.hostname).toBe("localhost");
    expect(captured?.href).toBe("http://localhost:3000/x");
  });

  it("returns undefined length for absent or invalid content-length", async () => {
    const missing = await probe({ url: "http://localhost:3000/", method: "GET" });
    expect(missing.request.length).toBeUndefined();
    const invalid = await probe({
      url: "http://localhost:3000/",
      method: "GET",
      headers: { "Content-Length": "abc" },
    });
    expect(invalid.request.length).toBeUndefined();
  });

  it("derives ip from proxy headers when proxy is enabled", async () => {
    const ctx = await probe(
      {
        url: "http://localhost:3000/",
        method: "GET",
        headers: { "X-Forwarded-For": "10.0.0.1, 10.0.0.2, 10.0.0.3" },
      },
      true,
    );
    expect(ctx.ips).toEqual(["10.0.0.1", "10.0.0.2", "10.0.0.3"]);
    expect(ctx.ip).toBe("10.0.0.1");
    expect(ctx.protocol).toBe("http");
  });

  it("honors maxIpsCount and proxyIpHeader", async () => {
    let ctx = await probe(
      {
        url: "http://localhost:3000/",
        method: "GET",
        headers: { "X-Forwarded-For": "1.1.1.1, 2.2.2.2" },
      },
      true,
    );
    expect(ctx.ips).toEqual(["1.1.1.1", "2.2.2.2"]);

    const limited = createApp({ proxy: true, proxyIpHeader: "x-real-ip", maxIpsCount: 1 });
    let captured: Context | undefined;
    limited.use(async (c) => {
      captured = c;
      c.status = 204;
    });
    await limited.handle(
      new Request("http://localhost:3000/", {
        headers: { "X-Real-IP": "9.9.9.9, 8.8.8.8" },
      }),
    );
    expect(captured?.ips).toEqual(["8.8.8.8"]);
    expect(captured?.ip).toBe("8.8.8.8");
  });

  it("hides proxy headers when proxy is disabled", async () => {
    const ctx = await probe(
      {
        url: "http://localhost:3000/",
        method: "GET",
        headers: { "X-Forwarded-For": "10.0.0.1" },
      },
      false,
    );
    expect(ctx.ips).toEqual([]);
    expect(ctx.ip).toBe("");
  });

  it("falls back to the remote address from the adapter", async () => {
    const remoteApp = createApp();
    let captured: Context | undefined;
    remoteApp.use(async (ctx) => {
      captured = ctx;
      ctx.status = 204;
    });
    await remoteApp.handle(new Request("http://localhost:3000/"), "192.168.1.10");
    expect(captured?.ip).toBe("192.168.1.10");
  });

  it("prefers x-forwarded-proto when proxy is enabled", async () => {
    const ctx = await probe(
      {
        url: "http://localhost:3000/",
        method: "GET",
        headers: { "X-Forwarded-Proto": "https" },
      },
      true,
    );
    expect(ctx.protocol).toBe("https");
    expect(ctx.secure).toBe(true);
  });

  it("computes subdomains", async () => {
    const ctx = await probe({
      url: "http://a.b.example.com:3000/",
      method: "GET",
      headers: { Host: "a.b.example.com:3000" },
    });
    expect(ctx.subdomains).toEqual(["b", "a"]);
    const tld = await probe({
      url: "http://example.com/",
      method: "GET",
      headers: { Host: "example.com" },
    });
    expect(tld.subdomains).toEqual([]);
    const ipv4 = await probe({
      url: "http://localhost:3000/",
      method: "GET",
      headers: { Host: "127.0.0.1:3000" },
    });
    expect(ipv4.subdomains).toEqual([]);
  });

  it("negotiates content", async () => {
    const ctx = await probe({
      url: "http://localhost:3000/",
      method: "GET",
      headers: {
        Accept: "text/html,application/xhtml+xml;q=0.9,application/xml;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Accept-Charset": "utf-8, iso-8859-1;q=0.5",
      },
    });
    expect(ctx.accepts("html", "json")).toBe("html");
    expect(ctx.accepts(["json", "html"])).toBe("html");
    expect(ctx.accepts("application/xml")).toBe("application/xml");
    expect(ctx.accepts("application/json")).toBe(false);
    expect(ctx.accepts()).toContain("text/html");
    expect(ctx.acceptsEncodings("br", "gzip")).toBe("gzip");
    expect(ctx.acceptsEncodings()).toContain("br");
    expect(ctx.acceptsLanguages("en", "zh")).toBe("zh");
    expect(ctx.acceptsCharsets("utf-8")).toBe("utf-8");
  });

  it("treats missing accept headers as accept-anything", async () => {
    const ctx = await probe({ url: "http://localhost:3000/", method: "GET" });
    expect(ctx.accepts("json")).toBe("json");
    expect(ctx.accepts()).toEqual([]);
    expect(ctx.acceptsEncodings("identity")).toBe("identity");
  });

  it("reports freshness against response validators", async () => {
    const etagApp = createApp();
    let etagCtx: Context | undefined;
    etagApp.use(async (ctx) => {
      etagCtx = ctx;
      ctx.status = 200;
      ctx.etag = "v1";
      ctx.body = "payload";
    });
    await etagApp.handle(
      new Request("http://localhost:3000/", { headers: { "If-None-Match": '"v1"' } }),
    );
    expect(etagCtx?.fresh).toBe(true);
    expect(etagCtx?.stale).toBe(false);

    const staleApp = createApp();
    let staleCtx: Context | undefined;
    staleApp.use(async (ctx) => {
      staleCtx = ctx;
      ctx.status = 200;
      ctx.etag = "v2";
      ctx.body = "payload";
    });
    await staleApp.handle(
      new Request("http://localhost:3000/", { headers: { "If-None-Match": '"other"' } }),
    );
    expect(staleCtx?.fresh).toBe(false);
  });

  it("is never fresh for mutating methods or error statuses", async () => {
    const post = await probe({ url: "http://localhost:3000/", method: "POST" });
    expect(post.fresh).toBe(false);

    const errApp = createApp();
    let errCtx: Context | undefined;
    errApp.use(async (ctx) => {
      errCtx = ctx;
      ctx.status = 500;
      ctx.body = "x";
    });
    await errApp.handle(
      new Request("http://localhost:3000/", { headers: { "If-None-Match": "*" } }),
    );
    expect(errCtx?.fresh).toBe(false);
  });

  it("exposes cookies bound to the app keys", async () => {
    const cookieApp = createApp({ keys: ["secret-1"] });
    let cookieCtx: Context | undefined;
    cookieApp.use(async (ctx) => {
      cookieCtx = ctx;
      ctx.cookies.set("sid", "session-1", { signed: true });
      ctx.status = 204;
    });
    await cookieApp.handle(new Request("http://localhost:3000/", { method: "GET" }));
    expect(cookieCtx?.cookies.get("sid")).toBeUndefined();
    const setCookie = cookieCtx?.responseHeaders["set-cookie"]?.[0] ?? "";
    const roundTrip = createApp({ keys: ["secret-1"] });
    let readCtx: Context | undefined;
    roundTrip.use(async (ctx) => {
      readCtx = ctx;
      ctx.status = 204;
    });
    await roundTrip.handle(
      new Request("http://localhost:3000/", { headers: { Cookie: setCookie.split(";")[0] ?? "" } }),
    );
    expect(readCtx?.cookies.get("sid")).toBe("session-1");
  });

  it("supports throw and assert helpers", async () => {
    const throwing = createApp();
    throwing.use(async (ctx) => {
      ctx.assert(ctx.query["token"] !== undefined, 401, "token required");
      ctx.throw(418, "teapot");
    });
    const ok = await throwing.handle(new Request("http://localhost:3000/?token=1"));
    expect(ok.status).toBe(418);
    const denied = await throwing.handle(new Request("http://localhost:3000/"));
    expect(denied.status).toBe(401);
    expect(await denied.text()).toBe("token required");
  });

  it("exposes app settings", () => {
    const app = createApp({ keys: ["test-key"], proxyIpHeader: "x-forwarded-for" });
    expect(app.env).toBe(process.env["NODE_ENV"] ?? "development");
    expect(app.subdomainOffset).toBe(2);
    expect(app.proxyIpHeader).toBe("x-forwarded-for");
  });
});
