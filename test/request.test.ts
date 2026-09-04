import { describe, expect, it } from "vitest";

import { Keala } from "../src/index.ts";
import type { Context } from "../src/core/context/context.ts";

const probe = async (
  init: { url: string; method?: string; headers?: Record<string, string> },
  proxy = false,
): Promise<Context> => {
  let captured: Context | undefined;
  const probing = new Keala({ keys: ["k"], proxy, proxyIpHeader: "x-forwarded-for" });
  probing.use(async (c) => {
    captured = c;
    c.body = "probed";
  });
  await probing.handle(new Request(init.url, init));
  if (captured === undefined) throw new Error("probe middleware did not run");
  return captured;
};

describe("request facade (flat context)", () => {
  it("exposes method, url, path and the query parts", async () => {
    const ctx = await probe({
      url: "http://localhost:3000/users/42?page=2&size=10",
      method: "GET",
    });
    expect(ctx.method).toBe("GET");
    expect(ctx.url).toBe("/users/42?page=2&size=10");
    expect(ctx.path).toBe("/users/42");
    expect(ctx.querystring).toBe("page=2&size=10");
    expect(ctx.search).toBe("?page=2&size=10");
  });

  it("parses the query through targeted reads", async () => {
    const ctx = await probe({
      url: "http://localhost:3000/?page=2&tags=a&tags=b",
      method: "GET",
    });
    expect(ctx.query("tags")).toBe("a");
    expect(ctx.queries("tags")).toEqual(["a", "b"]);
    expect(ctx.query("page")).toBe("2");
    expect(ctx.query("missing")).toBeUndefined();
  });

  it("reads headers case-insensitively", async () => {
    const ctx = await probe({
      url: "http://localhost:3000/",
      method: "GET",
      headers: { "X-Custom": "yes", "Content-Type": "application/json; charset=utf-8" },
    });
    expect(ctx.header("X-CUSTOM")).toBe("yes");
    expect(ctx.header("x-custom")).toBe("yes");
    expect(ctx.header("missing")).toBe("");
    expect(ctx.header("x-custom")).toBe("yes");
    // c.headers IS the raw fetch Headers (no second facade object).
    expect(ctx.headers).toBe(ctx.raw.headers);
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
    expect(ctx.reqLength).toBe(42);
    expect(ctx.idempotent).toBe(true);
    expect(ctx.host).toBe("localhost:3000");
    expect(ctx.protocol).toBe("http");
    expect(ctx.secure).toBe(false);
    expect(ctx.origin).toBe("http://localhost:3000");
    expect(ctx.href).toBe("http://localhost:3000/a/b?x=1");
  });

  it("derives host from the URL when the Host header is absent", async () => {
    const app = new Keala();
    let captured: Context | undefined;
    app.use(async (c) => {
      captured = c;
      c.body = "ok";
    });
    await app.handle(new Request("http://localhost:3000/x"));
    expect(captured?.host).toBe("localhost:3000");
    expect(captured?.href).toBe("http://localhost:3000/x");
  });

  it("returns undefined length for absent or invalid content-length", async () => {
    const missing = await probe({ url: "http://localhost:3000/", method: "GET" });
    expect(missing.reqLength).toBeUndefined();
    const invalid = await probe({
      url: "http://localhost:3000/",
      method: "GET",
      headers: { "Content-Length": "abc" },
    });
    expect(invalid.reqLength).toBeUndefined();
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
    expect(ctx.ip).toBe("10.0.0.1");
    expect(ctx.protocol).toBe("http");
  });

  it("honors maxIpsCount and proxyIpHeader", async () => {
    const ctx = await probe(
      {
        url: "http://localhost:3000/",
        method: "GET",
        headers: { "X-Forwarded-For": "1.1.1.1, 2.2.2.2" },
      },
      true,
    );
    // No maxIpsCount: the chain is not truncated and c.ip is its first entry.
    expect(ctx.ip).toBe("1.1.1.1");

    const limited = new Keala({ proxy: true, proxyIpHeader: "x-real-ip", maxIpsCount: 1 });
    let captured: Context | undefined;
    limited.use(async (c) => {
      captured = c;
      c.body = "ok";
    });
    await limited.handle(
      new Request("http://localhost:3000/", {
        headers: { "X-Real-IP": "9.9.9.9, 8.8.8.8" },
      }),
    );
    // maxIpsCount truncates the trusted chain from the left; c.ip is the
    // truncated chain's first entry.
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
    expect(ctx.ip).toBe("");
  });

  it("falls back to the remote address from the runtime channel", async () => {
    const remoteApp = new Keala();
    let captured: Context | undefined;
    remoteApp.use(async (c) => {
      captured = c;
      c.body = "ok";
    });
    // the remote address rides the runtime object instead of a bare string.
    await remoteApp.handle(new Request("http://localhost:3000/"), { remote: "192.168.1.10" });
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

  it("negotiates content", async () => {
    const ctx = await probe({
      url: "http://localhost:3000/",
      method: "GET",
      headers: {
        Accept: "text/html,application/xhtml+xml;q=0.9,application/xml;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
      },
    });
    expect(ctx.accepts("html", "json")).toBe("html");
    expect(ctx.accepts(["json", "html"])).toBe("html");
    expect(ctx.accepts("application/xml")).toBe("application/xml");
    expect(ctx.accepts("application/json")).toBe(false);
    expect(ctx.accepts()).toContain("text/html");
    expect(ctx.acceptsEncodings("br", "gzip")).toBe("gzip");
    expect(ctx.acceptsEncodings()).toContain("br");
  });

  it("treats missing accept headers as accept-anything", async () => {
    const ctx = await probe({ url: "http://localhost:3000/", method: "GET" });
    expect(ctx.accepts("json")).toBe("json");
    expect(ctx.accepts()).toEqual([]);
    expect(ctx.acceptsEncodings("identity")).toBe("identity");
  });

  it("exposes cookies bound to the app keys", async () => {
    const cookieApp = new Keala({ keys: ["secret-1"] });
    let cookieCtx: Context | undefined;
    cookieApp.use(async (c) => {
      cookieCtx = c;
      c.cookies.set("sid", "session-1", { signed: true });
      c.body = "ok";
    });
    const baked = await cookieApp.handle(new Request("http://localhost:3000/", { method: "GET" }));
    // A freshly-set cookie is not visible to reads (the jar holds request cookies).
    expect(cookieCtx?.cookies.get("sid")).toBeUndefined();
    const setCookie = baked.headers.getSetCookie()[0] ?? "";
    const roundTrip = new Keala({ keys: ["secret-1"] });
    let readCtx: Context | undefined;
    roundTrip.use(async (c) => {
      readCtx = c;
      c.body = "ok";
    });
    await roundTrip.handle(
      new Request("http://localhost:3000/", { headers: { Cookie: setCookie.split(";")[0] ?? "" } }),
    );
    expect(readCtx?.cookies.get("sid")).toBe("session-1");
  });

  it("supports throw and assert helpers", async () => {
    const throwing = new Keala();
    throwing.use(async (c) => {
      c.assert(c.query("token") !== undefined, 401, "token required");
      c.throw(418, "teapot");
    });
    const ok = await throwing.handle(new Request("http://localhost:3000/?token=1"));
    expect(ok.status).toBe(418);
    const denied = await throwing.handle(new Request("http://localhost:3000/"));
    expect(denied.status).toBe(401);
    expect(await denied.text()).toBe("token required");
  });

  it("exposes app settings", () => {
    const app = new Keala({ keys: ["test-key"], proxyIpHeader: "x-forwarded-for" });
    expect(app.env).toBe(process.env["NODE_ENV"] ?? "development");
    expect(app.settings.proxyIpHeader).toBe("x-forwarded-for");
    expect(app.toJSON()).toEqual({ env: app.env, proxy: false });
  });
});
