import { describe, expect, it } from "vitest";

import { getPath, getSearch } from "../../src/utils/url.ts";
import { validateHeaderName, validateHeaderValue } from "../../src/utils/text.ts";
import { mimeFromExtension, normalizeType } from "../../src/utils/mime.ts";
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

describe("text utils", () => {
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

  it("maps file extensions", () => {
    expect(mimeFromExtension("a.tar.gz")).toBe("application/gzip");
    expect(mimeFromExtension("noext")).toBe(null);
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
      return c.text("ok");
    });
    await app.handle(new Request("http://localhost:3000/"));
    expect(first).toBe(second);
  });

  // U3c deletion: "delegates response setters through the flat context"
  // locked the deleted c.type/c.length/c.lastModified/c.etag setter family
  // (auto-quoting, Date conversion, the computed c.length read). The staged
  // header channel it also probed (setHeader/resHeader/has) is locked by
  // response.test.ts "set/append/remove header operations".
  it("skips empty strings inside multi-value header flattening", async () => {
    const app = new Keala();
    app.use(async (c) => {
      c.append("Set-Cookie", ["a=1; Path=/", ""]);
      return c.text("ok");
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect([...res.headers.getSetCookie()]).toEqual(["a=1; Path=/"]);
  });

  it("stores single-element append values as plain strings", async () => {
    const app = new Keala();
    app.use(async (c) => {
      c.append("X-List", ["only"]);
      c.append("X-List", "second");
      return c.text("ok");
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.headers.get("x-list")).toBe("only, second");
  });

  it("falls back to the numeric status for unknown codes without a body", async () => {
    // U3c: `c.status = 599` with no body used to fall back to the status
    // text — the sugar's second parameter is the equivalent status channel.
    const app = new Keala();
    app.use((c) => c.text("599", 599));
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
      return c.text("done");
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

  it("handles scheme-less and fragment-first URLs", () => {
    expect(getPath("no-scheme/just-text")).toBe("no-scheme/just-text");
    expect(getSearch("/a#frag?not-query")).toBe("");
    expect(getSearch("")).toBe("");
  });

  it("ships a weak validator ETag verbatim (U3c: quoting is the caller's)", async () => {
    const app = new Keala();
    app.use(async (c) => {
      c.setHeader("ETag", 'W/"weak"');
      return c.text("ok");
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
