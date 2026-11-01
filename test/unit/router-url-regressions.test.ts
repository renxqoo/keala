/**
 * Regression locks for src/router/url.ts — the review round that found them
 * ran as red tests under test/red-review/ (pattern/url reviewer). The fixes:
 *
 *   - redirectTargetSegments: a ":" inside the QUERY or FRAGMENT is data, not
 *     a param marker — the suffix splits off and rides verbatim instead of
 *     being compiled into the path and percent-encoded into the Location
 *     ("/new?x=1:2" used to redirect to "/new%3Fx%3D1%3A2"). A "?" inside a
 *     ":"-leading segment still belongs to the ":param?" optional-marker
 *     syntax (compilePattern owns the junk error, exactly as before).
 *   - buildURL: "" for a plain param can never address the route (a param
 *     consumes a NON-EMPTY segment) — treated as missing: optionals skip,
 *     required params throw. Wildcard "" stays (the documented bare-prefix
 *     form, "/w/" for {wildcard: ""}).
 *   - buildURL object form: lookups go through Object.hasOwn so a param
 *     named like an Object.prototype member reads as ABSENT instead of
 *     resolving the inherited function.
 */
import { describe, expect, it } from "vitest";

import { Keala } from "../../src/core/app.ts";
import { compilePattern } from "../../src/router/pattern.ts";
import { buildURL, redirectTargetSegments } from "../../src/router/url.ts";

const quiet = { env: "test" } as const;
const req = (path: string) => new Request(`http://localhost:3000${path}`);

describe("locks correct: redirect destinations with a colon in the query/fragment stay verbatim", () => {
  it("a query-string destination is verbatim even when the query contains a colon", async () => {
    const app = new Keala(quiet);
    app.redirect("/old", "/new?x=1:2", 302);
    const res = await app.handle(req("/old"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/new?x=1:2");
  });

  it("a fragment destination is verbatim even when the fragment contains a colon", async () => {
    const app = new Keala(quiet);
    app.redirect("/old", "/new#f:x", 301);
    const res = await app.handle(req("/old"));
    expect(res.headers.get("location")).toBe("/new#f:x");
  });

  it("redirectTargetSegments must not treat a query-carrying string as a param path", () => {
    expect(redirectTargetSegments("/new?x=1:2")).toBeNull();
    expect(redirectTargetSegments("/new#f:x")).toBeNull();
  });

  it("control: a colon-free query destination stays verbatim; params substitute", async () => {
    const app = new Keala(quiet);
    app.redirect("/old", "/new?x=1", 302);
    app.redirect("/u/:id", "/v/:id", 302);
    expect((await app.handle(req("/old"))).headers.get("location")).toBe("/new?x=1");
    expect((await app.handle(req("/u/a%20b"))).headers.get("location")).toBe("/v/a%20b");
  });

  it("the ':param?' optional marker is never mistaken for a query separator", async () => {
    const app = new Keala(quiet);
    app.redirect("/u/:id", "/v/:id?/tail", 302);
    const res = await app.handle(req("/u/9"));
    expect(res.headers.get("location")).toBe("/v/9/tail");
  });
});

describe("locks correct: buildURL rejects empty values for plain params", () => {
  it("a required param with an empty value throws instead of building an unaddressable URL", () => {
    const app = new Keala(quiet);
    app.get("user", "/users/:id", (c) => c.text(`u:${c.params("id")}`));
    expect(() => app.url("user", { id: "" })).toThrow(/Missing required parameter "id"/);
  });

  it("an empty param value must never address a DIFFERENT registered route", () => {
    const app = new Keala(quiet);
    app.get("xy", "/:x/y", (c) => c.text("xy-route"));
    app.get("/y", (c) => c.text("other-route"));
    expect(() => app.url("xy", { x: "" })).toThrow(/Missing required parameter "x"/);
  });

  it("an optional param with an empty value is skipped, like an absent one", () => {
    expect(buildURL(compilePattern("/o/:x?/t").segments, { x: "" })).toBe("/o/t");
    expect(buildURL(compilePattern("/o/:x?/t").segments, {})).toBe("/o/t");
  });

  it('wildcard "" stays the documented bare-prefix form', () => {
    expect(buildURL(compilePattern("/w/*").segments, { wildcard: "" })).toBe("/w/");
  });
});

describe("locks correct: buildURL object form reads own properties only", () => {
  it("a param name colliding with an Object.prototype member throws Missing required parameter", () => {
    const segments = compilePattern("/x/:toString").segments;
    expect(() => buildURL(segments, {} as Record<string, string>)).toThrow(
      /Missing required parameter "toString"/,
    );
  });

  it("an explicitly provided value under such a name still wins", () => {
    const segments = compilePattern("/x/:toString").segments;
    expect(buildURL(segments, { toString: "v" })).toBe("/x/v");
  });
});
