/**
 * RED-TEAM ROUND 3 — PIPELINE / FINALIZER / CONTEXT LEDGER (assertion-red tests).
 *
 * Scope: core/respond.ts, core/context/* (context/response/request/sugar/pool/
 * decorate), core/compose.ts, core/dispatch.ts, http/errors.ts, http/status.ts.
 * Every `it()` below encodes the CORRECT behavior and FAILS against the
 * current src/ (each maps to a confirmed bug):
 *
 *  [PIPE-1] HIGH  open redirect — src/utils/url.ts encodeUrlValue() keeps
 *          U+005C "\" unencoded. response.ts redirect()/back() ship e.g.
 *          `Location: /\evil.com`; WHATWG URL parsing (every browser) treats
 *          "\" as "/" in special URLs, so that resolves to the authority
 *          "//evil.com" → cross-origin redirect. koa's encodeurl (whitelist)
 *          percent-encodes backslash. Trigger: any app reflecting input into
 *          c.redirect() (returnUrl pattern).
 *  [PIPE-2] MED   RFC 9110 §8.6 violation — src/core/respond.ts
 *          rebuildCommitted(): a post-commit `c.status = 204/304` (the
 *          canonical fresh-check middleware over return-style handlers) swaps
 *          the body for null but keeps the committed response's
 *          content-type/content-length. A 204 MUST NOT carry Content-Length;
 *          the state-mode path (response.ts status setter + fromState)
 *          strips these — the rebuild path has no equivalent.
 *  [PIPE-3] MED   cache corruption — src/core/context/response.ts vary():
 *          it seeds the dedupe from resHeader(), which reads ONLY the staging
 *          record. After a Response commits, the first post-commit vary()
 *          therefore REPLACES the committed `Vary` instead of appending to it
 *          (append() has committed-seeding for other headers; vary's set()
 *          path bypasses it) — downstream cache-variant headers are dropped.
 *  [PIPE-4] MED   opaque 500 from a legal c.message — response.ts message
 *          setter rejects only CR/LF, but undici's Response constructor
 *          rejects every other C0 control (and DEL) in statusText. A handler
 *          doing `c.message = \`x${raw}\`` with a stray NUL/BEL/VT/FF/ESC
 *          loses the entire response to a 500.
 *  [PIPE-5] LOW   src/core/context/sugar.ts sugarHtml(): statusInit only
 *          carries statusText when a status was passed/staged, so a staged
 *          `c.message` is dropped by c.html() — while c.text()/c.json()
 *          preserve it (locked in test/agent3-pipeline.test.ts for text).
 *  [PIPE-6] LOW   src/core/respond.ts rebuildCommitted(): the documented
 *          rule-4 contract ("a post-commit c.status/c.message overrides the
 *          reason phrase") is unimplemented for message-only overrides —
 *          `overridden` requires flags 16 && 1 and the message setter sets
 *          neither, so a message override alone never reaches the rebuild.
 *  [PIPE-7] LOW   src/core/context/context.ts cookies getter materializes
 *          `headersRecord ??= {}` — a prototype-FULL object, violating
 *          recordOf()'s documented null-proto invariant ("inherited keys
 *          (constructor, __proto__) must never surface"). After merely
 *          touching c.cookies, c.has("constructor") is true and
 *          c.resHeader("constructor") would return Object's constructor.
 */

import { describe, expect, it } from "vitest";

import { Keala, type Application } from "../src/core/app.ts";

const quiet = { env: "test" } as const;
const drive = (app: Application, request: Request) => app.handle(request);

describe("redteam r3 — pipeline/finalizer confirmed bugs", () => {
  it("PIPE-1: c.redirect must percent-encode backslash (open redirect via /\\evil.com)", async () => {
    const app = new Keala(quiet);
    app.get("/r", (c) => {
      // The classic reflected-redirect pattern: ?next=%2F%5Cevil.com
      c.redirect(String(c.query("next")));
    });
    const res = await drive(app, new Request("http://good.com:3000/r?next=%2F%5Cevil.com"));
    const location = res.headers.get("location") ?? "";
    // What a browser does with the header value (WHATWG URL semantics):
    const resolved = new URL(location, "http://good.com:3000/r");
    expect(location).toBe("/%5Cevil.com"); // actual: "/\evil.com"
    expect(resolved.host).toBe("good.com:3000"); // actual: "evil.com" — cross-origin
  });

  it("PIPE-2: post-commit 204 must drop content-type/content-length (RFC 9110 MUST NOT)", async () => {
    const app = new Keala(quiet);
    app.use(async (c, next) => {
      await next();
      c.status = 204; // canonical empty-status downgrade after the commit
    });
    app.use((c) => {
      c.status = 200;
      c.set("Content-Length", "5");
      return c.text("hello");
    });
    const res = await drive(app, new Request("http://localhost:3000/"));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(res.headers.get("content-type")).toBe(null); // actual: text/plain; charset=utf-8
    expect(res.headers.get("content-length")).toBe(null); // actual: "5"
  });

  it("PIPE-2b: post-commit 304 downgrade strips content headers like the state path", async () => {
    const app = new Keala(quiet);
    app.use(async (c, next) => {
      await next();
      c.status = 304; // fresh-check pattern
    });
    app.use((c) => {
      c.status = 200;
      c.set("ETag", '"v1"');
      c.set("Content-Length", "5");
      return c.text("hello");
    });
    const res = await drive(app, new Request("http://localhost:3000/"));
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe('"v1"'); // validators must survive
    expect(res.headers.get("content-type")).toBe(null);
    expect(res.headers.get("content-length")).toBe(null);
  });

  it("PIPE-3: post-commit vary() must merge with the committed Vary, not replace it", async () => {
    const app = new Keala(quiet);
    app.use(async (c, next) => {
      await next();
      c.vary("Accept");
    });
    app.use((c) => {
      c.set("Vary", "Origin");
      return c.text("hi");
    });
    const res = await drive(app, new Request("http://localhost:3000/"));
    expect(res.headers.get("vary")).toBe("Origin, Accept"); // actual: "Accept"
  });

  it("PIPE-4: a NUL in c.message must not turn the response into a 500", async () => {
    const app = new Keala(quiet);
    app.use((c) => {
      c.status = 200;
      c.message = "ok\u0000marker"; // passes the CR/LF-only setter check
      c.body = "x";
    });
    const res = await drive(app, new Request("http://localhost:3000/"));
    expect(res.status).toBe(200); // actual: 500 (undici rejects NUL statusText)
    expect(await res.text()).toBe("x");
  });

  it("PIPE-5: c.html() keeps a staged c.message as statusText like c.text()/c.json()", async () => {
    const app = new Keala(quiet);
    app.use((c) => {
      c.message = "Custom";
      return c.html("<b>hi</b>");
    });
    const res = await drive(app, new Request("http://localhost:3000/"));
    expect(res.statusText).toBe("Custom"); // actual: "" (text() returns "Custom")
  });

  it("PIPE-6: a post-commit c.message overrides the reason phrase (rule-4 contract)", async () => {
    const app = new Keala(quiet);
    app.use(async (c, next) => {
      await next();
      c.message = "Custom Phrase";
      c.set("X-Late", "1"); // force the rule-4 rebuild path
    });
    app.use((c) => c.text("hi"));
    const res = await drive(app, new Request("http://localhost:3000/"));
    expect(res.headers.get("x-late")).toBe("1"); // rebuild ran
    expect(res.statusText).toBe("Custom Phrase"); // actual: ""
  });

  it("PIPE-7: touching c.cookies must not put Object.prototype under the header record", async () => {
    const app = new Keala(quiet);
    let observed = true;
    app.use((c) => {
      expect(c.has("constructor")).toBe(false); // control: null-proto record
      void c.cookies; // materializes the header record via the cookies getter
      observed = c.has("constructor");
      c.body = "ok";
    });
    const res = await drive(app, new Request("http://localhost:3000/"));
    expect(res.status).toBe(200);
    expect(observed).toBe(false); // actual: true — record is a plain {} object
  });
});
