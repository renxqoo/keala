/* eslint-disable max-lines -- one audit file per the r6 mandate (9 findings + 36 locks documented in full) */
/**
 * RED-TEAM ROUND 6 (r6) — ADVERSARIAL RE-REVIEW OF THE r5 FIXES + FULL-REPO
 * ReDoS/REGEX AUDIT + SERVICE-TIME MUTABLE-STATE RACE AUDIT.
 *
 * Scope: everything `git show a263794` touched (response flags 32/64/128,
 * neutralizeForeignAuthority, router layers, trie root wildcard, cache
 * state-mode materialization, accepts params/tie-break, sugar in-place clear,
 * pool sweep/retireWithBody, observedStream, validator, cors/mount merge),
 * every RegExp literal under src/, and the async-shared-state surfaces
 * (cache store, late use/param/decorate/ws/sink, emitter, rootCache).
 *
 * CONFIRMED BUGS (each `it()` below asserts the CORRECT behavior and is RED
 * against current src/):
 *
 *  [R6-1] HIGH RUNTIME  src/middleware/cache.ts:175 — the state-mode
 *         materialization `c._res ?? (await finalize(c.app, c))` runs the
 *         FULL finalizer, and for a ReadableStream body with the opt-in
 *         `onStreamError` hook `fromState` wraps the stream in
 *         `observedStream`, whose first act is `body.getReader()` — LOCKING
 *         the developer's stream. The materialized Response is then thrown
 *         away, and when the REAL finalizer re-runs `fromState` its second
 *         `getReader()` throws `TypeError: ReadableStream is locked`, which
 *         finalizeGuarded converts into a plain 500. Seeds: `c.body =
 *         someStream` (or `c.body = new Response(stream)`, whose body setter
 *         unwraps to `value.body`) on a route wrapped in cache() with
 *         `new Keala({ onStreamError })`. Without onStreamError the same
 *         route streams fine (locked below), so the regression is exactly
 *         the r5 materialization interacting with the stream observer.
 *         Fix direction: bail out (before materializing) whenever
 *         `c._res === undefined && !isTextualStateBody(c.bodyValue)`, or
 *         materialize without the onStreamError wrap (pass a flag that the
 *         finalizer must not mutate stream state on its throwaway run).
 *
 *  [R6-2] MED  SEMANTIC  src/core/context/response.ts:163-183 + respond.ts
 *         :126-127 — a POST-commit `c.body = null` sets `statusValue = 204`
 *         through a DIRECT slot write (no flag 32), so the rule-4 rebuild
 *         keeps the committed status: a committed 200 becomes "200 with an
 *         empty body" while koa (and the setter's own state machine, which
 *         believes 204) mandate the implicit 204. The post-commit body write
 *         is honored (flag 128) but its implicit status write is not — the
 *         context's staged status and the shipped status disagree.
 *         Fix direction: the implicit-204 write must go through the
 *         commit-aware status setter (or set flags 16|32 alongside 128).
 *
 *  [R6-3] MED  SEMANTIC  src/core/context/response.ts:346 — redirect() gates
 *         the 302 coercion on the STALE `this.statusValue` instead of the
 *         commit-aware `this.status` getter. A committed 301/308 Location
 *         rewritten by a post-commit `c.redirect()` is silently downgraded
 *         to 302 (308→302 even changes POST-retry semantics), although
 *         `c.status` itself reports 301 and koa keeps an existing redirect
 *         status. The r5 commit message says redirect "routes through the
 *         commit-aware setter" — the read side is still pre-commit-blind.
 *         Fix direction: gate on `isRedirectStatus(this.status)`.
 *
 *  [R6-4] MED  SEMANTIC/SEC  src/negotiation/accepts.ts:147 —
 *         `pickPreference` filters `q > 0` BEFORE the specificity scan, so
 *         an explicit `name;q=0` refusal is deleted from the comparison and
 *         a positive wildcard `*` happily matches the same value. RFC 7231
 *         §5.3.1 ("specific media ranges... override the * wildcard") and
 *         real negotiator 0.6.3 (koa 3.2.1's engine) both keep the q=0
 *         entry: its SPECIFICITY defines the value's quality, which is 0 →
 *         not acceptable. Affects all four negotiators:
 *           Accept:              text/html;q=0,* / * | html  → koa:false, ours:html
 *           Accept-Language:     en;q=0,*            | en    → koa:false, ours:en
 *           Accept-Charset:      utf-8;q=0,*         | utf-8 → koa:false, ours:utf-8
 *           Accept-Encoding:     identity;q=0,*      | ident → koa:false, ours:identity
 *         A client that explicitly refuses a format receives it anyway.
 *         Fix direction: run the specificity scan over the UNFILTERED entry
 *         list, take the winning range's q as the value's quality, and only
 *         then drop values whose quality is 0.
 *
 *  [R6-5] MED  SEMANTIC  src/negotiation/accepts.ts:146,199 — for ENCODINGS,
 *         an absent/empty Accept-Encoding means "identity only" (RFC 7231
 *         §5.3.4; negotiator returns "identity" when provided and false
 *         otherwise). `pickPreference` returns `provided[0]` — the server's
 *         first choice — so `c.acceptsEncodings(["gzip","identity","deflate"])`
 *         answers "gzip" and `c.acceptsEncodings(["br","gzip"])` answers "br"
 *         for a client that never advertised any coding: an app may then ship
 *         br/gzip bodies to a client that cannot decode them. The
 *         identity-refusal fallback (`isIdentityRefused`) exists but is only
 *         consulted when the wildcard match fails, never on the no-header
 *         path. Fix direction: in acceptsEncoding, when the header is absent
 *         or empty, return provided.includes("identity") ? "identity" : false.
 *
 *  [R6-6] HIGH DoS  src/plugins/body-parser.ts:68-87 (`countOccurrences`) —
 *         the multipart part-budget scan is a naive substring search:
 *         first-char filter + byte-by-byte needle compare. The needle is
 *         always "--"+boundary (≤1024+2 chars, fully attacker-chosen via the
 *         boundary parameter), so a body of "-"×N with boundary "-"×1021+"C"
 *         forces ~1024 byte compares at EVERY position: measured 1612ms of
 *         SYNCHRONOUS CPU for a 1MB body, 6.5s for 4MB — and the default
 *         formLimit is 10MB (~16s per request), all on the single JS thread.
 *         A benign 4MB body scans in 46ms (locked below). One crafted
 *         request per second freezes the server.
 *         Fix direction: a linear-time search — decode to a string once and
 *         use native indexOf in a loop (memmem-class), or cap the needle to
 *         the RFC-2046 70-char boundary grammar instead of 1024.
 *
 *  [R6-7] LOW  RUNTIME  src/core/context/pool.ts:62 — deadContextProto
 *         chains to the SHARED baseContextProto, not the app's derived
 *         contextProto, so every `app.decorate()` member vanishes from a
 *         retired (pooled) context: `holder.userTag` reads `undefined`
 *         after the body settles although the module documents "reads chain
 *         to the live prototype (post-request telemetry keeps working on
 *         stale-but-visible data)". Base-API reads (c.status, c.state) do
 *         keep working; only decorations are lost. (Not introduced by r5 —
 *         but r5's retireWithBody made retirement far more common, and the
 *         in-place read-through contract is the module's own.)
 *         Fix direction: build the dead prototype per app (chained to the
 *         app's contextProto) inside createPool.
 *
 *  [R6-9] MED  SEMANTIC  src/router/router.ts:138-141 + src/router/trie.ts
 *         :270-319 — an OPTIONAL pattern whose consume-terminal coincides
 *         with a REQUIRED pattern's terminal at the same position
 *         (`app.get("/x/:a", h1)` then `app.get("/x/:a?", h2)`) REUSES the
 *         required pattern's RouteTarget (`terminals[0].target ??
 *         createTarget()`), so the layers of BOTH patterns accumulate on
 *         ONE target — and the skip terminal (matched by `/x`, which the
 *         required pattern cannot match) dispatches into that shared chain:
 *         `h1` RUNS for `GET /x` with `c.params("a") === undefined`. Real
 *         hono (verified live): `/x` runs only the optional route; express
 *         path-to-regexp: `/x/:a` never matches `/x`. A required-param
 *         handler executing without its param is a per-request NPE factory.
 *         Seed: register `/x/:a` and `/x/:a?` for the same method, in
 *         either order, then request `/x`.
 *         Fix direction: a pattern's layers must belong to the target of a
 *         terminal that pattern itself OWNS — e.g. key the terminal->target
 *         binding by the full pattern (or give the skip terminals an
 *         optional-pattern-owned target), instead of inheriting whatever
 *         target terminals[0] already carries.
 *
 *  [R6-8] LOW  SEMANTIC  src/middleware/cache.ts:159,188 — `now` is captured
 *         BEFORE `await next()`, so `expires = requestStart + ttl`: a handler
 *         slower than the ttl stores an entry that is born EXPIRED (a 150ms
 *         handler under ttl:60 never produces a hit). TTL should run from
 *         response production (after next()), the moment the cached
 *         representation actually exists. Fix direction: `store.set(key, {
 *         expires: Date.now() + ttl, ... })`.
 *
 * The remaining describes are GREEN "locks correct behavior" tests for
 * suspicions that were investigated and are SAFE (see the report): the r5
 * redirect neutralization corpus, trie root-wildcard priority matrix, router
 * layer/rebuild semantics, cache concurrency, emitter/sink/rootCache races,
 * and the linear-time proofs for every RegExp under src/.
 */
import { describe, expect, it } from "vitest";
import Negotiator from "negotiator";
import { Keala, type Application } from "../../src/index.ts";
import { cache } from "../../src/middleware/cache.ts";
import {
  acceptsCharset,
  acceptsEncoding,
  acceptsLanguage,
  acceptsType,
} from "../../src/negotiation/accepts.ts";

const quiet = { env: "test" } as const;
const drive = (app: Application, req: Request) => app.handle(req);
const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// R6-1  cache() × onStreamError: materialization locks the developer's stream
// ---------------------------------------------------------------------------

describe("R6-A cache(): r5 state-mode materialization vs the stream observer [RED]", () => {
  const streamOf = (chunks: string[]) =>
    new ReadableStream({
      async start(ctrl) {
        for (const chunk of chunks) ctrl.enqueue(encoder.encode(chunk));
        ctrl.close();
      },
    });

  it("stream body + onStreamError + cache() must stream, not 500 (R6-1)", async () => {
    const seen: string[] = [];
    const app = new Keala({ ...quiet, onStreamError: (e) => seen.push(e.message) });
    app.get("/s", cache(), () => new Response(streamOf(["hello"])));
    const res = await drive(app, new Request("http://good.com/s"));
    // Correct: the cache must simply decline to store a stream body while the
    // response streams untouched. Actual: the throwaway finalize() locked the
    // stream, the real finalizer threw, and app.handle answered a plain 500.
    expect(seen).toEqual([]);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
  });

  // 0.7: the R6-1b variant (`c.body = new Response(stream)`) is gone with
  // the c.body-Response quirk — return the Response instead; the surviving
  // locks above and below cover the stream/cache interaction.

  it("locks: the same route streams fine without the onStreamError hook", async () => {
    const app = new Keala(quiet);
    app.get("/s", cache(), () => new Response(streamOf(["hello"])));
    const res = await drive(app, new Request("http://good.com/s"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
  });

  it("locks: sugar TEXTUAL bodies are stored and replayed (the r5 goal)", async () => {
    let n = 0;
    const app = new Keala(quiet);
    app.get("/t", cache({ ttl: 60_000 }), (c) => {
      n += 1;
      return c.text(`v${n}`);
    });
    const first = await drive(app, new Request("http://good.com/t"));
    expect(await first.text()).toBe("v1");
    const second = await drive(app, new Request("http://good.com/t"));
    expect(second.headers.get("x-cache")).toBe("hit");
    expect(await second.text()).toBe("v1");
  });
});
describe("R6-B cache(): ttl window [RED]", () => {
  it("an entry must live ttl from RESPONSE time, not request start (R6-8)", async () => {
    const app = new Keala(quiet);
    let n = 0;
    app.get("/slow", cache({ ttl: 120 }), async (c) => {
      n += 1;
      await new Promise((r) => setTimeout(r, 260));
      return c.text(`n${n}`);
    });
    const first = await drive(app, new Request("http://good.com/slow"));
    expect(await first.text()).toBe("n1");
    // The representation was produced at t≈260ms; ttl 120ms must start THERE.
    const second = await drive(app, new Request("http://good.com/slow"));
    expect(second.headers.get("x-cache")).toBe("hit");
    expect(await second.text()).toBe("n1");
  });
});
describe("R6-C post-commit contract (0.7): new Responses win", () => {
  // 0.7 rewrote the flags 32/64/128 rebuild machinery into the commit
  // contract; U3c removed the write paths entirely (c.body/c.status are
  // gone, c.redirect is a pure builder): middleware replaces a committed
  // response by RETURNING a new one.
  //
  // U3c deletions (mapping #6): "post-commit c.body writes throw TypeError"
  // (was R6-2 / flag 128) and "post-commit c.status overrides throw
  // TypeError" (was flag 32) locked the deleted setters' post-commit guard —
  // the write surface no longer exists; the committed-answer-survives
  // invariant is locked by the pure-builder test below.

  it("post-commit c.redirect is a pure builder (U3a): returned only when returned", async () => {
    // Was R6-3 (the staged form threw on commit). The U3a return-form never
    // mutates context: calling it after a commit is harmless, and the
    // committed answer survives unless the caller actually RETURNS the new
    // Response (last-committer-wins below locks that half).
    const app = new Keala(quiet);
    let built: Response | undefined;
    app.get(
      "/x",
      async (c, next) => {
        await next();
        built = c.redirect("/elsewhere"); // built but NOT returned
      },
      () => new Response(null, { status: 301, headers: { location: "/first" } }),
    );
    const res = await drive(app, new Request("http://good.com/x"));
    expect(built).toBeInstanceOf(Response);
    expect(built?.status).toBe(302);
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/first"); // the commit survives
  });

  it("a returned c.redirect replaces the committed answer (last committer wins)", async () => {
    const app = new Keala(quiet);
    app.get(
      "/x",
      async (c, next) => {
        await next();
        return c.redirect("/elsewhere", 308);
      },
      () => new Response(null, { status: 301, headers: { location: "/first" } }),
    );
    const res = await drive(app, new Request("http://good.com/x"));
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("/elsewhere");
  });

  it("a middleware may replace the committed response by returning a new one", async () => {
    const app = new Keala(quiet);
    app.get(
      "/x",
      async (c, next) => {
        await next();
        // Commit-aware read, then the supported replacement pattern.
        return new Response(null, { status: 304, headers: { etag: c.resHeader("ETag") } });
      },
      (c) => {
        c.setHeader("ETag", '"v1"');
        return c.text("body");
      },
    );
    const res = await drive(app, new Request("http://good.com/x"));
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe('"v1"');
    expect(res.headers.get("content-type")).toBe(null);
    expect(res.headers.get("content-length")).toBe(null);
  });
});
describe("R6-D redirect neutralization: hostile corpus [locks]", () => {
  const HOSTILE = [
    "//evil.com",
    "///evil.com",
    "/\\evil.com",
    "\\\\evil.com",
    "https:/evil.com",
    "HTTPS:/evil.com",
    "https:\\\\evil.com",
    " //evil.com",
    "\t//evil.com",
    "//good.com@evil.com/",
    "https:evil.com",
    "/\t//evil.com",
    "//evil.com/",
    "http:/\\evil.com",
    "//user:pass@good.com@evil.com",
  ];

  it("every relative-looking foreign target stays a same-origin path", async () => {
    const app = new Keala(quiet);
    HOSTILE.forEach((target, i) => {
      app.get(`/r${i}`, (c) => c.redirect(target));
    });
    for (let i = 0; i < HOSTILE.length; i++) {
      const res = await drive(app, new Request(`http://good.com/r${i}`));
      const location = res.headers.get("location") ?? "";
      const resolved = new URL(location, "http://good.com/");
      // The whole point of neutralizeForeignAuthority + the encodeUrlValue
      // backslash/control/space backstop: no client may land on a foreign
      // authority from a relative-looking redirect target.
      expect(resolved.host).toBe("good.com");
      expect(resolved.protocol).toBe("http:");
    }
  });

  it("locks: an explicit scheme:// target is the developer's absolute redirect", async () => {
    const app = new Keala(quiet);
    app.get("/abs", (c) => c.redirect("https:////example.org/x/./y"));
    const res = await drive(app, new Request("http://good.com/abs"));
    // Matches ^https?:\/\// → normalized through new URL — deliberate, same
    // as c.redirect("https://example.org/..."). Not an open-redirect vector:
    // the absolute target is app-chosen, not attacker input.
    expect(res.headers.get("location")).toBe("https://example.org/x/y");
  });

  it("locks: same-origin //host targets pass through untouched", async () => {
    const app = new Keala(quiet);
    app.get("/same", (c) => c.redirect("//good.com:8080/back"));
    const res = await drive(app, new Request("http://good.com:8080/same"));
    expect(res.headers.get("location")).toBe("//good.com:8080/back");
  });
});
describe("R6-E negotiation: explicit refusals vs wildcards [RED + locks]", () => {
  it("Accept: text/html;q=0,*/* must NOT serve html (R6-4)", () => {
    const ours = acceptsType("text/html;q=0,*/*", ["html"]);
    const koa = new Negotiator({ headers: { accept: "text/html;q=0,*/*" } }).mediaType([
      "text/html",
    ]);
    expect(koa).toBeUndefined(); // koa: explicitly refused
    expect(ours).toBe(false);
  });

  it("Accept: text/html;q=0,*/* picks the other provided type (R6-4b)", () => {
    expect(acceptsType("text/html;q=0,*/*", ["html", "json"])).toBe("json");
  });

  it("Accept-Language: en;q=0,* must NOT answer en (R6-4c)", () => {
    expect(acceptsLanguage("en;q=0,*", ["en"])).toBe(false);
    expect(acceptsLanguage("en;q=0,*", ["en", "fr"])).toBe("fr");
  });

  it("Accept-Charset: utf-8;q=0,* must NOT answer utf-8 (R6-4d)", () => {
    expect(acceptsCharset("utf-8;q=0,*", ["utf-8"])).toBe(false);
  });

  it("Accept-Encoding: identity;q=0,* must NOT answer identity (R6-4e)", () => {
    expect(acceptsEncoding("identity;q=0,*", ["identity"])).toBe(false);
    expect(acceptsEncoding("identity;q=0.000, *;q=1", ["identity", "gzip"])).toBe("gzip");
  });

  it("absent Accept-Encoding means identity-only (R6-5)", async () => {
    // App-level (the real-world path): a request with NO Accept-Encoding…
    const app = new Keala(quiet);
    let answered: unknown = "unset";
    app.get("/e", (c) => {
      answered = c.acceptsEncodings(["gzip", "identity", "deflate"]);
      return c.text("x");
    });
    await drive(app, new Request("http://good.com/e"));
    expect(answered).toBe("identity");
    // …and the direct-function forms c.acceptsEncodings forwards (null when
    // absent, "" when the client sent an empty value): both mean "identity
    // only" (RFC 7231 §5.3.4; negotiator answers identity when provided and
    // undefined otherwise). Ours answers provided[0] — "gzip" below, i.e. an
    // app believes an encoding-neutral client asked for gzip.
    expect(acceptsEncoding(null, ["br", "gzip"])).toBe(false);
    expect(acceptsEncoding("", ["gzip", "identity"])).toBe("identity");
  });

  it("locks: negotiator differential battery (media/language/charset) still matches", () => {
    const mediaHeaders = [
      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "application/json, text/javascript, */*; q=0.01",
      "text/html;q=0.9, application/json;q=0.9",
      "*/*",
      "text/*, text/plain, text/plain;level=1",
      "text/html;level=1;q=0.8",
      "text/plain;format=flowed, text/plain",
      "application/json;q=0.9, text/html",
      "XML;q=0.9, application/json;q=1",
      "text/html ; q=0.5 , application/json;q=0.7",
    ];
    const mediaProvided = [
      ["text/html", "application/json"],
      ["application/json", "text/html"],
      ["text/plain"],
      ["application/xml"],
    ];
    for (const header of mediaHeaders) {
      for (const provided of mediaProvided) {
        const koa = new Negotiator({ headers: { accept: header } }).mediaType(provided);
        const ours = acceptsType(header, provided);
        expect(`${header} | ${provided.join(",")}: ours=${String(ours)}`).toBe(
          `${header} | ${provided.join(",")}: ours=${koa === undefined ? "false" : koa}`,
        );
      }
    }
    const langCases: Array<[string, string[]]> = [
      ["en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7", ["en", "zh"]],
      ["en;q=0.5, fr;q=0.5, de", ["en-US", "fr", "de"]],
      ["da, en-gb;q=0.8, en;q=0.7", ["en-GB", "en"]],
      ["zh, en-us;q=0.8, en;q=0.7", ["en", "zh"]],
    ];
    for (const [header, provided] of langCases) {
      const koa = new Negotiator({ headers: { "accept-language": header } }).language(provided);
      const ours = acceptsLanguage(header, provided);
      expect(`lang ${header}: ours=${String(ours)}`).toBe(
        `lang ${header}: ours=${koa === undefined ? "false" : koa}`,
      );
    }
    const csCases: Array<[string, string[]]> = [
      ["iso-8859-5, unicode-1-1;q=0.8", ["utf-8", "iso-8859-1"]],
      ["utf-8, iso-8859-1;q=0.5", ["utf-8"]],
      ["*", ["utf-8", "iso-8859-5"]],
    ];
    for (const [header, provided] of csCases) {
      const koa = new Negotiator({ headers: { "accept-charset": header } }).charset(provided);
      const ours = acceptsCharset(header, provided);
      expect(`charset ${header}: ours=${String(ours)}`).toBe(
        `charset ${header}: ours=${koa === undefined ? "false" : koa}`,
      );
    }
  });
});
