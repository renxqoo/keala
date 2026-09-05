import { describe, expect, it } from "vitest";

import { Keala } from "../../src/index.ts";
import type { Context } from "../../src/core/context/context.ts";
import { getPath, getSearch, parseHostHeader, toURL } from "../../src/utils/url.ts";
import { parseQuery } from "../../src/utils/query.ts";

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

/**
 * ROUND 5 PARSER AUDIT — request-side locks (query/path/host/protocol/ip).
 * Split from agent-r5-parsers.test.ts; passed before the fixes, must stay green.
 */

const quiet = { env: "test" } as const;
const drive = (app: InstanceType<typeof Keala>, req: Request) => app.handle(req);

const probeHeaders = async (
  headers: Record<string, string>,
  fn: (c: Context) => unknown,
  opts: Record<string, unknown> = {},
  url = "http://x/",
): Promise<unknown> => {
  const app = new Keala({ ...quiet, ...opts });
  let captured: Context | undefined;
  app.use(async (c) => {
    captured = c;
  });
  await drive(app, new Request(url, { headers }));
  return fn(captured as Context);
};

describe("parseQuery locks correct behavior", () => {
  it("does NOT nest brackets (koa uses querystring.parse — flat keys)", () => {
    const q = parseQuery("a[b]=c");
    expect(q).toEqual({ "a[b]": "c" });
    expect(Array.isArray(q["a[b]"])).toBe(false);
  });

  it("repeated keys become arrays, singles stay strings", () => {
    expect(parseQuery("a=1&a=2")).toEqual({ a: ["1", "2"] });
    expect(parseQuery("a=1&a=2&a=3").a).toEqual(["1", "2", "3"]);
    expect(parseQuery("a=1")).toEqual({ a: "1" });
  });

  it("matches node:querystring on degenerate inputs", () => {
    expect(parseQuery("=")).toEqual({ "": "" });
    expect(parseQuery("&")).toEqual({});
    expect(parseQuery("a")).toEqual({ a: "" });
    expect(parseQuery("a=")).toEqual({ a: "" });
    expect(parseQuery("a=1&&b=2")).toEqual({ a: "1", b: "2" });
    expect(parseQuery("?=x")).toEqual({ "": "x" });
  });

  it("decodes + as space and %2B as plus (form-style, like querystring.parse)", () => {
    expect(parseQuery("a+b=c+d")).toEqual({ "a b": "c d" });
    expect(parseQuery("a%2Bb=c%2Bd")).toEqual({ "a+b": "c+d" });
  });

  it("falls back to the raw text on invalid escapes", () => {
    // node:querystring.parse("a=%ZZ") → { a: '%ZZ' }
    expect(parseQuery("a=%ZZ")).toEqual({ a: "%ZZ" });
    expect(parseQuery("%ZZ=1")).toEqual({ "%ZZ": "1" });
  });

  it("drops unsafe keys AFTER decoding, keeps dotted look-alikes", () => {
    // decode-then-check: the encoded spelling is dropped too.
    expect(parseQuery("__proto__=1")).toEqual({});
    expect(parseQuery("constructor=1")).toEqual({});
    expect(parseQuery("prototype=1")).toEqual({});
    expect(parseQuery("%5F%5Fproto%5F%5F=1")).toEqual({});
    // A key WITH a dot is just an ordinary key (only exact matches are unsafe).
    expect(parseQuery("constructor.name=x")).toEqual({ "constructor.name": "x" });
  });

  it("returns a null-prototype object", () => {
    expect(Object.getPrototypeOf(parseQuery("a=1"))).toBe(null);
  });

  it("parses a keys-only query in linear time (O(n) single pass)", () => {
    const input = "a&".repeat(100_000);
    const start = Date.now();
    const q = parseQuery(input);
    const elapsed = Date.now() - start;
    expect(q.a).toEqual(Array.from({ length: 100_000 }, () => ""));
    // Generous bound: the old indexOf-based scan was O(n^2) (>10s here).
    expect(elapsed).toBeLessThan(2_000);
  });
});

// ---------------------------------------------------------------------------
// getPath / getSearch / parseHostHeader — locks correct behavior
// ---------------------------------------------------------------------------

describe("getPath/getSearch lock correct behavior", () => {
  it("authority-only URLs parse to root", () => {
    expect(getPath("http://x")).toBe("/");
    expect(getSearch("http://x")).toBe("");
    expect(getPath("http://x?a=1#frag")).toBe("/");
    expect(getSearch("http://x?a=1#frag")).toBe("?a=1");
  });

  it("a '?' inside the fragment does not start a search", () => {
    // WHATWG URL: the fragment runs to end-of-string, '#' ends the path/query.
    expect(getPath("http://x/a#b?c")).toBe("/a");
    expect(getSearch("http://x/a#b?c")).toBe("");
  });

  it("trailing '?' yields an empty querystring, not a lost one", () => {
    expect(getPath("/path?")).toBe("/path");
    expect(getSearch("/path?")).toBe("?");
  });

  it("%23 is data, not a fragment delimiter", () => {
    expect(getPath("http://x/a%23b?c=d")).toBe("/a%23b");
    expect(getSearch("http://x/a%23b?c=d")).toBe("?c=d");
  });

  it("toURL returns null for unparseable URLs", () => {
    expect(toURL("http://ex ample.com/")).toBe(null);
    expect(toURL("http://x/")).toBeInstanceOf(URL);
  });

  it("parseHostHeader handles ports, IPv6 brackets and garbage ports", () => {
    expect(parseHostHeader("a.com:8080")).toEqual({ hostname: "a.com", port: "8080" });
    expect(parseHostHeader("[::1]:3000")).toEqual({ hostname: "::1", port: "3000" });
    expect(parseHostHeader("[::1]")).toEqual({ hostname: "::1", port: "" });
    // A trailing dot is a distinct (valid) DNS name — kept verbatim (koa too).
    expect(parseHostHeader("a.com.")).toEqual({ hostname: "a.com.", port: "" });
    expect(parseHostHeader("")).toEqual({ hostname: "", port: "" });
    expect(parseHostHeader("a.com:abc")).toEqual({ hostname: "a.com", port: "abc" });
  });
});

// ---------------------------------------------------------------------------
// host / protocol / ip — locks correct behavior
// ---------------------------------------------------------------------------

describe("host lock correct behavior", () => {
  it("keeps host:port and bracketed IPv6 verbatim", async () => {
    expect(await probeHeaders({ host: "a.com:8080" }, (c) => c.host)).toBe("a.com:8080");
    expect(await probeHeaders({ host: "[::1]:3000" }, (c) => c.host)).toBe("[::1]:3000");
  });

  it("falls back to the URL authority when Host is absent", async () => {
    expect(await probeHeaders({}, (c) => [c.host, c.origin, c.href])).toEqual([
      "x",
      "http://x",
      "http://x/",
    ]);
  });

  it("proxy mode trusts only the FIRST X-Forwarded-Host entry", async () => {
    expect(
      await probeHeaders(
        { host: "real.com", "x-forwarded-host": "first.com, second.com" },
        (c) => c.host,
        { proxy: true },
      ),
    ).toBe("first.com");
  });

  it("userinfo is stripped from BOTH host sources", async () => {
    expect(await probeHeaders({ host: "user@legit.com" }, (c) => c.host)).toBe("legit.com");
    expect(
      await probeHeaders(
        { host: "real.com", "x-forwarded-host": "evil.com:80@legit.com" },
        (c) => c.host,
        { proxy: true },
      ),
    ).toBe("legit.com");
  });
});

describe("protocol/secure/ip lock correct behavior", () => {
  it("takes the first entry of a multi-valued X-Forwarded-Proto (koa 3)", async () => {
    expect(
      await probeHeaders({ "x-forwarded-proto": "https, http" }, (c) => [c.protocol, c.secure], {
        proxy: true,
      }),
    ).toEqual(["https", true]);
  });

  it("an empty X-Forwarded-Proto falls back to the URL scheme", async () => {
    expect(
      await probeHeaders({ "x-forwarded-proto": "" }, (c) => c.protocol, { proxy: true }),
    ).toBe("http");
  });

  it("ip strips ports only on the two unambiguous shapes", async () => {
    // Azure-style "1.2.3.4:38242" and bracketed "[::1]:99"; a bare IPv6
    // literal keeps its colons (they ARE the address).
    expect(
      await probeHeaders({ "x-forwarded-for": "1.2.3.4:80" }, (c) => c.ip, { proxy: true }),
    ).toBe("1.2.3.4");
    expect(
      await probeHeaders({ "x-forwarded-for": "[::1]:99" }, (c) => c.ip, { proxy: true }),
    ).toBe("[::1]");
    expect(
      await probeHeaders({ "x-forwarded-for": "2001:db8::1" }, (c) => c.ip, { proxy: true }),
    ).toBe("2001:db8::1");
  });

  it("ip ignores X-Forwarded-For entirely without proxy: true", async () => {
    expect(await probeHeaders({ "x-forwarded-for": "1.1.1.1" }, (c) => c.ip)).toBe("");
    expect(
      await probeHeaders({ "x-forwarded-for": "1.1.1.1" }, (c) => c.ip, { proxy: false }),
    ).toBe("");
  });
});
