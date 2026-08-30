import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/application/app.ts";
import { httpAssert } from "../src/context/context.ts";
import { normalizeError } from "../src/http/errors.ts";
import { getPath, getSearch, parseHostHeader } from "../src/utils/url.ts";
import { escapeHtml } from "../src/utils/text.ts";

describe("coverage gaps", () => {
  it("caches the cookies facade per context", async () => {
    const app = createApp();
    let first: unknown;
    let second: unknown;
    app.use(async (ctx) => {
      first = ctx.cookies;
      second = ctx.cookies;
      ctx.status = 204;
    });
    await app.handle(new Request("http://localhost:3000/"));
    expect(first).toBe(second);
  });

  it("delegates response setters through ctx", async () => {
    const app = createApp();
    app.use(async (ctx) => {
      ctx.type = "text/csv";
      ctx.length = 5;
      ctx.message = "custom";
      ctx.lastModified = new Date(Date.UTC(2025, 0, 2));
      ctx.etag = "v9";
      expect(ctx.response.headers).toBe(ctx.responseHeaders);
      expect(ctx.response.get("Content-Type")).toBe("text/csv");
      ctx.body = "a,b,c";
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.headers.get("content-type")).toBe("text/csv");
    const probe = createApp();
    let seenLength: number | undefined = 0;
    probe.use(async (ctx) => {
      ctx.body = "a,b,c";
      seenLength = ctx.response.length;
    });
    await probe.handle(new Request("http://localhost:3000/"));
    expect(seenLength).toBe(5);
    expect(res.statusText).toBe("custom");
    expect(res.headers.get("etag")).toBe('"v9"');
    expect(res.headers.get("last-modified")).toBe("Thu, 02 Jan 2025 00:00:00 GMT");
  });

  it("skips empty strings inside multi-value header flattening", async () => {
    const app = createApp();
    app.use(async (ctx) => {
      ctx.append("Set-Cookie", ["a=1; Path=/", ""]);
      ctx.body = "ok";
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect([...res.headers.getSetCookie()]).toEqual(["a=1; Path=/"]);
  });

  it("stores single-element append values as plain strings", async () => {
    const app = createApp();
    app.use(async (ctx) => {
      ctx.append("X-List", ["only"]);
      ctx.append("X-List", "second");
      ctx.body = "ok";
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.headers.get("x-list")).toBe("only, second");
  });

  it("falls back to the numeric status for unknown codes without a body", async () => {
    const app = createApp();
    app.use(async (ctx) => {
      ctx.status = 599;
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(599);
    expect(await res.text()).toBe("599");
  });

  it("httpAssert throws with full options", () => {
    expect(() => httpAssert(false, 403, "denied", { headers: { "x-a": "b" } })).toThrow(/denied/);
    expect(() => httpAssert(true, 500)).not.toThrow();
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
    const app = createApp();
    app.use(async (ctx) => {
      ctx.etag = 'W/"weak"';
      ctx.body = "ok";
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.headers.get("etag")).toBe('W/"weak"');
  });

  it("supports context assert with extra properties", async () => {
    const app = createApp({ env: "test" });
    app.use(async (ctx) => {
      ctx.assert(false, 400, "bad input", { headers: { "x-reason": "coverage" } });
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(400);
    expect(res.headers.get("x-reason")).toBe("coverage");
  });

  it("emits errors without a context attached", () => {
    const app = createApp({ env: "development", silent: true });
    const spy = vi.fn();
    app.on("error", spy);
    app.onerror(new Error("bare"));
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ message: "bare" }), undefined);
  });
});
