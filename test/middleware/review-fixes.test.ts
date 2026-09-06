/**
 * review-0.6.2 fix locks:
 *  - acceptsGzip fast lanes (lone-token charCode verdict + bounded memo +
 *    the splitHeader comma-free path) are semantically identical to the
 *    parser-backed reference on adversarial headers;
 *  - compress() stages Vary: Accept-Encoding without append's array form
 *    (decline, join, post-commit lanes);
 *  - parseCookies: charCode trimHeaderWs + the tryDecode escape-free early
 *    out (OWS shapes, the U+00A0 name-override lock, escape lanes);
 *  - rateLimit takeSlot is insertion-order eviction with a hard bound even
 *    when every entry is live;
 *  - csrfToken's fallback format gate after the redundant tag re-check was
 *    removed (parts[0] is checked before the destructure).
 */

import { describe, expect, it } from "vitest";

import { Keala } from "../../src/core/app.ts";
import { compress } from "../../src/middleware/etag.ts";
import { rateLimit } from "../../src/middleware/rate-limit.ts";
import { csrfToken } from "../../src/middleware/csrf-token.ts";
import { parseCookies } from "../../src/plugins/cookies/cookies.ts";
import {
  acceptsCharset,
  acceptsGzip,
  acceptsLanguage,
  parsePreferenceEntries,
} from "../../src/negotiation/accepts.ts";

const quiet = { env: "test" } as const;
const req = (path: string, init?: RequestInit) => new Request(`http://localhost:3000${path}`, init);
// The csrfToken fallback lane (the code the DEAD-16 re-check lived in) only
// runs where Bun.CSRF is absent — on Bun every service rides the native
// verify, so these suites gate to the Node lane like middleware-csrf-token.
const REAL_BUN = typeof Bun !== "undefined";

/**
 * The pre-fix algorithm, verbatim: first `gzip` entry's q, else first `*`
 * entry's q, accept iff present and > 0. Every fast-lane verdict must equal
 * it, whatever path decided.
 */
const referenceGzip = (header: string): boolean => {
  let explicit: number | null = null;
  let wildcard: number | null = null;
  for (const pref of parsePreferenceEntries(header)) {
    if (pref.value === "gzip" && explicit === null) explicit = pref.q;
    else if (pref.value === "*" && wildcard === null) wildcard = pref.q;
  }
  const quality = explicit ?? wildcard;
  return quality !== null && quality > 0;
};

describe("acceptsGzip fast lanes: equivalence with the parser reference", () => {
  // Lone tokens, multi-entry browser strings, q weights, wildcard
  // precedence, case, padding, exotic whitespace (JS trim() strips U+00A0 —
  // a charCode scan must defer, not disagree), legacy x-gzip, malformed q.
  const headers = [
    "gzip",
    "GZIP",
    "GZip",
    " gzip ",
    "\tgzip\t",
    "  gzip  ",
    "*",
    " * ",
    "identity",
    "br",
    "deflate",
    "compress",
    "x-gzip",
    "x-gzip, deflate",
    "gzip, deflate",
    "gzip, deflate, br, zstd",
    "deflate, br",
    "deflate, gzip",
    "br, gzip;q=0.001",
    "gzip;q=0",
    "gzip;q=0.000",
    "gzip;Q=0",
    "gzip ; q=0",
    "gzip;q=0, *",
    "*, gzip;q=0",
    "*;q=0.5, gzip;q=0",
    "gzip;q=0.5, *;q=0",
    "gzip;q=bogus",
    "gzip;q=",
    "gzip;q=abc, deflate",
    'a;q=1, "b,c", gzip',
    '"gzip"',
    "gzi",
    "gzipgzip",
    "gz ip",
    "g zip",
    "\u00a0gzip",
    "gzip\u00a0",
    ";gzip",
    ",gzip",
    "gzip,",
    ",,",
    "  ",
    ";",
    "",
  ];

  it.each(headers)("acceptsGzip(%j) === parser reference", (header) => {
    expect(acceptsGzip(header)).toBe(referenceGzip(header));
  });

  // Pin the load-bearing verdicts explicitly so a shared bug in BOTH lanes
  // cannot hide behind the equivalence assertion.
  it.each([
    ["gzip", true],
    [" GZip ", true],
    ["*", true],
    ["gzip, deflate, br, zstd", true],
    ["identity", false],
    ["deflate, br", false],
    ["x-gzip", false],
    ["x-gzip, deflate", false],
    ["gzip;q=0", false],
    ["gzip;q=0, *", false],
    ["*, gzip;q=0", false],
  ])("acceptsGzip(%j) → %j", (header, expected) => {
    expect(acceptsGzip(header)).toBe(expected);
  });

  it("repeated calls agree after memoization (the second call reads the memo)", () => {
    for (const header of headers) {
      const first = acceptsGzip(header);
      for (let i = 0; i < 3; i++) expect(acceptsGzip(header)).toBe(first);
      expect(first).toBe(referenceGzip(header));
    }
  });

  it("splitHeader comma-free fast path: quoted commas still parse as one entry", () => {
    // A quoted comma must NOT split — the lone entry keeps the quoted run.
    expect(parsePreferenceEntries('"b,c"').map((p) => p.value)).toEqual(['"b,c"']);
    expect(parsePreferenceEntries('a, "b,c", gzip;q=0.5').map((p) => p.value)).toEqual([
      "a",
      '"b,c"',
      "gzip",
    ]);
  });
});

describe("compress: Vary staging without append's array form", () => {
  const declineCases: [string, string | null][] = [
    ["lone-token decline", "identity"],
    ["multi-entry decline", "deflate, br"],
    ["no Accept-Encoding header", null],
  ];
  it.each(declineCases)("%s carries a flat Vary: Accept-Encoding", async (_label, ae) => {
    const app = new Keala(quiet);
    app.use(compress());
    app.get("/t", (c) => c.text("tiny-body"));
    const headers: Record<string, string> = ae === null ? {} : { "accept-encoding": ae };
    const res = await app.handle(req("/t", { headers }));
    expect(res.headers.get("vary")).toBe("Accept-Encoding");
  });

  it("identity decline still carries the same Vary (staged post-next)", async () => {
    const app = new Keala(quiet);
    app.use(compress());
    app.get("/t", (c) => {
      return c.text("tiny-body");
    });
    const res = await app.handle(req("/t", { headers: { "accept-encoding": "identity" } }));
    expect(res.headers.get("vary")).toBe("Accept-Encoding");
  });

  it("joins a handler-staged Vary instead of clobbering it", async () => {
    const app = new Keala(quiet);
    app.use(compress());
    app.get("/t", (c) => {
      c.setHeader("Vary", "User-Agent");
      return c.text("tiny-body");
    });
    const res = await app.handle(req("/t", { headers: { "accept-encoding": "identity" } }));
    expect(res.headers.get("vary")).toBe("User-Agent, Accept-Encoding");
  });

  it("accept-path tiny bodies still carry Vary (no compression happened)", async () => {
    const app = new Keala(quiet);
    app.use(compress());
    app.get("/t", (c) => c.text("x"));
    const res = await app.handle(req("/t", { headers: { "accept-encoding": "gzip" } }));
    expect(res.headers.get("vary")).toBe("Accept-Encoding");
    expect(res.headers.get("content-encoding")).toBeNull();
  });
});

describe("parseCookies: charCode trim + decode early-out equivalence", () => {
  it.each([
    ["a=1; b=2", { a: "1", b: "2" }],
    [" a = 1 ;\tb\t=\t2\t", { a: "1", b: "2" }],
    ["a=\t1 ", { a: "1" }],
    ["\r\na\r\n=\r\n1\r\n", { a: "1" }],
    ["a= 1 ; b = 2 ", { a: "1", b: "2" }],
    ["plain=abc-123.xyz", { plain: "abc-123.xyz" }],
    ["enc=%E4%B8%AD", { enc: "中" }],
    ["lit=%252F", { lit: "%2F" }],
    ["dec=%2F", { dec: "/" }],
    // Re-homed from the retired koa differential (U1): a bare token (no '=')
    // parses as a name with an empty value instead of being ignored.
    ["bare", { bare: "" }],
    ["bad=%E4", { bad: "%E4" }],
    ["mixed=%E4%B8%AD%ZZ", { mixed: "%E4%B8%AD%ZZ" }],
    ["empty=; q=v", { empty: "", q: "v" }],
    ['q=" v "', { q: " v " }],
  ])("parseCookies(%j) → %j", (header, expected) => {
    expect(parseCookies(header)).toEqual(expected);
  });

  it("U+00A0 is NOT header whitespace: a padded name stays invalid (override lock)", () => {
    // JS trim() would collapse `\u00a0dummy` onto `dummy` — trimHeaderWs must
    // leave it for name validation to reject.
    expect(parseCookies("\u00a0dummy=evil")).toEqual({});
    expect(parseCookies("dummy\u00a0=evil")).toEqual({});
  });
});

describe("rateLimit takeSlot: insertion-order eviction, hard bound", () => {
  it("evicts oldest-first even when every entry is still live", async () => {
    const store = new Map<string, { count: number; resetAt: number }>();
    const app = new Keala(quiet);
    app.use(
      rateLimit({
        limit: 100,
        windowMs: 3_600_000, // nothing expires during the test
        maxKeys: 5,
        key: (c) => c.header("x-k") ?? "?",
        store,
      }),
    );
    app.get("/x", (c) => c.text("ok"));
    const hit = (k: string) =>
      app.handle(new Request("http://127.0.0.1:3000/x", { headers: { "x-k": k } }));
    for (let i = 0; i < 8; i++) await hit(`k${i}`);
    expect(store.size).toBe(5);
    expect([...store.keys()]).toEqual(["k3", "k4", "k5", "k6", "k7"]);
  });
});

describe.skipIf(REAL_BUN)("csrfToken fallback format gate (redundant tag re-check removed)", () => {
  const service = csrfToken({ secret: "gate-secret" });

  it.each([
    "t2.abc.1700000000000.86400000.AAAA",
    "t1.abc.1700000000000.86400000", // 4 parts
    "t1.abc.1700000000000.86400000.AAAA.extra", // 6 parts
    "t1.abc.17x00000000000.86400000.AAAA", // issuedAt not digits
    "t1.abc.1700000000000.8e4.AAAA", // ttl not digits
    "t1",
    "",
  ])("rejects malformed token %j at the gate", (token) => {
    expect(service.verify(token)).toBe(false);
  });

  it("a same-format forged token with a wrong MAC still fails", () => {
    const issued = Date.now() - 1000;
    const forged = `t1.${"A".repeat(22)}.${issued}.86400000.${"B".repeat(43)}`;
    expect(service.verify(forged)).toBe(false);
  });
});

describe("DEAD-5 close-out: standalone negotiation helpers keep koa semantics", () => {
  // 0.7 contract (docs/KEALA-NATIVE-API.md, commit-0-7-contract.test.ts):
  // c.acceptsCharsets()/c.acceptsLanguages() stay OFF the context; the
  // helpers are the supported surface. Docstrings now say so.
  it("acceptsCharset answers the koa matrix", () => {
    expect(acceptsCharset("utf-8, iso-8859-1;q=0.5", ["utf-8", "iso-8859-1"])).toBe("utf-8");
    expect(acceptsCharset("*, utf-8", ["ascii", "utf-8"])).toBe("utf-8");
    expect(acceptsCharset("utf-8;q=0, *", ["utf-8"])).toBe(false);
  });

  it("acceptsLanguage answers the koa matrix (prefix matching)", () => {
    expect(acceptsLanguage("zh-CN;q=1, en;q=0.5", ["zh", "en"])).toBe("zh");
    expect(acceptsLanguage("en-US,en;q=0.9", ["zh", "en"])).toBe("en");
    expect(acceptsLanguage("fr", ["zh", "en"])).toBe(false);
  });
});
