import { describe, expect, it, vi } from "vitest";

import { Keala } from "../../src/core/app.ts";
import { Router } from "../../src/router/group.ts";
import { contentDisposition } from "../../src/utils/text.ts";
import { toHttpError } from "../../src/http/errors.ts";
import { baseContextProto, createContext, type Context } from "../../src/core/context/context.ts";
/**
 * Branch-coverage completion, part 2: response sugar combinations, router
 * group validation/redirect/url paths, content-disposition fallbacks and
 * app-level validation branches.
 */

const quiet = { env: "test" } as const;
const req = (path: string, init?: RequestInit) => new Request(`http://localhost:3000${path}`, init);

describe("coverage: response sugar combinations", () => {
  it("text with explicit status keeps it and adds a default content-type with headers", async () => {
    const app = new Keala(quiet);
    app.get("/a", (c) => c.text("nope", 404));
    app.get("/b", (c) => c.text("hdr", 201, { "x-b": "1" }));
    const a = await app.handle(req("/a"));
    expect(a.status).toBe(404);
    expect(await a.text()).toBe("nope");
    const b = await app.handle(req("/b"));
    expect(b.status).toBe(201);
    expect(b.headers.get("x-b")).toBe("1");
    expect(b.headers.get("content-type")).toContain("text/plain");
  });

  it("state headers written before the sugar merge into it", async () => {
    const app = new Keala(quiet);
    app.get("/m", (c) => {
      c.setHeader("X-Merged", "1");
      return c.text("body");
    });
    const res = await app.handle(req("/m"));
    expect(res.headers.get("x-merged")).toBe("1");
    expect(await res.text()).toBe("body");
  });

  it("json carries status and headers; an explicit per-call content-type wins over html's default", async () => {
    const app = new Keala(quiet);
    app.get("/j", (c) => c.json({ ok: true }, 202, { "x-j": "1" }));
    app.get("/h", (c) => c.html("<b>x</b>", 200, { "content-type": "text/plain" }));
    const j = await app.handle(req("/j"));
    expect(j.status).toBe(202);
    expect(j.headers.get("x-j")).toBe("1");
    expect((j.headers.get("content-type") ?? "").split(";")[0]).toBe("application/json");
    expect(await j.text()).toBe('{"ok":true}');
    // hono parity (setDefaultContentType): text/html is the DEFAULT, the
    // caller's explicit content-type wins.
    const h = await app.handle(req("/h"));
    expect(h.headers.get("content-type")).toBe("text/plain");
  });

  it("json sugar carries staged headers and status through Response.json", async () => {
    const app = new Keala(quiet);
    app.get("/s", (c) => {
      c.setHeader("x-s", "1");
      return c.json({ made: true }, 201);
    });
    const res = await app.handle(req("/s"));
    expect(res.status).toBe(201);
    expect(res.headers.get("x-s")).toBe("1");
    expect(await res.text()).toBe('{"made":true}');
  });
});

describe("coverage: router group paths", () => {
  it("redirect with :params rebuilds from matched captures", async () => {
    const app = new Keala(quiet);
    app.get("/users/:id", (c) => c.text("u"));
    app.redirect("/u/:id", "/users/:id", 301);
    const res = await app.handle(req("/u/77"));
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/users/77");
  });

  it("use()/param() argument validation throws", () => {
    const router = new Router();
    expect(() => router.use("nope" as unknown as () => void)).toThrow(TypeError);
    expect(() => router.param("", () => undefined)).toThrow(TypeError);
    expect(() => router.param("x", "nope" as unknown as () => void)).toThrow(TypeError);
  });

  it("router.url throws for unknown names and missing params", () => {
    const router = new Router();
    router.get("thing", "/t/:id", () => undefined);
    expect(() => router.url("ghost", {})).toThrow(/No route registered/);
    expect(() => router.url("thing", {})).toThrow(/Missing required parameter/);
    expect(router.url("thing", { id: "5" })).toBe("/t/5");
    expect(router.route("thing")).toBe("/t/:id");
    expect(router.route("ghost")).toBeUndefined();
  });

  it("prefixed groups carry their prefix into mounted paths", async () => {
    const app = new Keala(quiet);
    const api = new Router({ prefix: "/v2" });
    api.get("/items", (c) => c.text("items"));
    app.mount("/api", api);
    expect(await (await app.handle(req("/api/v2/items"))).text()).toBe("items");
  });

  it("on() accepts any casing and rejects unknown methods", async () => {
    const app = new Keala(quiet);
    app.on("Delete", "/d", (c) => c.text("deleted"));
    expect((await app.handle(req("/d", { method: "DELETE" }))).status).toBe(200);
    expect(() => app.on("WAT", "/w", () => undefined)).toThrow(TypeError);
  });
});

describe("coverage: content-disposition fallbacks", () => {
  it("fallback string replaces unencodable filenames", () => {
    expect(contentDisposition("年度.csv", "fallback.csv")).toContain("fallback.csv");
  });

  it("fallback false drops the filename parameter entirely", () => {
    expect(contentDisposition("年度.csv", false)).not.toContain("filename=");
  });

  it("ascii filenames pass through quoted", () => {
    expect(contentDisposition("report.pdf")).toBe('attachment; filename="report.pdf"');
  });
});

describe("coverage: app.param validation", () => {
  it("rejects bad names and handlers", () => {
    const app = new Keala(quiet);
    expect(() => app.param("", () => undefined)).toThrow(TypeError);
    expect(() => app.param("x", "nope" as unknown as () => void)).toThrow(TypeError);
  });
});

/**
 * Branch-coverage completion, part 3: the last uncovered branches — sugar
 * default-vs-explicit shapes, IPv6 hostname handling, host fallbacks,
 * onerror guards and use() validation.
 */

describe("coverage: final sugar shapes", () => {
  it("json with only status (no headers) takes the status-only init", async () => {
    const app = new Keala(quiet);
    app.get("/s", (c) => c.json([1], 203));
    const res = await app.handle(req("/s"));
    expect(res.status).toBe(203);
    expect(await res.text()).toBe("[1]");
  });

  it("json with only state-record headers (no args) merges them", async () => {
    const app = new Keala(quiet);
    app.get("/h", (c) => {
      c.setHeader("x-rec", "1");
      return c.json({ ok: 1 });
    });
    const res = await app.handle(req("/h"));
    expect(res.headers.get("x-rec")).toBe("1");
    expect((res.headers.get("content-type") ?? "").split(";")[0]).toBe("application/json");
  });

  it("html without status and html with status both pin text/html", async () => {
    const app = new Keala(quiet);
    app.get("/a", (c) => c.html("<i>a</i>"));
    app.get("/b", (c) => c.html("<i>b</i>", 201));
    const a = await app.handle(req("/a"));
    expect(a.headers.get("content-type")).toContain("text/html");
    expect((await app.handle(req("/b"))).status).toBe(201);
  });

  it("text with only headers (no status) keeps 200 and defaults content-type", async () => {
    const app = new Keala(quiet);
    app.get("/t", (c) => c.text("t", undefined, { "x-t": "1" }));
    const res = await app.handle(req("/t"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-t")).toBe("1");
  });
});

describe("coverage: request host edge branches", () => {
  const ctxFor = (url: string, headers?: Record<string, string>): Context =>
    createContext(
      new Keala(quiet),
      baseContextProto,
      new Request(url, headers ? { headers } : undefined),
      undefined,
    );

  // 0.7: c.hostname is gone — host (with port) is the surviving accessor;
  // callers strip the port themselves.

  it("an empty host header falls back to the URL authority", () => {
    const c = ctxFor("http://localhost:3000/x", { host: "" });
    expect(c.host).toBe("localhost:3000");
  });

  it("bracketed IPv6 hosts pass through verbatim with their port", () => {
    const c = ctxFor("http://localhost:3000/x", { host: "[::1]:3000" });
    expect(c.host).toBe("[::1]:3000");
  });

  it("host userinfo is stripped before the authority is exposed", () => {
    const c = ctxFor("http://localhost:3000/x", { host: "user:pass@example.com:8080" });
    expect(c.host).toBe("example.com:8080");
  });

  it("absolute request URLs fall back to their authority for host", () => {
    const c = ctxFor("https://from-url.example:9443/path");
    expect(c.host).toBe("from-url.example:9443");
    expect(c.secure).toBe(true);
  });
});

describe("coverage: onerror guards and use validation", () => {
  it("toHttpError wraps any throwable into an unexposed 500 HttpError", () => {
    const nulled = toHttpError(null);
    expect(nulled.status).toBe(500);
    expect(nulled.expose).toBe(false);
    expect(toHttpError("boom").message).toBe("boom");
  });

  it("use() rejects non-function middleware", () => {
    const app = new Keala(quiet);
    expect(() => app.use(undefined as unknown as () => void)).toThrow(TypeError);
  });

  it("client-level 4xx errors never trigger the console fallback", async () => {
    const app = new Keala({ env: "development" });
    app.get("/nope", (c) => c.throw(404, "gone", { expose: true }));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await app.handle(req("/nope"));
    expect(res.status).toBe(404);
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("toJSON summarizes the app", () => {
    expect(new Keala({ env: "prod", proxy: true }).toJSON()).toEqual({ env: "prod", proxy: true });
  });
});
