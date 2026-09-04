/**
 * Security-relevant assertions ported from the archived koa/official parity
 * suites (docs/MIGRATION.md §2: the parity FILES are archived, but these
 * semantics are regression locks and stay).
 *
 * 0.7 migration: redirect("back")/back(), c.message statusText and
 * c.hostname are deleted APIs — their locks (referrer preference, the
 * cross-origin Referrer defense, custom status phrases, IPv6 hostname
 * normalization) are gone with them, as is the `c.body = <Response>` merge
 * quirk (return the Response instead).
 */

import { describe, expect, it } from "vitest";

import { Keala } from "../src/core/app.ts";

const req = (path: string, init?: RequestInit) => new Request(`http://localhost:3000${path}`, init);

const quiet = { env: "test" } as const;

describe("ported parity security semantics", () => {
  it("attachment with unicode filenames emits RFC 5987 encoding + mime", async () => {
    const app = new Keala(quiet);
    app.get("/a", (c) => {
      c.attachment("年度报告.csv");
      c.body = "x";
    });
    const res = await app.handle(new Request("http://localhost:3000/a"));
    expect(res.headers.get("content-disposition")).toContain("filename*=UTF-8''");
    // koa parity: the inference goes through the same expansion c.type
    // uses — text/* extensions carry their charset.
    expect(res.headers.get("content-type")).toContain("text/csv");
  });

  it("GHSA-c5vw-j4hf-j526: attachment never overrides an existing Content-Type", async () => {
    const app = new Keala(quiet);
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
    const app = new Keala(quiet);
    app.get("/e", (c) => {
      c.etag = "v42";
      c.body = "x";
    });
    const res = await app.handle(new Request("http://localhost:3000/e"));
    expect(res.headers.get("etag")).toBe('"v42"');
  });

  it("error responses hide 5xx messages; staged headers ride along (koa parity)", async () => {
    // Verified against koa 3.2.1: headers the chain staged before the throw
    // stay on the error response (security middleware must cover error
    // pages); only content-DESCRIBING headers drop, and the 5xx message is
    // never leaked.
    const app = new Keala(quiet);
    app.get("/boom", (c) => {
      c.setHeader("X-Before", "1");
      c.setHeader("Content-Length", "999");
      c.cookies.set("sid", "abc");
      c.throw(500, "secret details");
    });
    const res = await app.handle(new Request("http://localhost:3000/boom"));
    expect(res.status).toBe(500);
    expect(res.headers.get("x-before")).toBe("1");
    expect(res.headers.get("content-length")).toBeNull(); // describes the failed body
    expect(await res.text()).toBe("Internal Server Error");
    expect(res.headers.getSetCookie().length).toBe(1);
  });

  it("exposed 4xx errors surface their message", async () => {
    const app = new Keala(quiet);
    app.get("/teapot", (c) => {
      c.throw(418, "short and stout");
    });
    const res = await app.handle(new Request("http://localhost:3000/teapot"));
    expect(res.status).toBe(418);
    expect(await res.text()).toBe("short and stout");
  });

  it("unhandled requests answer 404 Not Found", async () => {
    const app = new Keala(quiet);
    const res = await app.handle(new Request("http://localhost:3000/nowhere"));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not Found");
  });
});

// ---------------------------------------------------------------------------
// koa corpus locks — behaviors that existed but were never locked by a test
// (found by the corpus absorption audit; each maps to a koa test case)
// ---------------------------------------------------------------------------

describe("koa corpus locks", () => {
  it("redirect normalizes absolute targets through URL (backslash-at stays a path)", async () => {
    const app = new Keala(quiet);
    app.get("/r", (c) => c.redirect("http://google.com\\@apple.com"));
    const res = await app.handle(req("/r"));
    // The \@ must never become a userinfo separator (koa redirect.test:17):
    // the backslash normalizes to a path slash, @ lands in the PATH.
    expect(res.headers.get("location")).toBe("http://google.com/@apple.com");
    expect(res.status).toBe(302);
  });

  it("attachment: type option, ?-mask fallback, basename, and invalid types", async () => {
    const app = new Keala(quiet);
    app.get("/inline", (c) => {
      c.attachment("doc.pdf", { type: "inline" });
      c.body = "x";
    });
    const inline = await app.handle(req("/inline"));
    expect(inline.headers.get("content-disposition")).toContain("inline");
    // No-extension filenames keep the disposition but gain no content-type.
    app.get("/noext", (c) => {
      c.attachment("path/to/README");
      c.body = "x";
    });
    const noext = await app.handle(req("/noext"));
    expect(noext.headers.get("content-disposition")).toContain("README");
    // Path separators never reach the header.
    app.get("/basename", (c) => {
      c.attachment("path/to/tobi.png");
      c.body = "x";
    });
    const base = await app.handle(req("/basename"));
    expect(base.headers.get("content-disposition")).not.toContain("/");
    expect(base.headers.get("content-type")).toContain("image/png");
    // Invalid disposition types throw.
    app.get("/badtype", (c) => {
      c.attachment("f.txt", { type: "attachment; evil" });
      c.body = "x";
    });
    expect((await app.handle(req("/badtype"))).status).toBe(500);
  });

  it("R4.3: the statusCode alias is gone — only .status counts; junk statuses coerce to 500", async () => {
    const app = new Keala(quiet);
    app.get("/teapot", () => {
      const err = new Error("short and stout") as Error & { statusCode: number };
      err.statusCode = 418;
      throw err;
    });
    // No valid `.status` → wrapped as an unexposed 500 (the alias fallback
    // chain was http-errors ecosystem compat, deleted by R4.3).
    expect((await app.handle(req("/teapot"))).status).toBe(500);
    app.get("/junk", () => {
      const err = new Error("junk") as Error & { status: unknown };
      err.status = "notnumber";
      throw err;
    });
    expect((await app.handle(req("/junk"))).status).toBe(500);
  });

  it("c.URL exposes the live WHATWG URL view", async () => {
    const app = new Keala(quiet);
    app.get("/u", (c) => {
      c.body = c.URL instanceof URL ? c.URL.pathname : "not a URL";
    });
    expect(await (await app.handle(req("/u"))).text()).toBe("/u");
  });
});
