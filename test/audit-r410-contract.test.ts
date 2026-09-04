/**
 * R4.10 audit regressions — the 0.7 commit-contract red-team findings
 * (C1/C2/C3), locked from the /tmp probes that first reproduced them:
 *
 *  C1  a post-commit APPEND joins the staged record's entry — the record
 *      merge used to clobber it (lost Vary, cache-poisoning surface).
 *  C2  the error funnel harvests the discarded committed Response's
 *      headers (a sugar commit consumes the record into the Response, so
 *      the record alone under-reported: security headers and cookies
 *      vanished from rebuilt error pages).
 *  C3  post-commit SETs never MIRROR content-describing names — a newer
 *      commit's own content-type/length must not be replayed over.
 */

import { describe, expect, it } from "vitest";

import { Keala } from "../src/index.ts";

const quiet = { env: "test" } as const;
const request = (path: string): Request => new Request(`http://localhost${path}`);

describe("audit C1: post-commit appends survive the record merge", () => {
  it("a staged SET + post-commit APPEND on a hand-built commit keeps both values", async () => {
    const app = new Keala(quiet);
    app.use(async (c, next) => {
      c.setHeader("Vary", "Accept-Encoding");
      await next();
      c.append("Vary", "Origin");
    });
    app.get("/", () => new Response("ok"));
    const res = await app.handle(request("/"));
    expect(res.headers.get("vary")).toBe("Accept-Encoding, Origin");
  });

  it("a sugar commit behaves identically (no sugar/hand-built asymmetry)", async () => {
    const app = new Keala(quiet);
    app.use(async (c, next) => {
      c.setHeader("Vary", "Accept-Encoding");
      await next();
      c.append("Vary", "Origin");
    });
    app.get("/", (c) => c.text("ok"));
    const res = await app.handle(request("/"));
    expect(res.headers.get("vary")).toBe("Accept-Encoding, Origin");
  });

  it("the chronologically-LAST append beats an earlier post-commit SET", async () => {
    const app = new Keala(quiet);
    app.use(async (c, next) => {
      await next();
      c.setHeader("X-M", "set-first");
      c.append("X-M", "appended-last");
    });
    app.get("/", () => new Response("ok"));
    const res = await app.handle(request("/"));
    expect(res.headers.get("x-m")).toBe("set-first, appended-last");
  });
});

describe("audit C2: the error funnel carries a sugar commit's consumed headers", () => {
  it("a staged security header survives an outer throw after a sugar commit", async () => {
    const app = new Keala({ env: "production" });
    app.use(async (c, next) => {
      c.setHeader("X-Frame-Options", "DENY");
      await next();
      throw new Error("late");
    });
    app.get("/", (c) => c.json({ a: 1 }));
    const res = await app.handle(request("/"));
    expect(res.status).toBe(500);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("identical with a hand-built commit (symmetry lock)", async () => {
    const app = new Keala({ env: "production" });
    app.use(async (c, next) => {
      c.setHeader("X-Frame-Options", "DENY");
      await next();
      throw new Error("late");
    });
    app.get("/", () => new Response(JSON.stringify({ a: 1 })));
    const res = await app.handle(request("/"));
    expect(res.status).toBe(500);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("a pre-commit facade cookie survives the rebuilt error page", async () => {
    const app = new Keala({ env: "production", keys: ["k"] });
    app.use(async (c, next) => {
      c.cookies.set("session", "abc", { signed: false });
      await next();
      throw new Error("late");
    });
    app.get("/", (c) => c.json({ a: 1 }));
    const res = await app.handle(request("/"));
    expect(res.status).toBe(500);
    expect(res.headers.getSetCookie()).toEqual(["session=abc"]);
  });

  it("a post-commit SET mirror survives a LATER post-commit sugar call and throw", async () => {
    const app = new Keala({ env: "production" });
    app.use(async (c, next) => {
      await next();
      c.setHeader("X-Mirror", "1");
      void c.text("wrapped");
      throw new Error("late");
    });
    app.get("/", () => new Response("inner"));
    const res = await app.handle(request("/"));
    expect(res.status).toBe(500);
    expect(res.headers.get("x-mirror")).toBe("1");
  });
});

describe("audit C3: content-describing names never replay onto a newer commit", () => {
  it("a post-commit c.type does not override the newer commit's explicit content-type", async () => {
    const app = new Keala(quiet);
    app.use(async (c, next) => {
      await next();
      c.type = "text/csv";
      return new Response("a,b", { headers: { "content-type": "application/json" } });
    });
    app.get("/", () => new Response("x"));
    const res = await app.handle(request("/"));
    expect(res.headers.get("content-type")).toBe("application/json");
  });

  it("a post-commit c.length does not ship a stale content-length for a new body", async () => {
    const app = new Keala(quiet);
    app.use(async (c, next) => {
      await next();
      c.length = 99;
      return new Response("hi");
    });
    app.get("/", () => new Response("x"));
    const res = await app.handle(request("/"));
    expect(res.headers.get("content-length")).not.toBe("99");
    expect(await res.text()).toBe("hi");
  });

  it("the in-place write on the CURRENT response still applies (the write works, only the replay is suppressed)", async () => {
    const app = new Keala(quiet);
    app.use(async (c, next) => {
      await next();
      c.type = "text/csv";
    });
    app.get("/", (c) => c.text("a,b"));
    const res = await app.handle(request("/"));
    expect(res.headers.get("content-type")).toBe("text/csv");
  });
});

describe("audit: set-cookie write-timing semantics (locked as documented)", () => {
  it("a PRE-commit direct Set-Cookie SET joins the handler's cookies", async () => {
    const app = new Keala(quiet);
    app.use(async (c, next) => {
      c.setHeader("Set-Cookie", "early=1");
      await next();
    });
    app.get("/", () => new Response("ok", { headers: { "set-cookie": "handler=1" } }));
    const res = await app.handle(request("/"));
    expect(res.headers.getSetCookie()).toEqual(["handler=1", "early=1"]);
  });

  it("a POST-commit direct Set-Cookie SET replaces (late cookies belong to the facade)", async () => {
    const app = new Keala(quiet);
    app.use(async (c, next) => {
      await next();
      c.setHeader("Set-Cookie", "late=1");
    });
    app.get("/", () => new Response("ok", { headers: { "set-cookie": "handler=1" } }));
    const res = await app.handle(request("/"));
    expect(res.headers.getSetCookie()).toEqual(["late=1"]);
  });
});
