/**
 * RED-TEAM ROUND 5 — SECURITY AUDIT, FILE A (assertion-red tests).
 *
 * Scope: src/middleware/{cors,csrf-token,auth,cache,serve-static,headers}.ts,
 * src/context/cookies.ts, src/helpers/{html,streams}.ts,
 * src/core/context/response.ts (redirect/back), src/core/sink.ts.
 *
 * CONFIRMED BUGS (each `it()` below asserts the CORRECT behavior and is RED
 * against current src/):
 *
 *  [R5-1] MED  SECURITY  src/middleware/cache.ts:37 — `NO_REVALIDATE` lacks
 *         the `i` flag its two sibling regexes carry, so a response whose
 *         handler opted out of caching with ANY non-lowercase spelling
 *         (`Private`, `NO-STORE`, `No-Cache`, …) is STILL stored and replayed
 *         to other users. RFC 9111 §5.2 directives are case-insensitive.
 *         Exploit: a handler that personalizes (e.g. by IP — not part of the
 *         cache key, not part of the eligibility gate) while emitting
 *         `Cache-Control: NO-STORE` has its private answer replayed to every
 *         other visitor of the URL.
 *  [R5-2] MED  SECURITY  src/middleware/cache.ts:74-80 — the cache key is the
 *         UNDELIMITED concatenation `${method}:${host}${path}`. With
 *         `proxy: true` the host comes from X-Forwarded-Host, which may
 *         contain "/" (nginx does not strip it by default). A request to
 *         `/y` with `X-Forwarded-Host: <site>/x` seeds the entry
 *         `GET:<site>/x/y` — the exact key of a DIFFERENT path — so the
 *         attacker chooses which route's entry their response poisons
 *         (cross-path cache poisoning against a shared cache() instance).
 *  [R5-3] MED  SEMANTIC  src/middleware/cache.ts:141-142 — `c._res` is only
 *         set when a handler RETURNS a Response; state-mode handlers
 *         (`c.body = …`, the framework's canonical koa style) commit in the
 *         finalizer which runs AFTER the whole onion. `cache()` therefore
 *         silently never caches state-mode responses: the middleware is a
 *         no-op for the primary response API.
 *  [R5-4] LOW  SECURITY  src/middleware/cors.ts:61-81 — the reject path (403,
 *         default or custom `reject()`, preflight and simple request) returns
 *         WITHOUT `Vary: Origin`, although the response's status/body is
 *         origin-dependent. The module's own invariant ("the response is
 *         origin-dependent and shared caches must key on it, so Vary: Origin
 *         is mandatory on every negotiated answer") is violated exactly on
 *         the answer a shared cache must not mis-key.
 *  [R5-5] MED  SECURITY  src/core/context/response.ts:292-319 —
 *         `c.redirect()` only normalizes `http://`/`https://`-prefixed
 *         targets; scheme-relative (`//evil.com`) and single-slash-scheme
 *         (`https:/evil.com`) targets ship verbatim in Location, and WHATWG
 *         URL parsing (every browser) resolves both to the ATTACKER's
 *         authority. Round 3 fixed the sibling `/\evil.com` (PIPE-1) with
 *         the stated threat model "resolves to the authority //evil.com — a
 *         cross-origin open redirect"; the literal `//evil.com` input is the
 *         same attack with one step less.
 *  [R5-6] LOW  SEMANTIC  src/router/router.ts:290-299 (`pathsConflict`, used
 *         by src/core/sink.ts) — a static path whose FIRST path segment
 *         carries an escaped separator (`/a%2Fb`) is not recognized as lying
 *         inside a sunk subtree (`/a/*`): canonicalKey re-escapes the decoded
 *         "/" to `%2F` before the `startsWith(base + "/")` test, so a JS
 *         route can be registered over a native sink without the loud
 *         "would silently shadow it" TypeError — the exact JS/native
 *         divergence the guard exists to prevent.
 *
 * The final describe block ("locks current safe behavior") contains GREEN
 * tests documenting verified-safe suspicions (serveStatic traversal corpus,
 * SSE field injection, cookie tossing, csrfToken binding/TTL caps, csrf()
 * origin-confusion corpus, requestId echo) — they pass today and must keep
 * passing.
 */

import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Keala, type Application } from "../../src/core/app.ts";
import { cache } from "../../src/middleware/cache.ts";
import { cors } from "../../src/middleware/cors.ts";
import { csrf } from "../../src/middleware/cors.ts";
import { requestId } from "../../src/middleware/headers.ts";
import { serveStatic } from "../../src/middleware/serve-static.ts";
import { streamSSE } from "../../src/helpers/streams.ts";
import { csrfToken } from "../../src/middleware/csrf-token.ts";
import { parseCookies, sign, unsign } from "../../src/context/cookies.ts";

const quiet = { env: "test" } as const;
const drive = (app: Application, request: Request) => app.handle(request);
const req = (path: string, init?: RequestInit) => new Request(`http://localhost:3000${path}`, init);

// ---------------------------------------------------------------------------
// [R5-1] responseCache stores responses whose Cache-Control opt-out is not
//        spelled lowercase (RFC 9111 §5.2: directives are case-insensitive)
// ---------------------------------------------------------------------------
describe("R5-1 security: cache() must honor no-cache/no-store/private in ANY case", () => {
  it.each(["Private", "NO-STORE", "No-Cache", "no-STORE"])(
    "Cache-Control %q on the response must prevent storage",
    async (control) => {
      let computed = 0;
      const app = new Keala(quiet);
      app.get("/p", cache({ ttl: 60_000 }), (c) => {
        computed += 1;
        c.setHeader("Cache-Control", control); // handler opts out of caching
        return c.text(`private-${computed}`);
      });
      await drive(app, req("/p")); // miss — computes and (wrongly) stores
      const second = await drive(app, req("/p"));
      // Expected: the opt-out is honored, every request computes fresh.
      expect(second.headers.get("x-cache")).toBeNull(); // actual: "hit"
      expect(computed).toBe(2); // actual: 1
      expect(await second.text()).toBe("private-2"); // actual: "private-1"
    },
  );

  it("contrast (green): the lowercase spellings are honored — proving only the case handling diverges", async () => {
    let computed = 0;
    const app = new Keala(quiet);
    app.get("/p", cache({ ttl: 60_000 }), (c) => {
      computed += 1;
      c.setHeader("Cache-Control", "private");
      return c.text(`v${computed}`);
    });
    await drive(app, req("/p"));
    const second = await drive(app, req("/p"));
    expect(second.headers.get("x-cache")).toBeNull();
    expect(computed).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// [R5-2] responseCache key: undelimited host||path concatenation lets a
//        spoofed X-Forwarded-Host poison ANOTHER path's entry (proxy mode)
// ---------------------------------------------------------------------------
describe("R5-2 security: cache() key must not be forgeable via X-Forwarded-Host", () => {
  it("a request to /y with XFH '<site>/x' must not be stored under /x/y's key", async () => {
    const app = new Keala({ ...quiet, proxy: true });
    // ONE shared cache() instance (the documented app.use() shape) — a single
    // store keyed by method+host+path.
    app.use(cache({ ttl: 60_000 }));
    app.get("/y", (c) => c.text("ATTACKER-/y"));
    app.get("/x/y", (c) => c.text("VICTIM-/x/y"));

    // Attacker: spoof X-Forwarded-Host so `${host}${path}` concatenates to
    // "localhost:3000/x/y" — the key of the VICTIM route /x/y — while the
    // attacker's request actually executes the /y handler.
    const attack = await drive(
      app,
      new Request("http://localhost:3000/y", {
        headers: { "x-forwarded-host": "localhost:3000/x" },
      }),
    );
    expect(await attack.text()).toBe("ATTACKER-/y");

    // Victim: an ordinary, unpoisoned request for /x/y must see its own
    // handler's answer (computed fresh), never the attacker's stored body.
    const victim = await drive(app, req("/x/y"));
    expect(victim.headers.get("x-cache")).toBeNull(); // actual: "hit"
    expect(await victim.text()).toBe("VICTIM-/x/y"); // actual: "ATTACKER-/y"
  });
});

// ---------------------------------------------------------------------------
// [R5-3] responseCache never caches state-mode responses (c._res is only set
//        for return-style handlers; the finalizer runs after the onion)
// ---------------------------------------------------------------------------
describe("R5-3 semantic: cache() silently no-ops for state-mode handlers", () => {
  it("a 200 textual state-mode (c.body) response must be cacheable", async () => {
    let computed = 0;
    const app = new Keala(quiet);
    app.get("/s", cache({ ttl: 60_000 }), (c) => {
      computed += 1;
      // The framework's canonical koa-style state API — eligible per the
      // module's own gate (GET, 200, textual, no cookies/vary/set-cookie).
      c.body = `state-${computed}`;
    });
    await drive(app, req("/s"));
    const second = await drive(app, req("/s"));
    expect(second.headers.get("x-cache")).toBe("hit"); // actual: null
    expect(computed).toBe(1); // actual: 2
    expect(await second.text()).toBe("state-1");
  });
});

// ---------------------------------------------------------------------------
// [R5-4] cors(): the reject path omits Vary: Origin on an origin-dependent
//        answer (403 default, custom reject(), preflight and simple request)
// ---------------------------------------------------------------------------
describe("R5-4 security: cors() reject responses must carry Vary: Origin", () => {
  it("simple-request 403 reject (whitelist mode)", async () => {
    const app = new Keala(quiet);
    app.use(cors({ origin: ["https://good.com"] }));
    app.get("/d", (c) => c.text("data"));
    const rejected = await drive(app, req("/d", { headers: { origin: "https://evil.com" } }));
    expect(rejected.status).toBe(403);
    // The 403 exists ONLY because of the Origin header: a shared cache must
    // key this object on Origin or it can be replayed to allowed origins.
    expect(rejected.headers.get("vary") ?? "").toContain("Origin"); // actual: ""
  });

  it("preflight 403 reject (whitelist mode)", async () => {
    const app = new Keala(quiet);
    app.use(cors({ origin: ["https://good.com"] }));
    app.get("/d", (c) => c.text("data"));
    const rejected = await drive(
      app,
      req("/d", {
        method: "OPTIONS",
        headers: { origin: "https://evil.com", "access-control-request-method": "POST" },
      }),
    );
    expect(rejected.status).toBe(403);
    expect(rejected.headers.get("vary") ?? "").toContain("Origin"); // actual: ""
  });

  it("custom reject() responses are equally origin-dependent", async () => {
    const app = new Keala(quiet);
    app.use(
      cors({
        origin: ["https://good.com"],
        reject: (origin) => new Response(`blocked ${origin}`, { status: 403 }),
      }),
    );
    app.get("/d", (c) => c.text("data"));
    const rejected = await drive(app, req("/d", { headers: { origin: "https://evil.com" } }));
    expect(rejected.status).toBe(403);
    expect(rejected.headers.get("vary") ?? "").toContain("Origin"); // actual: ""
  });
});

// ---------------------------------------------------------------------------
// [R5-5] c.redirect() ships scheme-relative / single-slash-scheme targets
//        verbatim — browsers resolve both to the attacker's authority
// ---------------------------------------------------------------------------
describe("R5-5 security: c.redirect() must not emit a cross-origin-resolvable Location", () => {
  // The reflected-redirect pattern round 3 already used for PIPE-1.
  const appOf = (): Application => {
    const app = new Keala(quiet);
    app.get("/r", (c) => {
      return c.redirect(String(c.query("next")));
    });
    return app;
  };

  it.each([
    ["//evil.com", "scheme-relative (protocol-relative) target"],
    ["https:/evil.com", "single-slash absolute-scheme target"],
  ])("%s (%s) must stay same-origin in the Location header", async (next, label) => {
    void label;
    const res = await drive(appOf(), req(`/r?next=${encodeURIComponent(next)}`));
    const location = res.headers.get("location") ?? "";
    // What every browser does with the header value (WHATWG URL semantics).
    const browserHost = new URL(location, "http://good.com:3000/r").host;
    expect(browserHost).toBe("good.com:3000"); // actual: "evil.com"
  });
});

// ---------------------------------------------------------------------------
// [R5-6] sink subtree guard: an escaped separator in a static path defeats
//        pathsConflict — the loud shadowing refusal never fires
// ---------------------------------------------------------------------------
describe("R5-6 semantic: sink guard must catch %-encoded paths inside the sunk subtree", () => {
  it("registering /a%2Fb over a sunk /a/* must throw (native table would shadow it)", () => {
    const dir = mkdtempSync(join(tmpdir(), "r5sink-"));
    try {
      writeFileSync(join(dir, "f.txt"), "sinked");
      const app = new Keala(quiet);
      app.sink("/a/*", { dir });
      // "/a%2Fb" decodes to the in-subtree path "/a/b"; the trie wildcard
      // mirror of the sink matches it, so Bun's native routes table may serve
      // the sink where the JS router would serve this route. The documented
      // contract: later JS registrations under a sunk subtree throw.
      expect(() => app.get("/a%2Fb", (c) => c.text("ROUTE"))).toThrow(/natively-sunk|overlaps/); // actual: registers silently
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// LOCKS CURRENT SAFE BEHAVIOR (green) — suspicions investigated and verified
// NOT exploitable; these tests pin the safe status quo.
// ---------------------------------------------------------------------------
describe("locks current safe behavior", () => {
  describe("serveStatic containment (segment → decode → normalize → containment)", () => {
    it("traversal corpus never escapes root; only in-root files answer 200", async () => {
      const root = mkdtempSync(join(tmpdir(), "r5static-"));
      try {
        writeFileSync(join(root, "ok.txt"), "ok");
        writeFileSync(join(root, "secret.txt"), "secret");
        const app = new Keala(quiet);
        app.get("/assets/*", serveStatic({ root, prefix: "/assets" }));
        const attacks = [
          "/assets/..%2f..%2fsecret.txt",
          "/assets/%2e%2e/secret.txt",
          "/assets/%2e%2e%2fsecret.txt",
          "/assets/%252e%252e/secret.txt", // double-encoded stays a filename
          "/assets/%2F%2Fetc%2Fpasswd", // decoded separator in one segment
          "/assets/sub/..%2f..%2fsecret.txt",
          "/assetsfoo/ok.txt", // prefix boundary: /assetsfoo is not /assets/*
          "/assets//ok.txt", // empty interior segment refused
          "/assets/ok.txt%00", // NUL after decode
          "/assets/%00ok.txt",
        ];
        for (const path of attacks) {
          const res = await drive(app, new Request(`http://localhost:3000${path}`));
          expect([res.status, await res.text()]).not.toEqual([200, "secret"]);
          expect(res.status).not.toBe(200);
        }
        // In-root files (including dot-segments that stay inside) still serve.
        const ok = await drive(app, req("/assets/ok.txt"));
        expect(ok.status).toBe(200);
        expect(await ok.text()).toBe("ok");
        const dot = await drive(app, req("/assets/./ok.txt"));
        expect(dot.status).toBe(200);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("streamSSE field sanitization", () => {
    it("CR/LF in event/id/data/retry/comment can never forge a new field line", async () => {
      const app = new Keala(quiet);
      app.get("/sse", (c) =>
        streamSSE(c, async (sse) => {
          sse.send({ event: "user\r\nevent: forged", id: "1\ndata: forged", data: "d1" });
          sse.send({ data: "line1\n\nevent: forged\ndata: stolen" });
          sse.send({ data: "a\rb", retry: 100 });
          sse.send({ data: { evil: "\n\nid: 9" } }); // JSON escapes newlines
          sse.comment("keep\r\nalive\r\n");
          sse.send({ data: "end" });
        }),
      );
      const text = await (await drive(app, req("/sse"))).text();
      const lines = text.split("\n").map((line) => line.trim());
      // No injected field may ever start a line.
      for (const forged of ["event: forged", "data: forged", "data: stolen", "id: 9"]) {
        expect(lines).not.toContain(forged);
      }
      // The sanitized values survive as single-line field VALUES.
      expect(lines).toContain("event: user  event: forged");
      expect(lines).toContain("id: 1 data: forged");
    });
  });

  describe("cookies: duplicate-name resolution defeats cookie tossing", () => {
    it("the LAST occurrence wins — a tossed cookie (sent first by browsers) cannot shadow", () => {
      // Browsers order cookies longest-path-first, so an attacker's tossed
      // cookie arrives BEFORE the victim's. Taking the last one keeps the
      // victim's value.
      expect(parseCookies("sid=attacker; sid=victim")).toEqual({ sid: "victim" });
    });
    it("unsign() splits on the LAST dot — signed values may contain dots", () => {
      const signed = sign("a.b", "key");
      expect(unsign(sign("a.b", "key"), ["key"])).toBe("a.b");
      expect(signed.startsWith("a.b.")).toBe(true);
      expect(unsign("a.b.not-a-mac", ["key"])).toBe(false);
    });
  });

  describe("csrfToken(): HMAC fallback binding and TTL caps", () => {
    // The t1.<nonce>… format and the cross-service TTL cap are the HMAC
    // fallback's contract; under Bun the native Bun.CSRF branch (covered by
    // middleware-csrf-token.test.ts) has its own token format.
    it.skipIf(typeof Bun !== "undefined")(
      "tokens are session-bound; a foreign session or forged nonce fails",
      () => {
        const svc = csrfToken({ secret: "s3cret", expiresIn: 60_000 });
        const token = svc.issue("session-A");
        expect(svc.verify(token, "session-A")).toBe(true);
        expect(svc.verify(token, "session-B")).toBe(false);
        expect(svc.verify(token)).toBe(false);
        expect(svc.verify(token.replace("t1.", "t1.X"), "session-A")).toBe(false);
        expect(svc.verify("garbage", "session-A")).toBe(false);
      },
    );
    it.skipIf(typeof Bun !== "undefined")(
      "a token outliving THIS service's configured TTL is rejected (deterministic clock)",
      () => {
        const base = Date.now();
        vi.useFakeTimers({ now: base });
        try {
          const mint = csrfToken({ secret: "s3cret", expiresIn: 60_000 });
          const token = mint.issue(); // TTL 60s baked into the token
          const strict = csrfToken({ secret: "s3cret", expiresIn: 5_000 });
          expect(strict.verify(token)).toBe(true); // young enough for both
          vi.setSystemTime(base + 10_000); // 10s: inside token TTL, past strict's
          expect(strict.verify(token)).toBe(false); // policy cap wins
          vi.setSystemTime(base + 61_000); // past the token's own TTL too
          expect(mint.verify(token)).toBe(false);
        } finally {
          vi.useRealTimers();
        }
      },
    );
  });

  describe("csrf(): origin confusion corpus", () => {
    const guarded = (): Application => {
      const app = new Keala(quiet);
      app.use(csrf());
      app.post("/x", (c) => c.text("ok"));
      return app;
    };
    it.each([
      ["https://localhost:3000", "other-scheme origin (http site)"],
      ["http://localhost", "port mismatch"],
      ["http://evil.com", "foreign host"],
    ])("Origin %s (%s) is rejected", async (origin, label) => {
      void label;
      const res = await drive(guarded(), req("/x", { method: "POST", headers: { origin } }));
      expect(res.status).toBe(403);
    });
    it("cross-site Referer fallback is rejected; sandboxed 'null' is rejected", async () => {
      const referer = await drive(
        guarded(),
        req("/x", { method: "POST", headers: { referer: "http://evil.com/x" } }),
      );
      expect(referer.status).toBe(403);
      const nullOrigin = await drive(
        guarded(),
        req("/x", { method: "POST", headers: { origin: "null" } }),
      );
      expect(nullOrigin.status).toBe(403);
    });
    it("genuinely same-origin Origin passes (userinfo/case are normalized by URL)", async () => {
      const res = await drive(
        guarded(),
        req("/x", {
          method: "POST",
          headers: { origin: "http://evil@localhost:3000" },
        }),
      );
      expect(res.status).toBe(200);
    });
  });

  describe("requestId: inbound ids are token-validated before echoing", () => {
    it("a token-valid inbound id is echoed verbatim; anything else is replaced", async () => {
      const app = new Keala(quiet);
      app.use(requestId());
      app.get("/i", (c) => c.text("x"));
      const echoed = await drive(app, req("/i", { headers: { "x-request-id": "abc-123" } }));
      expect(echoed.headers.get("x-request-id")).toBe("abc-123");
      // 129 chars (past the 1-128 cap) and non-token bytes never reach the
      // response header: a fresh UUID is generated instead.
      const tooLong = await drive(app, req("/i", { headers: { "x-request-id": "x".repeat(129) } }));
      expect(tooLong.headers.get("x-request-id")).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      const weird = await drive(app, req("/i", { headers: { "x-request-id": "bad id" } }));
      expect(weird.headers.get("x-request-id")).not.toBe("bad id");
    });
  });
});
