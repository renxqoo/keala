import { describe, expect, it } from "vitest";

import { getPath, getSearch, parseHostHeader } from "../../src/utils/url.ts";
import { parseQuery } from "../../src/utils/query.ts";
import {
  escapeHtml,
  contentDisposition,
  validateHeaderName,
  validateHeaderValue,
} from "../../src/utils/text.ts";
import {
  charsetFromContentType,
  expandContentType,
  extensionFromMime,
  mimeFromExtension,
  normalizeType,
} from "../../src/utils/mime.ts";
import { Keala, isHttpError } from "../../src/index.ts";
import { normalizeError } from "../../src/http/errors.ts";

describe("getPath", () => {
  it("extracts the path from absolute URLs", () => {
    expect(getPath("http://localhost:3000/users/42?page=1")).toBe("/users/42");
    expect(getPath("https://example.com/a/b?x=1&y=2")).toBe("/a/b");
  });

  it("works with path-only input", () => {
    expect(getPath("/health")).toBe("/health");
    expect(getPath("/")).toBe("/");
  });

  it("strips query and fragment", () => {
    expect(getPath("/a?b=1#c")).toBe("/a");
    expect(getPath("http://x.dev/p?q#frag")).toBe("/p");
  });

  it("returns / when the URL has no path", () => {
    expect(getPath("http://example.com")).toBe("/");
    expect(getPath("http://example.com?q=1")).toBe("/");
  });

  it("does not decode percent escapes (router handles decoding)", () => {
    expect(getPath("/users/%E4%B8%AD")).toBe("/users/%E4%B8%AD");
  });
});

describe("getSearch", () => {
  it("returns the query string with leading ?", () => {
    expect(getSearch("/a?b=1")).toBe("?b=1");
    expect(getSearch("http://x.dev/a?b=1&c=2#z")).toBe("?b=1&c=2");
  });

  it("returns empty when absent", () => {
    expect(getSearch("/a")).toBe("");
    expect(getSearch("http://x.dev/a#frag")).toBe("");
  });
});

describe("parseHostHeader", () => {
  it("splits hostname and port", () => {
    expect(parseHostHeader("example.com:8080")).toEqual({ hostname: "example.com", port: "8080" });
    expect(parseHostHeader("example.com")).toEqual({ hostname: "example.com", port: "" });
  });

  it("handles IPv6 literals", () => {
    expect(parseHostHeader("[::1]:3000")).toEqual({ hostname: "::1", port: "3000" });
    expect(parseHostHeader("[2001:db8::1]")).toEqual({ hostname: "2001:db8::1", port: "" });
  });

  it("handles empty host", () => {
    expect(parseHostHeader("")).toEqual({ hostname: "", port: "" });
  });
});

describe("parseQuery", () => {
  it("parses basic pairs", () => {
    expect(parseQuery("?a=1&b=2")).toEqual({ a: "1", b: "2" });
    expect(parseQuery("a=1")).toEqual({ a: "1" });
    expect(parseQuery("")).toEqual({});
  });

  it("decodes + and percent escapes", () => {
    expect(parseQuery("?q=hello+world&n=%E4%B8%AD")).toEqual({ q: "hello world", n: "中" });
  });

  it("collects repeated keys into arrays", () => {
    expect(parseQuery("?a=1&a=2&a=3")).toEqual({ a: ["1", "2", "3"] });
  });

  it("supports keys without values", () => {
    expect(parseQuery("?flag&x=1")).toEqual({ flag: "", x: "1" });
  });

  it("drops prototype pollution keys", () => {
    const query = parseQuery("?__proto__[x]=1&constructor=2&prototype=3&ok=4");
    expect(query["ok"]).toBe("4");
    expect(Object.prototype.hasOwnProperty.call(query, "constructor")).toBe(false);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it("tolerates malformed percent sequences", () => {
    expect(parseQuery("?bad=%E0%A4%A")).toEqual({ bad: "%E0%A4%A" });
  });

  it("returns a null-prototype object", () => {
    expect(Object.getPrototypeOf(parseQuery("?a=1"))).toBe(null);
  });
});

describe("text utils", () => {
  it("escapes HTML entities", () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  });

  it("passes non-ASCII and control bytes through untouched", () => {
    // Re-homed from the retired koa differential fuzz (U1): only the five
    // XML entities are escaped — everything else is verbatim.
    expect(escapeHtml("é中\0\t ")).toBe("é中\0\t ");
  });

  it("builds content-disposition with ASCII fallback", () => {
    expect(contentDisposition("report.pdf")).toBe('attachment; filename="report.pdf"');
    expect(contentDisposition("报告.pdf")).toContain("filename*=UTF-8''%E6%8A%A5%E5%91%8A.pdf");
    expect(contentDisposition('we"ird.txt')).toBe('attachment; filename="we\\"ird.txt"');
  });

  it("validates header names", () => {
    expect(() => validateHeaderName("good-header")).not.toThrow();
    expect(() => validateHeaderName("bad header")).toThrow(TypeError);
    expect(() => validateHeaderName("bad\r\nheader")).toThrow(TypeError);
    expect(() => validateHeaderName("")).toThrow(TypeError);
  });

  it("rejects CRLF and NUL in header values", () => {
    expect(() => validateHeaderValue("x-safe", "ok")).not.toThrow();
    expect(() => validateHeaderValue("x-safe", "evil\r\nSet-Cookie: a=1")).toThrow(TypeError);
    expect(() => validateHeaderValue("x-safe", "nul\0byte")).toThrow(TypeError);
  });
});

describe("mime utils", () => {
  it("normalizes types", () => {
    expect(normalizeType("text/html; charset=utf-8")).toBe("text/html");
    expect(normalizeType("  Application/JSON ")).toBe("application/json");
  });

  it("maps extensions and back", () => {
    expect(mimeFromExtension("a.tar.gz")).toBe("application/gzip");
    expect(mimeFromExtension("noext")).toBe(null);
    expect(extensionFromMime("text/html; charset=utf-8")).toBe("html");
  });

  it("'.bin' expands to application/octet-stream", () => {
    // Re-homed from the retired koa differential (U1): binary downloads
    // must never leak a runtime text/plain default.
    expect(expandContentType(".bin")).toBe("application/octet-stream");
    expect(expandContentType("bin")).toBe("application/octet-stream");
  });

  it("extension-form types expand with their charset (value lock, not self-differential)", () => {
    // Re-homed from the retired koa differential (U1): the ".html" path goes
    // through the same TYPE_MAP expansion as the "html" shorthand — the
    // charset is part of the value, and no other test asserts it directly.
    expect(expandContentType(".html")).toBe("text/html; charset=utf-8");
    expect(expandContentType("html")).toBe("text/html; charset=utf-8");
  });

  it("extracts charset", () => {
    expect(charsetFromContentType("text/html; charset=UTF-8")).toBe("utf-8");
    expect(charsetFromContentType(`text/html; charset="iso-8859-1"`)).toBe("iso-8859-1");
    expect(charsetFromContentType("text/html")).toBe("");
  });
});

describe("coverage gaps", () => {
  it("caches the cookies facade per context", async () => {
    const app = new Keala();
    let first: unknown;
    let second: unknown;
    app.use(async (c) => {
      first = c.cookies;
      second = c.cookies;
      c.body = "ok";
    });
    await app.handle(new Request("http://localhost:3000/"));
    expect(first).toBe(second);
  });

  it("delegates response setters through the flat context", async () => {
    // 0.7: the c.message statusText setter is gone with the API.
    const app = new Keala();
    app.use(async (c) => {
      c.type = "text/csv";
      c.length = 5;
      c.lastModified = new Date(Date.UTC(2025, 0, 2));
      c.etag = "v9";
      expect(c.resHeader("Content-Type")).toBe("text/csv");
      expect(c.has("Content-Type")).toBe(true);
      c.body = "a,b,c";
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.headers.get("content-type")).toBe("text/csv");
    const probe = new Keala();
    let seenLength: number | undefined = 0;
    probe.use(async (c) => {
      c.body = "a,b,c";
      seenLength = c.length;
    });
    await probe.handle(new Request("http://localhost:3000/"));
    expect(seenLength).toBe(5);
    expect(res.headers.get("etag")).toBe('"v9"');
    expect(res.headers.get("last-modified")).toBe("Thu, 02 Jan 2025 00:00:00 GMT");
  });

  it("skips empty strings inside multi-value header flattening", async () => {
    const app = new Keala();
    app.use(async (c) => {
      c.append("Set-Cookie", ["a=1; Path=/", ""]);
      c.body = "ok";
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect([...res.headers.getSetCookie()]).toEqual(["a=1; Path=/"]);
  });

  it("stores single-element append values as plain strings", async () => {
    const app = new Keala();
    app.use(async (c) => {
      c.append("X-List", ["only"]);
      c.append("X-List", "second");
      c.body = "ok";
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.headers.get("x-list")).toBe("only, second");
  });

  it("falls back to the numeric status for unknown codes without a body", async () => {
    const app = new Keala();
    app.use(async (c) => {
      c.status = 599;
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(599);
    expect(await res.text()).toBe("599");
  });

  it("assert throws with full options and passes silently when satisfied", async () => {
    // The core folds the standalone httpAssert helper into `c.assert`
    // (createError(status, message, props) under the hood).
    const app = new Keala({ env: "test" });
    let captured: unknown;
    app.use((c) => {
      c.assert(true, 500);
      try {
        c.assert(false, 403, "denied", { headers: { "x-a": "b" } });
      } catch (err) {
        captured = err;
      }
      c.body = "done";
    });
    await app.handle(new Request("http://localhost:3000/"));
    expect(isHttpError(captured)).toBe(true);
    if (isHttpError(captured)) {
      expect(captured.status).toBe(403);
      expect(captured.message).toBe("denied");
      expect(captured.headers).toEqual({ "x-a": "b" });
    }
  });

  it("normalizes symbol throwables", () => {
    const wrapped = normalizeError(Symbol("boom"));
    expect(wrapped).toBeInstanceOf(Error);
    expect(typeof wrapped.message).toBe("string");
  });

  it("handles unclosed IPv6 host headers", () => {
    expect(parseHostHeader("[::1")).toEqual({ hostname: "[::1", port: "" });
  });

  it("handles scheme-less and fragment-first URLs", () => {
    expect(getPath("no-scheme/just-text")).toBe("no-scheme/just-text");
    expect(getSearch("/a#frag?not-query")).toBe("");
    expect(getSearch("")).toBe("");
  });

  it("escapes nothing when there is nothing to escape", () => {
    expect(escapeHtml("plain text 123")).toBe("plain text 123");
  });

  it("keeps etag quoting for weak validators", async () => {
    const app = new Keala();
    app.use(async (c) => {
      c.etag = 'W/"weak"';
      c.body = "ok";
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.headers.get("etag")).toBe('W/"weak"');
  });

  it("supports context assert with extra properties", async () => {
    const app = new Keala({ env: "test" });
    app.use(async (c) => {
      c.assert(false, 400, "bad input", { headers: { "x-reason": "coverage" } });
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(400);
    expect(res.headers.get("x-reason")).toBe("coverage");
  });
});
