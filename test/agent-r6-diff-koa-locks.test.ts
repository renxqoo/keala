/**
 * r6 differential audit — LOCKS half: intentional divergences (documented
 * koa forks, each locked by an existing repo test or a security contract)
 * and seeded-fuzz parity rows against the real packages. Split of
 * agent-r6-diff-koa for the 500-line repo budget.
 */

import { describe, expect, it } from "vitest";

import acceptsPkg from "accepts";
import CookiesPkg from "cookies";
import encodeurl from "encodeurl";
import escapeHtmlPkg from "escape-html";
import { Router as RouterOf } from "@koa/router";

import { Eleu, Router } from "../src/index.ts";
import { typeIs } from "../src/negotiation/typeis.ts";
import {
  acceptsType as acceptsTypeOf,
  acceptsEncoding as acceptsEncodingOf,
  acceptsLanguage as acceptsLanguageOf,
} from "../src/negotiation/accepts.ts";
import { parseCookies } from "../src/context/cookies.ts";
import { contentDisposition as contentDispositionOf } from "../src/utils/text.ts";
import { encodeUrlValue as encodeUrlOf } from "../src/utils/url.ts";
import { escapeHtml } from "../src/helpers/html.ts";

/** Deterministic PRNG (mulberry32) for the fuzz corpora below. */
const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const driveBun = async (
  setup: (app: InstanceType<typeof Eleu>) => void,
  reqInit: { url?: string; method?: string; headers?: Record<string, string> },
): Promise<{ status: number; headers: Record<string, unknown>; body: string }> => {
  const app = new Eleu({ env: "test" } as const);
  setup(app);
  const res = await app.handle(
    new Request(`http://localhost:3000${reqInit.url ?? "/"}`, {
      method: reqInit.method ?? "GET",
      headers: reqInit.headers,
    }),
  );
  const headers: Record<string, unknown> = {};
  for (const k of res.headers.keys()) headers[k] = res.headers.get(k);
  return { status: res.status, headers, body: await res.text() };
};

// --- Seeded fuzz: matched areas (green — regression guards). ---

describe("r6 diff — seeded fuzz (matched areas)", () => {
  const rng = mulberry32(0x6b6f61); // "koa"

  it("escape-html matches the package over generated strings", () => {
    const alphabet = ["&", "<", ">", '"', "'", "a", "é", "中", "\0", "\t", " "];
    for (let i = 0; i < 300; i++) {
      let s = "";
      for (let j = 0, len = 1 + Math.floor(rng() * 12); j < len; j++) {
        s += alphabet[Math.floor(rng() * alphabet.length)];
      }
      expect(escapeHtml(s)).toBe(escapeHtmlPkg(s));
    }
  });

  it("encodeurl matches the package on the safe subset", () => {
    // Only the agreed-safe alphabet: the confirmed escape divergences
    // ('"', "'", '{', '}', bare '%', '\\') are excluded so this row locks
    // the common percent-encoding path (incl. non-ASCII and spaces).
    const alphabet = [
      "a",
      "/",
      "?",
      "#",
      "=",
      "&",
      "+",
      ",",
      ";",
      ":",
      "@",
      "!",
      "$",
      "~",
      "*",
      "(",
      ")",
      "|",
      "^",
      "[",
      "]",
      " ",
      "é",
      "中",
    ];
    for (let i = 0; i < 300; i++) {
      const len = 1 + Math.floor(rng() * 10);
      let s = "";
      for (let j = 0; j < len; j++) s += alphabet[Math.floor(rng() * alphabet.length)];
      const url = `http://x/${s}`;
      expect(encodeUrlOf(url)).toBe(encodeurl(url));
    }
  });

  it("accepts negotiation matches the package over generated headers", () => {
    // Per-kind corpora (valid inputs): the accepts package drops provided
    // values that are not valid for the negotiated dimension (mime.lookup
    // fails for 'en' passed to .type()) — that junk-input divergence is
    // recorded in the r6 report, not asserted here.
    const dims: {
      headerName: string;
      tokens: string[];
      providedSets: string[][];
      bunFn: (h: string, p: string[]) => string | false;
      koaFn: (a: ReturnType<typeof acceptsPkg>, p: string[]) => unknown;
    }[] = [
      {
        headerName: "accept",
        tokens: ["text/html", "application/json", "*/*", "text/*"],
        providedSets: [["html", "json"], ["text/html"], ["application/json"]],
        bunFn: acceptsTypeOf,
        koaFn: (a, p) => a.type(...p),
      },
      {
        headerName: "accept-encoding",
        tokens: ["gzip", "identity", "br", "*"],
        providedSets: [["gzip", "identity"], ["br"], ["identity"]],
        bunFn: acceptsEncodingOf,
        koaFn: (a, p) => a.encodings(...p),
      },
      {
        headerName: "accept-language",
        tokens: ["en", "en-US", "zh", "fr"],
        providedSets: [["en", "en-US"], ["zh"], ["fr", "en"]],
        bunFn: acceptsLanguageOf,
        koaFn: (a, p) => a.languages(...p),
      },
    ];
    const qs = [undefined, "q=0.3", "q=1", "q=0.001"];
    for (const { headerName, tokens, providedSets, bunFn, koaFn } of dims) {
      for (let i = 0; i < 150; i++) {
        const n = 1 + Math.floor(rng() * 3);
        const parts: string[] = [];
        const used = new Set<string>();
        for (let j = 0; j < n; j++) {
          const t = tokens[Math.floor(rng() * tokens.length)] as string;
          if (used.has(t)) continue; // duplicate-value ranges diverge (fixed separately)
          used.add(t);
          const q = qs[Math.floor(rng() * qs.length)];
          parts.push(q === undefined ? t : `${t};${q}`);
        }
        const header = parts.join(", ");
        const provided = providedSets[Math.floor(rng() * providedSets.length)] as string[];
        const koaVal =
          koaFn(acceptsPkg({ headers: { [headerName]: header } } as never), provided) ?? null;
        expect(bunFn(header, provided) ?? null).toBe(koaVal);
      }
    }
  });
});

// --- INTENTIONAL divergences — documented (docs/PARITY.md) or locked by
// existing tests. GREEN on purpose: they record the fork, not a bug. ---

describe("documents intentional divergence", () => {
  it("redirect encodes backslash as %5C (WHATWG treats '\\' as a path separator)", async () => {
    // koa/encodeurl leaves the backslash raw; PARITY.md "redirect
    // encodeurl+escape (backslash encoded)". A bare /\\evil.com Location
    // resolves to //evil.com in WHATWG clients.
    const bun = await driveBun((app) => app.use((c) => c.redirect("/back\\slash")), { url: "/" });
    expect(bun.headers["location"]).toBe("/back%5Cslash"); // koa: '/back\\slash'
  });

  it("redirect neutralizes foreign-authority relative targets", async () => {
    // PARITY.md open-redirect defense: '//evil.com' and 'https:/evil.com'
    // stay same-origin instead of koa's verbatim forwarding.
    const a = await driveBun((app) => app.use((c) => c.redirect("//evil.com")), { url: "/" });
    expect(a.headers["location"]).toBe("/%2Fevil.com"); // koa: '//evil.com'
    const b = await driveBun((app) => app.use((c) => c.redirect("https:/evil.com")), { url: "/" });
    expect(b.headers["location"]).toBe("https%3A%2Fevil.com"); // koa: 'https:/evil.com'
  });

  it("string bodies carry no framework Content-Type (D1: hono/runtime parity)", async () => {
    // koa: 'text/plain; charset=utf-8'. PARITY.md D1 — the runtime provides
    // 'text/plain;charset=UTF-8'; c.type is the explicit escape hatch.
    const bun = await driveBun(
      (app) => {
        app.use((c) => {
          c.body = "hello";
        });
      },
      { url: "/" },
    );
    // undici materializes text/plain at construction; Bun only at send time
    // (the D1 note itself) — both mean "no framework content-type".
    expect(bun.headers["content-type"] ?? null).toBe(
      typeof Bun === "undefined" ? "text/plain;charset=UTF-8" : null,
    );
  });

  it("etag = '' removes the header where koa ships an empty quoted tag", async () => {
    // koa: response.etag = '' -> 'ETag: ""' (the regexp misses the empty
    // string). Locked by test/response.test.ts 'etag removal on empty value'.
    const bun = await driveBun(
      (app) => {
        app.use((c) => {
          c.etag = "";
          c.body = "x";
        });
      },
      { url: "/" },
    );
    expect(bun.headers["etag"]).toBeUndefined(); // koa: '""'
  });

  it("fresh() honors an OWS-padded '*' wildcard where the fresh package does not", async () => {
    // fresh pkg compares reqHeaders['if-none-match'] !== '*' exactly; bun
    // trims OWS first (RFC 9110 field-value semantics). Koa-quirk, not followed.
    const bun = await driveBun(
      (app) => {
        app.use((c) => {
          c.etag = '"a"';
          c.status = 200;
          c.body = `fresh=${c.fresh}`;
        });
      },
      { url: "/", headers: { "if-none-match": " * " } },
    );
    expect(bun.body).toBe("fresh=true"); // koa: fresh=false
  });

  it("ctx.is() ignores body presence (locked by test/request.test.ts)", async () => {
    // type-is returns null for bodyless requests; eleu matches on the
    // Content-Type alone — locked by test/request.test.ts:70.
    const bun = await driveBun(
      (app) => {
        app.use((c) => {
          c.body = String(c.is("json"));
        });
      },
      { url: "/", headers: { "content-type": "application/json" } },
    );
    expect(bun.body).toBe("json"); // koa (no content-length): null
  });

  it("type-is json/xml suffix matching and pattern-return shorthands (locked by test/typeis.test.ts)", () => {
    // koa type-is: false for all four rows below. Locked divergences:
    // 'json' matches application/ld+json, 'xml' matches text/xml, wildcard
    // patterns return the PATTERN (not the incoming type), and 'any' is an
    // invented match-all shorthand.
    expect(typeIs("application/vnd.api+json", ["json"])).toBe("json");
    expect(typeIs("text/xml", ["xml"])).toBe("xml");
    expect(typeIs("image/png", ["image/*"])).toBe("image/*");
    expect(typeIs("image/png", ["any"])).toBe("image/png");
  });

  it("the no-arg language list is lowercased (locked by test/coverage-gaps-4.test.ts)", async () => {
    // negotiator preserves 'fr-CA'; eleu's shared preference parser
    // lowercases values — locked by coverage-gaps-4.test.ts:118.
    const bun = await driveBun(
      (app) => {
        app.use((c) => {
          c.body = JSON.stringify(c.acceptsLanguages());
        });
      },
      { url: "/", headers: { "accept-language": "fr-CH, fr;q=0.9" } },
    );
    expect(bun.body).toBe(JSON.stringify(["fr-ch", "fr"])); // koa: ['fr-CH','fr']
  });

  it("attachment rejects path separators in a string fallback (locked by test/response.test.ts)", () => {
    // content-disposition basenames a '/'-containing fallback; eleu throws
    // — locked by response.test.ts 'attachment rejects path separators in fallback'.
    expect(() => contentDispositionOf("报表.bin", "a/b")).toThrow(TypeError);
  });

  it("cookie parsing decodes percent-escapes where cookies@0.9.1 does not (documented symmetric codec)", () => {
    // koa 3.2.1 links cookies ~0.9.1 whose get() regex returns the RAW value
    // ('%2F'), requires 'name=' with no inner whitespace, ignores bare
    // tokens, and resolves duplicate names FIRST-wins. eleu's symmetric
    // codec (percent-encode on set / decode on parse) is documented in
    // PARITY.md and locked by test/cookies.test.ts:23; its last-wins
    // duplicate resolution follows RFC 6265 §5.3 / browser behavior (the
    // cookies regex is the outlier).
    expect(parseCookies("e=%2F")).toEqual({ e: "/" }); // koa: '%2F'
    expect(parseCookies("name")).toEqual({ name: "" }); // koa: undefined
    expect(parseCookies(" spaced = v ")).toEqual({ spaced: "v" }); // koa: undefined
    expect(parseCookies("a=b; a=c")).toEqual({ a: "c" }); // koa: 'b' (first match)
    // The agreed core (exact pairs, quoted values) matches:
    const cookies = new CookiesPkg(
      { headers: { cookie: 'a=b; q="quoted"' } } as never,
      { getHeader: () => undefined, setHeader: () => {}, removeHeader: () => {} } as never,
      { keys: ["k"] },
    );
    expect(cookies.get("a", { signed: false })).toBe(parseCookies("a=b")["a"]);
    expect(cookies.get("q", { signed: false })).toBe(parseCookies('q="quoted"')["q"]);
  });

  it("routing matches case-SENSITIVELY (locked by test/router.test.ts; hono-aligned)", async () => {
    // @koa/router 15.7 defaults to case-insensitive (path-to-regexp
    // sensitive:false); eleu deliberately matches hono here — locked by
    // router.test.ts "encoding: ... case-sensitive" ("/case" 404, "/Case"
    // 200). A case-insensitive default would also blind serveStatic against
    // case-sensitive filesystems.
    const bun = await driveBun((app) => app.get("/page", (c) => c.text("page")), { url: "/PAGE" });
    expect(bun.status).toBe(404); // koa: 200
  });

  it("the Allow header uses the fixed ALLOW_ORDER (locked by test/router.test.ts)", async () => {
    // koa-router emits registration order ('POST, HEAD, GET'); eleu's
    // canonical order is deterministic regardless of registration order and
    // is locked by router.test.ts ("HEAD, GET" for a GET route).
    const bun = await driveBun(
      (app) => {
        app.post("/thing", (c) => c.text("p"));
        app.get("/thing", (c) => c.text("g"));
      },
      { url: "/thing", method: "PUT" },
    );
    expect(bun.headers["allow"]).toBe("HEAD, GET, POST"); // koa: 'POST, HEAD, GET'
  });

  it("router.url throws for unknown names where @koa/router returns an Error object", () => {
    // @koa/router 15.7's url() RETURNS new Error(...) instead of throwing —
    // a koa-router quirk not worth replicating.
    const router = new Router();
    router.get("user", "/users/:id", () => {});
    expect(() => router.url("missing", { id: "1" })).toThrow();
  });

  it("@koa/router 15.7 rejects legacy ':param?' / ':param(\\d+)' syntax that eleu supports", () => {
    // path-to-regexp v8 (inside @koa/router 15.7) throws on registration;
    // eleu deliberately keeps the koa-router <=13 syntax as a superset.
    expect(() => new RouterOf().get("/files/:name?", () => {})).toThrow();
    expect(() => new RouterOf().get("/n/:num(\\d+)", () => {})).toThrow();
  });

  // undici's Request constructor rejects forbidden methods (Bun's does not —
  // the premise is undici-specific), so koa-router's 501-for-TRACE path is
  // unreachable in-process for a fetch-based server on Node.
  it.skipIf(typeof Bun !== "undefined")(
    "TRACE/CONNECT cannot even reach the router through the fetch API",
    () => {
      expect(() => new Request("http://localhost:3000/x", { method: "TRACE" })).toThrow();
    },
  );
});
