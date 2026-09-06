import { describe, expect, it } from "vitest";

import { Keala } from "../../src/index.ts";
import type { Context } from "../../src/core/context/context.ts";
import {
  createCookiesFacade as createCookies,
  type CookiesHost,
} from "../../src/plugins/cookies/cookies.ts";
import { acceptsType } from "../../src/negotiation/accepts.ts";
import { typeIs } from "../../src/negotiation/typeis.ts";
import { charsetFromContentType } from "../../src/utils/mime.ts";
import { contentDisposition } from "../../src/utils/text.ts";

/**
 * RED tests (TDD bug hunt) for the request/response context facades.
 *
 * Every test below asserts the CORRECT behavior (koa 3 / its reference
 * packages: cookies, content-disposition, type-is, negotiator, content-type)
 * and FAILS against the current implementation. Each block header names the
 * divergence. These tests must start passing once the underlying defect is
 * fixed; nothing here overlaps the locked semantics asserted elsewhere.
 */

const probe = async (
  init: { url: string; method?: string; headers?: Record<string, string> },
  settings: Record<string, unknown> = {},
): Promise<Context> => {
  let captured: Context | undefined;
  const probing = new Keala({ env: "test", ...settings });
  probing.use(async (c) => {
    captured = c;
    return c.text("probed");
  });
  await probing.handle(new Request(init.url, init));
  if (captured === undefined) throw new Error("probe middleware did not run");
  return captured;
};

const hostWithoutKeys = (
  cookieHeader: string | null = null,
): CookiesHost & {
  jar: Record<string, string | string[]>;
} => {
  const jar: Record<string, string | string[]> = {};
  return {
    jar,
    cookieHeader,
    keys: undefined,
    get responseHeaders() {
      return jar;
    },
  } as CookiesHost & { jar: Record<string, string | string[]> };
};

// ---------------------------------------------------------------------------
// 1. Signed cookies: set() fails OPEN where get() fails CLOSED.
// ---------------------------------------------------------------------------

describe("agent3: signed cookie set() without keys (fail-open)", () => {
  it("CONFIRMED-BUG: set(name, value, { signed: true }) without keys must throw, not ship an unsigned cookie", () => {
    // The `cookies` package throws '.keys required for signed cookies' when a
    // signed SET is requested without configured keys; createCookies.get()
    // already fails closed on the same misconfiguration (signed read without
    // keys throws). The SET path silently writes `sid=secret` with NO
    // signature — an app that believes it is issuing signed session cookies
    // is actually issuing trivially forgeable ones.
    const host = hostWithoutKeys();
    expect(() => createCookies(host).set("sid", "secret", { signed: true })).toThrow(/keys/);
  });

  it("CONFIRMED-BUG: end-to-end — a signed set on a keyless app must not emit a Set-Cookie value", async () => {
    const app = new Keala({ env: "test" });
    app.use(async (c) => {
      c.cookies.set("sid", "secret", { signed: true });
      return c.text("ok");
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    // Today this emits `sid=secret` (unsigned) with a 200 — a signed cookie
    // was requested and an unsigned one was delivered.
    expect(res.headers.getSetCookie().some((entry) => entry.startsWith("sid=secret"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Media type negotiation: `*`-type / concrete-subtype ranges.
// ---------------------------------------------------------------------------

describe("agent3: accepts() star-type ranges", () => {
  it("CONFIRMED-BUG: Accept: */json matches application/json (negotiator semantics)", () => {
    // koa uses negotiator, whose specify() accepts a wildcard TYPE with a
    // concrete SUBTYPE (type '*' passes, subtype must equal): a client
    // sending `Accept: */json` gets JSON from koa.
    expect(acceptsType("*/json", ["application/json"])).toBe("application/json");
  });

  it('CONFIRMED-BUG: ctx.accepts("json") honors an `Accept: */json` client', async () => {
    const ctx = await probe({
      url: "http://localhost:3000/",
      headers: { accept: "*/json" },
    });
    expect(ctx.accepts("json")).toBe("json");
  });
});

// ---------------------------------------------------------------------------
// 3. is(): structured-syntax suffix shorthand (`+json`).
// ---------------------------------------------------------------------------

describe("agent3: is() structured-syntax suffix", () => {
  it('CONFIRMED-BUG: ctx.is("+json") matches application/vnd.api+json (type-is +suffix expando)', async () => {
    // type-is expands `+json` to `*/*+json` and matches any
    // `<type>/<subtype>+json`; koa's ctx.is('+json') returns the incoming
    // media type. The facade returns false, so body-parser style gates
    // reject vendor JSON payloads they should accept.
    const ctx = await probe({
      url: "http://localhost:3000/",
      method: "POST",
      headers: { "content-type": "application/vnd.api+json" },
    });
    expect(ctx.is("+json")).toBe("application/vnd.api+json");
  });

  it("CONFIRMED-BUG: typeIs matches +xml suffix against application/atom+xml", () => {
    expect(typeIs("application/atom+xml", ["+xml"])).toBe("application/atom+xml");
  });
});

// ---------------------------------------------------------------------------
// 4. Response headers: append() bypasses the singleton Content-Type guard.
// ---------------------------------------------------------------------------

describe("agent3: append() singleton header corruption", () => {
  it("CONFIRMED-BUG: appending Content-Type twice must be refused like set() (koa #1899 rule)", async () => {
    // set() throws 'Content-Type is a singleton header and cannot be set to
    // an array' — the same rule must hold for append(), which today builds
    // an array value that flattenHeaders emits as two pairs which the
    // runtime comma-joins into an invalid Content-Type on the wire.
    const app = new Keala({ env: "test" });
    let secondAppendThrew = false;
    app.use(async (c) => {
      c.append("Content-Type", "text/html; charset=utf-8");
      try {
        c.append("Content-Type", "application/json");
      } catch {
        secondAppendThrew = true;
      }
      return c.text("x");
    });
    await app.handle(new Request("http://localhost:3000/"));
    expect(secondAppendThrew).toBe(true);
  });

  it("CONFIRMED-BUG: the wire must never carry a comma-joined Content-Type", async () => {
    const app = new Keala({ env: "test" });
    app.use(async (c) => {
      c.append("Content-Type", "text/html; charset=utf-8");
      // The duplicate append throws (same singleton rule as set()); the
      // FIRST value must survive as the wire Content-Type.
      try {
        c.append("Content-Type", "application/json");
      } catch {
        // expected — see the sibling test above
      }
      return c.text("x");
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    // Today: "text/html; charset=utf-8, application/json" — an invalid
    // singleton header, the exact failure the set() guard documents.
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });
});

// ---------------------------------------------------------------------------
// 5. ctx.charset: RFC 9110 parameter grammar (OWS and quoted values).
// ---------------------------------------------------------------------------

describe("agent3: charset parameter parsing", () => {
  it("CONFIRMED-BUG: OWS around '=' is parsed (text/html; charset = utf-8)", async () => {
    // RFC 9110 allows optional whitespace around the '=' of a parameter;
    // koa (content-type package) returns 'utf-8' for this header.
    // (0.7: the ctx.charset accessor is gone — the shared helper is the API.)
    expect(charsetFromContentType("text/html; charset = utf-8")).toBe("utf-8");
    await probe({
      url: "http://localhost:3000/",
      headers: { "content-type": "text/html; charset = utf-8" },
    });
  });

  it("CONFIRMED-BUG: charset must not be read out of an unrelated quoted parameter value", () => {
    // 'charset=utf-7' here is the VALUE of parameter x, not a charset
    // parameter; koa's content-type parse yields no charset ('').
    expect(charsetFromContentType('text/html; x="charset=utf-7"; charset=utf-8')).toBe("utf-8");
    expect(charsetFromContentType('text/html; x="charset=utf-7"')).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 6. attachment()/contentDisposition: fallback: false on ASCII filenames.
// ---------------------------------------------------------------------------

describe("agent3: contentDisposition fallback=false", () => {
  it("CONFIRMED-BUG: fallback: false keeps filename= for ASCII names (content-disposition package)", () => {
    // koa's content-disposition('a.txt', { fallback: false }) emits
    // 'attachment; filename="a.txt"' — fallback:false only suppresses the
    // generated latin-1 fallback NAME, never the plain parameter for a
    // filename that is already ASCII. Dropping filename= leaves legacy
    // clients (which ignore filename*) with no filename at all.
    expect(contentDisposition("a.txt", false)).toBe('attachment; filename="a.txt"');
  });
});
