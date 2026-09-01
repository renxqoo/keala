/**
 * ROUND 5 PARSER AUDIT — request-side locks (query/path/host/protocol/fresh).
 * Split from agent-r5-parsers.test.ts; passed before the fixes, must stay green.
 */

import { describe, expect, it } from "vitest";

import { Keala } from "../src/core/app.ts";
import { getPath, getSearch, parseHostHeader, toURL } from "../src/utils/url.ts";
import { parseQuery, type QueryMap } from "../src/utils/query.ts";
import type { Context } from "../src/core/context/context.ts";

const quiet = { env: "test" } as const;
const drive = (app: InstanceType<typeof Keala>, req: Request) => app.handle(req);

const probe = async (
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
// host / hostname / protocol / ips — locks correct behavior
// ---------------------------------------------------------------------------

describe("host/hostname lock correct behavior", () => {
  it("splits host:port and keeps bracketed IPv6 (WHATWG hostname keeps brackets)", async () => {
    // koa hostname → this.URL.hostname → '[::1]' (WHATWG includes brackets).
    expect(await probe({ host: "a.com:8080" }, (c) => [c.host, c.hostname])).toEqual([
      "a.com:8080",
      "a.com",
    ]);
    expect(await probe({ host: "[::1]:3000" }, (c) => c.hostname)).toBe("[::1]");
  });

  it("falls back to the URL authority when Host is absent", async () => {
    expect(await probe({}, (c) => [c.host, c.origin, c.href])).toEqual([
      "x",
      "http://x",
      "http://x/",
    ]);
  });

  it("proxy mode trusts only the FIRST X-Forwarded-Host entry", async () => {
    expect(
      await probe(
        { host: "real.com", "x-forwarded-host": "first.com, second.com" },
        (c) => [c.host, c.hostname],
        { proxy: true },
      ),
    ).toEqual(["first.com", "first.com"]);
  });

  it("userinfo is stripped from BOTH host sources", async () => {
    expect(await probe({ host: "user@legit.com" }, (c) => [c.host, c.hostname])).toEqual([
      "legit.com",
      "legit.com",
    ]);
    expect(
      await probe(
        { host: "real.com", "x-forwarded-host": "evil.com:80@legit.com" },
        (c) => c.host,
        { proxy: true },
      ),
    ).toBe("legit.com");
  });
});

describe("protocol/secure/ips lock correct behavior", () => {
  it("takes the first entry of a multi-valued X-Forwarded-Proto (koa 3)", async () => {
    expect(
      await probe({ "x-forwarded-proto": "https, http" }, (c) => [c.protocol, c.secure], {
        proxy: true,
      }),
    ).toEqual(["https", true]);
  });

  it("an empty X-Forwarded-Proto falls back to the URL scheme", async () => {
    expect(await probe({ "x-forwarded-proto": "" }, (c) => c.protocol, { proxy: true })).toBe(
      "http",
    );
  });

  it("ips: koa 3 semantics — slice(-maxIpsCount), only when > 0", async () => {
    const chain = { "x-forwarded-for": "1.1.1.1, 2.2.2.2" };
    // koa 3.2.1 request.js: `if (this.app.maxIpsCount > 0) ips = ips.slice(-this.app.maxIpsCount)`
    expect(await probe(chain, (c) => c.ips, { proxy: true })).toEqual(["1.1.1.1", "2.2.2.2"]);
    expect(await probe(chain, (c) => c.ips, { proxy: true, maxIpsCount: 0 })).toEqual([
      "1.1.1.1",
      "2.2.2.2",
    ]);
    expect(await probe(chain, (c) => c.ips, { proxy: true, maxIpsCount: -1 })).toEqual([
      "1.1.1.1",
      "2.2.2.2",
    ]);
    expect(await probe(chain, (c) => c.ips, { proxy: true, maxIpsCount: 1 })).toEqual(["2.2.2.2"]);
  });

  it("ips strips ports only on the two unambiguous shapes", async () => {
    // Azure-style "1.2.3.4:38242" and bracketed "[::1]:99"; a bare IPv6
    // literal keeps its colons (they ARE the address).
    expect(
      await probe({ "x-forwarded-for": "1.2.3.4:80, [::1]:99, 2001:db8::1" }, (c) => c.ips, {
        proxy: true,
      }),
    ).toEqual(["1.2.3.4", "[::1]", "2001:db8::1"]);
  });

  it("ips ignores X-Forwarded-For entirely without proxy: true", async () => {
    expect(await probe({ "x-forwarded-for": "1.1.1.1" }, (c) => c.ips)).toEqual([]);
    expect(await probe({ "x-forwarded-for": "1.1.1.1" }, (c) => c.ip, { proxy: false })).toBe("");
  });
});

// ---------------------------------------------------------------------------
// fresh / etagMatches — locks correct behavior (semantics of the `fresh` pkg)
// ---------------------------------------------------------------------------

describe("fresh locks correct behavior (fresh@2 parity)", () => {
  const get = async (
    reqHeaders: Record<string, string>,
    fn: (c: Context) => unknown,
  ): Promise<unknown> => {
    const app = new Keala(quiet);
    let captured: Context | undefined;
    app.use(async (c) => {
      captured = c;
    });
    await drive(app, new Request("http://x/", { headers: reqHeaders }));
    return fn(captured as Context);
  };

  it("If-Modified-Since alone with no Last-Modified on the response → stale", async () => {
    expect(
      await get({ "if-modified-since": "Wed, 21 Oct 2026 07:28:00 GMT" }, (c) => {
        c.status = 200;
        return c.fresh;
      }),
    ).toBe(false);
  });

  it("both validators present and satisfied → fresh", async () => {
    expect(
      await get(
        { "if-none-match": '"v1"', "if-modified-since": "Wed, 21 Oct 2026 07:28:00 GMT" },
        (c) => {
          c.status = 200;
          c.etag = '"v1"';
          c.lastModified = new Date("Tue, 20 Oct 2026 07:28:00 GMT");
          return c.fresh;
        },
      ),
    ).toBe(true);
  });

  it("a future Last-Modified → stale", async () => {
    expect(
      await get({ "if-modified-since": "Wed, 21 Oct 2026 07:28:00 GMT" }, (c) => {
        c.status = 200;
        c.lastModified = new Date("Thu, 22 Oct 2026 07:28:00 GMT");
        return c.fresh;
      }),
    ).toBe(false);
  });

  it("If-None-Match: * matches any current representation", async () => {
    expect(
      await get({ "if-none-match": "*" }, (c) => {
        c.status = 200;
        return c.fresh;
      }),
    ).toBe(true);
  });

  it("weak comparison strips W/ on either side (RFC 7232 §2.3.2)", async () => {
    expect(
      await get({ "if-none-match": 'W/"v1"' }, (c) => {
        c.status = 200;
        c.etag = '"v1"';
        return c.fresh;
      }),
    ).toBe(true);
    expect(
      await get({ "if-none-match": '"v1"' }, (c) => {
        c.status = 200;
        c.etag = 'W/"v1"';
        return c.fresh;
      }),
    ).toBe(true);
  });

  it("an array ETag header is joined before matching", async () => {
    expect(
      await get({ "if-none-match": '"a", "b"' }, (c) => {
        c.status = 200;
        c.set("etag", ['"a"']);
        return c.fresh;
      }),
    ).toBe(true);
  });

  it("cache-control: no-cache forces a full response", async () => {
    expect(
      await get({ "if-none-match": '"v1"', "cache-control": "no-cache" }, (c) => {
        c.status = 200;
        c.etag = '"v1"';
        return c.fresh;
      }),
    ).toBe(false);
  });

  it("non-GET/HEAD methods are never fresh; default 404 status is not fresh (koa order)", async () => {
    expect(
      await get({ "if-none-match": '"v1"' }, (c) => {
        c.etag = '"v1"';
        return c.fresh; // statusValue still the 404 default here
      }),
    ).toBe(false);
    const app = new Keala(quiet);
    let fresh = true;
    app.post("/", (c) => {
      c.status = 200;
      c.etag = '"v1"';
      fresh = c.fresh;
      c.body = "x";
    });
    await drive(
      app,
      new Request("http://x/", { method: "POST", headers: { "if-none-match": '"v1"' } }),
    );
    expect(fresh).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// query setter round-trip — locks correct behavior
// ---------------------------------------------------------------------------

describe("query setter round-trip locks correct behavior", () => {
  it("serializes strings/numbers, null→empty string, arrays repeat the key", async () => {
    const result = await probe({}, (c) => {
      // koa's runtime contract accepts numbers/null (stringifyQuery coerces);
      // the static type is strings-only, hence the widening cast.
      c.query = { a: "x y", b: 1, c: null, d: [1, 2] } as unknown as QueryMap;
      return [c.url, c.querystring, c.query];
    });
    expect(result).toEqual([
      "/?a=x+y&b=1&c=&d=1&d=2",
      "a=x+y&b=1&c=&d=1&d=2",
      { a: "x y", b: "1", c: "", d: ["1", "2"] },
    ]);
  });

  it("a literal '+' survives the round trip as %2B", async () => {
    const result = await probe({}, (c) => {
      c.query = { a: "1+2 x" };
      return [c.querystring, c.query.a];
    });
    expect(result).toEqual(["a=1%2B2+x", "1+2 x"]);
  });
});
