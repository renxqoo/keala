import { describe, expect, it } from "vitest";

import { getPath, getSearch, parseHostHeader } from "../src/utils/url.ts";
import { parseQuery } from "../src/utils/query.ts";
import {
  escapeHtml,
  contentDisposition,
  validateHeaderName,
  validateHeaderValue,
} from "../src/utils/text.ts";
import {
  charsetFromContentType,
  extensionFromMime,
  mimeFromExtension,
  normalizeType,
} from "../src/utils/mime.ts";

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

  it("extracts charset", () => {
    expect(charsetFromContentType("text/html; charset=UTF-8")).toBe("utf-8");
    expect(charsetFromContentType(`text/html; charset="iso-8859-1"`)).toBe("iso-8859-1");
    expect(charsetFromContentType("text/html")).toBe("");
  });
});
