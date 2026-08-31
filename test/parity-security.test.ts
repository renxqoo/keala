/**
 * Security-relevant assertions ported from the archived koa/official parity
 * suites (docs/MIGRATION.md §2: the parity FILES are archived, but these
 * semantics are regression locks and stay).
 */

import { describe, expect, it } from "vitest";

import { createApp } from "../src/core/app.ts";

const quiet = { env: "test" } as const;

describe("ported parity security semantics", () => {
  it("redirect(back) prefers same-origin Referrer, then alt, then /", async () => {
    const app = createApp(quiet);
    app.get("/back", (c) => {
      c.redirect("back", "/alt");
    });
    app.get("/back-noalt", (c) => {
      c.redirect("back");
    });
    const referrer = await app.handle(
      new Request("http://localhost:3000/back", { headers: { Referrer: "/previous-page" } }),
    );
    expect(referrer.headers.get("location")).toBe("/previous-page");

    const alt = await app.handle(new Request("http://localhost:3000/back"));
    expect(alt.headers.get("location")).toBe("/alt");

    const root = await app.handle(new Request("http://localhost:3000/back-noalt"));
    expect(root.headers.get("location")).toBe("/");
  });

  it("attachment with unicode filenames emits RFC 5987 encoding + mime", async () => {
    const app = createApp(quiet);
    app.get("/a", (c) => {
      c.attachment("年度报告.csv");
      c.body = "x";
    });
    const res = await app.handle(new Request("http://localhost:3000/a"));
    expect(res.headers.get("content-disposition")).toContain("filename*=UTF-8''");
    expect(res.headers.get("content-type")).toBe("text/csv");
  });

  it("GHSA-c5vw-j4hf-j526: attachment never overrides an existing Content-Type", async () => {
    const app = createApp(quiet);
    app.get("/a", (c) => {
      c.type = "application/json";
      c.attachment("malicious.html");
      c.body = "{}";
    });
    const res = await app.handle(new Request("http://localhost:3000/a"));
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="malicious.html"');
  });

  it("etag setter quotes bare values", async () => {
    const app = createApp(quiet);
    app.get("/e", (c) => {
      c.etag = "v42";
      c.body = "x";
    });
    const res = await app.handle(new Request("http://localhost:3000/e"));
    expect(res.headers.get("etag")).toBe('"v42"');
  });

  it("web Response as body merges headers through validated set()", async () => {
    const app = createApp(quiet);
    app.get("/r", (c) => {
      // Inner status wins (koa semantics); headers merge via set().
      c.body = new Response("inner", {
        status: 201,
        headers: { "x-from-inner": "1", "content-type": "text/csv" },
      });
    });
    const res = await app.handle(new Request("http://localhost:3000/r"));
    expect(res.status).toBe(201);
    expect(res.headers.get("x-from-inner")).toBe("1");
    expect(res.headers.get("content-type")).toBe("text/csv");
    expect(await res.text()).toBe("inner");
  });

  it("error responses reset headers (except set-cookie) and hide 5xx messages", async () => {
    const app = createApp(quiet);
    app.get("/boom", (c) => {
      c.set("X-Before", "1");
      c.cookies.set("sid", "abc");
      c.throw(500, "secret details");
    });
    const res = await app.handle(new Request("http://localhost:3000/boom"));
    expect(res.status).toBe(500);
    expect(res.headers.get("x-before")).toBeNull();
    expect(await res.text()).toBe("Internal Server Error");
    expect(res.headers.getSetCookie().length).toBe(1);
  });

  it("exposed 4xx errors surface their message", async () => {
    const app = createApp(quiet);
    app.get("/teapot", (c) => {
      c.throw(418, "short and stout");
    });
    const res = await app.handle(new Request("http://localhost:3000/teapot"));
    expect(res.status).toBe(418);
    expect(await res.text()).toBe("short and stout");
  });

  it("custom status message survives to statusText", async () => {
    const app = createApp(quiet);
    app.get("/m", (c) => {
      c.status = 418;
      c.message = "short and stout";
      c.body = "x";
    });
    const res = await app.handle(new Request("http://localhost:3000/m"));
    expect(res.status).toBe(418);
    expect(res.statusText).toBe("short and stout");
  });

  it("unhandled requests answer 404 Not Found", async () => {
    const app = createApp(quiet);
    const res = await app.handle(new Request("http://localhost:3000/nowhere"));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not Found");
  });
});
