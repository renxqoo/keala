/**
 * Setter-semantics locks for the `c.attachment` / `c.etag` / `c.type`
 * response-setter family.
 *
 * U1 split (docs/KEALA-NATIVE-API-MIGRATION.md §2.4): koa is no longer a
 * contract. The koa-alignment half of the retired parity suite is deleted;
 * the keala behavior locks were migrated (error funnel →
 * test/security/error-disclosure.test.ts, redirect normalization →
 * test/security/baseline-extended.test.ts, c.URL →
 * test/unit/request-ergonomics.test.ts).
 *
 * What remains locks semantics of setters that are STILL LIVE API today and
 * are scheduled for deletion in U3c — this whole file goes with them.
 * Do not add new tests here.
 */

import { describe, expect, it } from "vitest";

import { Keala } from "../../src/core/app.ts";

const req = (path: string) => new Request(`http://localhost:3000${path}`);

const quiet = { env: "test" } as const;

describe("attachment/etag setter semantics (deleted with the setters in U3c)", () => {
  it("attachment with unicode filenames emits RFC 5987 encoding + mime", async () => {
    const app = new Keala(quiet);
    app.get("/a", (c) => {
      c.attachment("年度报告.csv");
      c.body = "x";
    });
    const res = await app.handle(req("/a"));
    expect(res.headers.get("content-disposition")).toContain("filename*=UTF-8''");
    // The inference goes through the same expansion c.type uses — text/*
    // extensions carry their charset.
    expect(res.headers.get("content-type")).toContain("text/csv");
  });

  it("GHSA-c5vw-j4hf-j526: attachment never overrides an existing Content-Type", async () => {
    const app = new Keala(quiet);
    app.get("/a", (c) => {
      c.type = "application/json";
      c.attachment("malicious.html");
      c.body = "{}";
    });
    const res = await app.handle(req("/a"));
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="malicious.html"');
  });

  it("etag setter quotes bare values", async () => {
    const app = new Keala(quiet);
    app.get("/e", (c) => {
      c.etag = "v42";
      c.body = "x";
    });
    const res = await app.handle(req("/e"));
    expect(res.headers.get("etag")).toBe('"v42"');
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
});
