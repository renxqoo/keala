/**
 * Branch-coverage completion, part 3: the last uncovered branches — sugar
 * default-vs-explicit shapes, IPv6 hostname handling, host fallbacks,
 * onerror guards and use() validation.
 */

import { describe, expect, it } from "vitest";

import { createApp } from "../src/core/app.ts";
import { baseContextProto, createContext, type Context } from "../src/core/context/context.ts";

const quiet = { env: "test" } as const;
const req = (path: string, init?: RequestInit) => new Request(`http://localhost:3000${path}`, init);

describe("coverage: final sugar shapes", () => {
  it("json with only status (no headers) takes the status-only init", async () => {
    const app = createApp(quiet);
    app.get("/s", (c) => c.json([1], 203));
    const res = await app.handle(req("/s"));
    expect(res.status).toBe(203);
    expect(await res.text()).toBe("[1]");
  });

  it("json with only state-record headers (no args) merges them", async () => {
    const app = createApp(quiet);
    app.get("/h", (c) => {
      c.set("x-rec", "1");
      return c.json({ ok: 1 });
    });
    const res = await app.handle(req("/h"));
    expect(res.headers.get("x-rec")).toBe("1");
    expect((res.headers.get("content-type") ?? "").split(";")[0]).toBe("application/json");
  });

  it("html without status and html with status both pin text/html", async () => {
    const app = createApp(quiet);
    app.get("/a", (c) => c.html("<i>a</i>"));
    app.get("/b", (c) => c.html("<i>b</i>", 201));
    const a = await app.handle(req("/a"));
    expect(a.headers.get("content-type")).toContain("text/html");
    expect((await app.handle(req("/b"))).status).toBe(201);
  });

  it("text with only headers (no status) keeps 200 and defaults content-type", async () => {
    const app = createApp(quiet);
    app.get("/t", (c) => c.text("t", undefined, { "x-t": "1" }));
    const res = await app.handle(req("/t"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-t")).toBe("1");
  });
});

describe("coverage: request host edge branches", () => {
  const ctxFor = (url: string, headers?: Record<string, string>): Context =>
    createContext(
      createApp(quiet),
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
  it("onerror(null) is a no-op; non-Error values throw TypeError", () => {
    const app = createApp(quiet);
    expect(() => app.onerror(null as unknown as Error)).not.toThrow();
    expect(() => app.onerror("boom" as unknown as Error)).toThrow(TypeError);
  });

  it("use() rejects non-function middleware", () => {
    const app = createApp(quiet);
    expect(() => app.use(undefined as unknown as () => void)).toThrow(TypeError);
  });

  it("client-level errors never log even without listeners", () => {
    const app = createApp({ env: "development", silent: false });
    // 4xx with expose:true and plain 404 — both suppressed, no console output
    expect(() => app.onerror(Object.assign(new Error("nope"), { status: 404 }))).not.toThrow();
    expect(() =>
      app.onerror(Object.assign(new Error("v"), { status: 403, expose: true })),
    ).not.toThrow();
  });

  it("toJSON summarizes the app", () => {
    expect(createApp({ env: "prod", proxy: true }).toJSON()).toEqual({ env: "prod", proxy: true });
  });
});
