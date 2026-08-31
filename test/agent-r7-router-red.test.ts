/**
 * Round-7 router / URL / HTTP-protocol audit — CONFIRMED RED tests only.
 *
 * Every expectation below describes a stable public-contract failure observed
 * on the current implementation.  This file intentionally does not modify or
 * work around the implementation.
 */

import { describe, expect, it } from "vitest";

import { Eleu } from "../src/index.ts";
import { acceptsType } from "../src/negotiation/accepts.ts";
import { parseQuery } from "../src/utils/query.ts";
import { validateHeaderValue } from "../src/utils/text.ts";

const quiet = { env: "test" } as const;
const request = (path: string, init?: RequestInit): Request =>
  new Request(`http://localhost:3000${path}`, init);

describe("R7-ROUTER-1 [HIGH] named URL round-trip for an encoded slash", () => {
  it("keeps %2F inside its original static segment", async () => {
    const app = new Eleu(quiet);
    app.get("encoded", "/files/a%2Fb", (c) => c.text("encoded-segment"));
    app.get("/files/a/b", (c) => c.text("different-resource"));

    // Repro: the registered route is one static segment named "a/b" in the
    // router's canonical keyspace. Expected: url() emits /files/a%2Fb and the
    // generated URL reaches that route. Actual: buildURL uses the wildcard
    // encoder for static segments, preserves '/', and emits /files/a/b,
    // silently addressing the different resource registered above.
    // Root cause: src/router/router.ts:418-430.
    const built = app.url("encoded");
    expect(built).toBe("/files/a%2Fb");
    const response = await app.handle(request(built));
    expect([response.status, await response.text()]).toEqual([200, "encoded-segment"]);
  });
});

describe("R7-ROUTER-2 [HIGH] failed registration is atomic", () => {
  it("does not publish the failed name or poison a later router rebuild", async () => {
    const app = new Eleu(quiet);
    app.get("healthy", "/healthy", (c) => c.text("healthy"));

    // Repro: malformed custom regex compilation throws as promised.
    expect(() => app.get("broken", "/broken/:id(", (c) => c.text("unreachable"))).toThrow(
      /Unbalanced custom pattern/,
    );

    // Expected: a throwing registration has no observable effect and the app
    // remains configurable. Actual: defs/named are mutated before bindDef;
    // route("broken") leaks the rejected definition and use() recompiles it,
    // throwing the same setup error again.
    // Root cause: src/router/router.ts:278-280.
    expect(app.route("broken")).toBeUndefined();
    expect(() =>
      app.use(async (_c, next) => {
        await next();
      }),
    ).not.toThrow();

    const response = await app.handle(request(app.url("healthy")));
    expect([response.status, await response.text()]).toEqual([200, "healthy"]);
  });
});

describe("R7-NEG-1 [MEDIUM] Accept extensions after q are not media constraints", () => {
  it("accepts a matching media type carrying an accept-ext after the weight", () => {
    // RFC 9110 media parameters precede q; parameters after q are accept-ext
    // metadata and do not constrain the selected representation.
    // Expected: text/html. Actual: false because every non-q parameter is put
    // in Preference.params, including extensions seen after q.
    // Root cause: src/negotiation/accepts.ts:60-72,91-93.
    expect(acceptsType("text/html;q=1;foo=bar", ["text/html"])).toBe("text/html");
  });
});

describe("R7-NEG-2 [MEDIUM] provided media types retain their parameters", () => {
  it("matches the same parameterized client and server representation", () => {
    // The public accepts API permits MIME strings, not only shorthands.
    // Expected: the exactly provided representation. Actual: false; the
    // server string is never parsed into type/subtype/params and mediaScore
    // unconditionally rejects any client range that has parameters.
    // Root cause: src/negotiation/accepts.ts:91-102,251-258.
    const representation = "text/html;level=1";
    expect(acceptsType(representation, [representation])).toBe(representation);
  });
});

describe("R7-NEG-3 [MEDIUM] malformed qvalues do not gain quality 1", () => {
  it("ignores an item whose q parameter is not a qvalue", () => {
    // q=bogus is not RFC qvalue syntax. Expected: the valid JSON alternative
    // wins. Actual: NaN leaves the initialized q=1 untouched, so malformed
    // input is promoted above application/json;q=0.5.
    // Root cause: src/negotiation/accepts.ts:58,62-65.
    expect(
      acceptsType("text/html;q=bogus, application/json;q=0.5", ["text/html", "application/json"]),
    ).toBe("application/json");
  });
});

describe("R7-QUERY-1 [MEDIUM] malformed escapes still decode valid query bytes", () => {
  it("matches Node/Koa querystring recovery around a malformed escape", () => {
    // Koa's querystring semantics recover component-by-component: '+' is a
    // space and valid escapes remain decodable even if another '%' is bad.
    // Expected: "A %ZZB". Actual: the catch returns the entire raw component,
    // losing both plus conversion and every valid escape.
    // Root cause: src/utils/query.ts:14-19.
    expect(parseQuery("value=%41+%ZZ%42").value).toBe("A %ZZB");
  });
});

describe("R7-URL-1 [LOW] assigning query preserves URL fragments", () => {
  it("places the serialized query before the existing fragment", async () => {
    const app = new Eleu(quiet);
    let observed = "";
    app.use((c) => {
      c.url = "/resource?old=1#section";
      c.query = { page: "2" };
      observed = c.url;
      c.body = "ok";
    });
    await app.handle(request("/"));

    // querystring/search setters already use splitUrl and preserve hash. The
    // query-object setter instead slices only at '?', dropping '#section'.
    // Root cause: src/core/context/request.ts:177-183.
    expect(observed).toBe("/resource?page=2#section");
  });
});

describe("R7-HTTP-1 [MEDIUM] response field values reject forbidden CTLs", () => {
  it.each(["\u0001", "\u000b", "\u001f", "\u007f"])(
    "rejects protocol-forbidden control byte %j",
    (value) => {
      // RFC field-content permits HTAB, SP, visible bytes and obs-text, but
      // not other C0 controls or DEL. Expected: write-site TypeError, matching
      // node:http validation. Actual: only CR/LF/NUL are rejected.
      // Root cause: src/utils/text.ts:69-82.
      expect(() => validateHeaderValue("x-protocol", value)).toThrow(TypeError);
    },
  );
});
