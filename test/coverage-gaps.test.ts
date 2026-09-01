import { describe, expect, it, vi } from "vitest";

import { Keala, isHttpError } from "../src/index.ts";
import { normalizeError } from "../src/http/errors.ts";
import { getPath, getSearch, parseHostHeader } from "../src/utils/url.ts";
import { escapeHtml } from "../src/utils/text.ts";

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
    const app = new Keala();
    app.use(async (c) => {
      c.type = "text/csv";
      c.length = 5;
      c.message = "custom";
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
    expect(res.statusText).toBe("custom");
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

  it("emits errors without a context attached", () => {
    const app = new Keala({ env: "development", silent: true });
    const spy = vi.fn();
    app.onError(spy);
    app.onerror(new Error("bare"));
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ message: "bare" }), undefined);
  });
});
