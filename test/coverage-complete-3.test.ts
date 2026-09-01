/**
 * Branch-coverage completion, part 3: the last uncovered branches — sugar
 * default-vs-explicit shapes, IPv6 hostname handling, host fallbacks,
 * onerror guards and use() validation.
 */

import { describe, expect, it, vi } from "vitest";

import { Keala } from "../src/core/app.ts";
import { toHttpError } from "../src/http/errors.ts";
import { baseContextProto, createContext, type Context } from "../src/core/context/context.ts";

const quiet = { env: "test" } as const;
const req = (path: string, init?: RequestInit) => new Request(`http://localhost:3000${path}`, init);

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
      c.set("x-rec", "1");
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

  it("an empty host header falls back to the URL authority", () => {
    const c = ctxFor("http://localhost:3000/x", { host: "" });
    expect(c.host).toBe("localhost:3000");
    expect(c.hostname).toBe("localhost");
  });

  it("bracketed IPv6 hosts resolve through WHATWG URL semantics", () => {
    const c = ctxFor("http://localhost:3000/x", { host: "[::1]:3000" });
    // URL.hostname keeps the brackets for IPv6 literals (koa behavior).
    expect(c.hostname).toBe("[::1]");
  });

  it("host userinfo is stripped before hostname parsing", () => {
    const c = ctxFor("http://localhost:3000/x", { host: "user:pass@example.com:8080" });
    expect(c.hostname).toBe("example.com");
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
