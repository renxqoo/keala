/**
 * RED-TEAM ROUND 3 — PIPELINE / FINALIZER / CONTEXT LEDGER (assertion-red tests).
 *
 * Scope: core/respond.ts, core/context/* (context/response/request/sugar/pool/
 * decorate), core/compose.ts, core/dispatch.ts, http/errors.ts, http/status.ts.
 *
 * 0.7 migration (docs/KEALA-NATIVE-API.md): the rule-4 rebuild machine is
 * gone. PIPE-2's post-commit `c.status` downgrade now locks the commit
 * TypeError; PIPE-2b locks the supported replacement pattern (middleware
 * constructs and returns a new Response). PIPE-3 keeps its cache-variant
 * concern through the surviving `c.append("Vary", …)`. PIPE-4/5/6 (c.message
 * statusText plumbing) are deleted with the API — statusText customization
 * no longer exists, so there is nothing left to lock.
 *
 *  [PIPE-1] HIGH  open redirect — src/utils/url.ts encodeUrlValue() keeps
 *          U+005C "\" unencoded. response.ts redirect() ships e.g.
 *          `Location: /\evil.com`; WHATWG URL parsing (every browser) treats
 *          "\" as "/" in special URLs, so that resolves to the authority
 *          "//evil.com" → cross-origin redirect. koa's encodeurl (whitelist)
 *          percent-encodes backslash. Trigger: any app reflecting input into
 *          c.redirect() (returnUrl pattern).
 *  [PIPE-7] LOW   src/core/context/context.ts cookies getter materializes
 *          `headersRecord ??= {}` — a prototype-FULL object, violating
 *          recordOf()'s documented null-proto invariant ("inherited keys
 *          (constructor, __proto__) must never surface"). After merely
 *          touching c.cookies, c.has("constructor") is true and
 *          c.resHeader("constructor") would return Object's constructor.
 */

import { describe, expect, it } from "vitest";

import { Keala, type Application } from "../../src/core/app.ts";

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

  it("PIPE-2 (0.7): a post-commit c.status downgrade throws instead of rebuilding", async () => {
    const app = new Keala(quiet);
    let caught: unknown;
    app.use(async (c, next) => {
      await next();
      try {
        c.status = 204; // the old empty-status downgrade — rule-4 rebuild is gone
      } catch (err) {
        caught = err;
      }
    });
    app.use((c) => {
      c.status = 200;
      c.setHeader("Content-Length", "5");
      return c.text("hello");
    });
    const res = await drive(app, new Request("http://localhost:3000/"));
    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as Error).message).toContain("response already committed");
    // The committed Response survives the rejected write untouched.
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
  });

  it("PIPE-2b (0.7): a fresh-check middleware swaps in a 304 Response keeping validators", async () => {
    const app = new Keala(quiet);
    app.use(async (c, next) => {
      await next();
      // 0.7 supported pattern: construct the replacement Response by hand.
      // Commit-aware reads (c.resHeader) deliver the staged validators.
      const headers = new Headers();
      const etag = c.resHeader("ETag");
      if (etag !== "") headers.set("etag", etag);
      return new Response(null, { status: 304, headers });
    });
    app.use((c) => {
      c.setHeader("ETag", '"v1"');
      return c.text("hello");
    });
    const res = await drive(app, new Request("http://localhost:3000/"));
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe('"v1"'); // validators must survive
    expect(res.headers.get("content-type")).toBe(null);
    expect(res.headers.get("content-length")).toBe(null);
  });

  it("PIPE-3 (0.7): a post-commit c.append('Vary') merges with the committed Vary", async () => {
    const app = new Keala(quiet);
    app.use(async (c, next) => {
      await next();
      c.append("Vary", "Accept"); // vary() is gone; append is the surviving write
    });
    app.use((c) => {
      c.setHeader("Vary", "Origin");
      return c.text("hi");
    });
    const res = await drive(app, new Request("http://localhost:3000/"));
    expect(res.headers.get("vary")).toBe("Origin, Accept"); // actual: "Accept"
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
