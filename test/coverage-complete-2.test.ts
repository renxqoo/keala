/**
 * Branch-coverage completion, part 2: response sugar combinations, router
 * group validation/redirect/url paths, content-disposition fallbacks and
 * app-level validation branches.
 */

import { describe, expect, it } from "vitest";

import { createApp } from "../src/core/app.ts";
import { createRouter } from "../src/router/group.ts";
import { contentDisposition } from "../src/utils/text.ts";

const quiet = { env: "test" } as const;
const req = (path: string, init?: RequestInit) => new Request(`http://localhost:3000${path}`, init);

describe("coverage: response sugar combinations", () => {
  it("text with explicit status keeps it and adds a default content-type with headers", async () => {
    const app = createApp(quiet);
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
    const app = createApp(quiet);
    app.get("/m", (c) => {
      c.set("X-Merged", "1");
      return c.text("body");
    });
    const res = await app.handle(req("/m"));
    expect(res.headers.get("x-merged")).toBe("1");
    expect(await res.text()).toBe("body");
  });

  it("json carries status and headers; html always wins content-type", async () => {
    const app = createApp(quiet);
    app.get("/j", (c) => c.json({ ok: true }, 202, { "x-j": "1" }));
    app.get("/h", (c) => c.html("<b>x</b>", 200, { "content-type": "text/plain" }));
    const j = await app.handle(req("/j"));
    expect(j.status).toBe(202);
    expect(j.headers.get("x-j")).toBe("1");
    expect((j.headers.get("content-type") ?? "").split(";")[0]).toBe("application/json");
    expect(await j.text()).toBe('{"ok":true}');
    const h = await app.handle(req("/h"));
    expect(h.headers.get("content-type")).toContain("text/html");
  });

  it("state-mode object bodies carry status through Response.json", async () => {
    const app = createApp(quiet);
    app.get("/s", (c) => {
      c.status = 201;
      c.set("x-s", "1");
      c.body = { made: true };
    });
    const res = await app.handle(req("/s"));
    expect(res.status).toBe(201);
    expect(res.headers.get("x-s")).toBe("1");
    expect(await res.text()).toBe('{"made":true}');
  });
});

describe("coverage: router group paths", () => {
  it("redirect with :params rebuilds from matched captures", async () => {
    const app = createApp(quiet);
    app.get("/users/:id", (c) => c.text("u"));
    app.redirect("/u/:id", "/users/:id", 301);
    const res = await app.handle(req("/u/77"));
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/users/77");
  });

  it("use()/param() argument validation throws", () => {
    const router = createRouter();
    expect(() => router.use("nope" as unknown as () => void)).toThrow(TypeError);
    expect(() => router.param("", () => undefined)).toThrow(TypeError);
    expect(() => router.param("x", "nope" as unknown as () => void)).toThrow(TypeError);
  });

  it("router.url throws for unknown names and missing params", () => {
    const router = createRouter();
    router.get("thing", "/t/:id", () => undefined);
    expect(() => router.url("ghost", {})).toThrow(/No route registered/);
    expect(() => router.url("thing", {})).toThrow(/Missing required parameter/);
    expect(router.url("thing", { id: "5" })).toBe("/t/5");
    expect(router.route("thing")).toBe("/t/:id");
    expect(router.route("ghost")).toBeUndefined();
  });

  it("prefixed groups carry their prefix into mounted paths", async () => {
    const app = createApp(quiet);
    const api = createRouter({ prefix: "/v2" });
    api.get("/items", (c) => c.text("items"));
    app.mount("/api", api);
    expect(await (await app.handle(req("/api/v2/items"))).text()).toBe("items");
  });

  it("on() accepts any casing and rejects unknown methods", async () => {
    const app = createApp(quiet);
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
    const app = createApp(quiet);
    expect(() => app.param("", () => undefined)).toThrow(TypeError);
    expect(() => app.param("x", "nope" as unknown as () => void)).toThrow(TypeError);
  });
});
