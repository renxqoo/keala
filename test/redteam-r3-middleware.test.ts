/**
 * Redteam R3 — middleware security audit (RED tests).
 *
 * Every `it` below asserts the CORRECT behavior; under the current source each
 * one FAILS (assertion-style red). Bug inventory:
 *
 *  R3-1 [高] src/middleware/cors.ts:130-139 — csrf() compares only the URL
 *       HOST of Origin/Referer against the request Host. The scheme is never
 *       compared, so `Origin: https://localhost:3000` against an http
 *       endpoint (and vice versa) is accepted as "same-origin". Browsers
 *       treat different schemes as different origins: an XSS/MMITM foothold
 *       on the same host over the other scheme forges state changes.
 *       Fix direction: compare scheme+host+port (e.g. derive the expected
 *       origin from c.protocol/c.host and compare full origins).
 *
 *  R3-2 [中] src/middleware/cache.ts:34,75-77 — eligibility regexes reject
 *       `no-store|private` (and field-specific `no-cache="set-cookie"`) but a
 *       plain `Cache-Control: no-cache` (and `max-age=0`) response is stored
 *       and replayed for the whole TTL with no revalidation — violating the
 *       directive's contract (RFC 9111 §5.2.2.4). The cache has no validator
 *       support, so such responses must not be stored/replayed at all.
 *
 *  R3-3 [中] src/middleware/cache.ts:59-63 — the cache key is `METHOD:path`
 *       only. The Host (request authority) is not part of the key, so on an
 *       app serving several hosts the answer captured for host A is replayed
 *       to host B (RFC 9111 keys on the full target URI) — cross-tenant
 *       response leakage.
 *
 *  R3-4 [中低] src/middleware/cache.ts:101-113 — request-side
 *       `Cache-Control: no-store` / `no-cache` directives are ignored in both
 *       directions: a no-store request still SEEDS an entry, and a no-cache
 *       request is still served a stored entry (RFC 9111 §5.2.1.4/§5.2.1.5).
 *
 *  R3-5 [低] src/middleware/headers.ts:26-35 — secureHeaders()/requestId()
 *       write their headers only AFTER `await next()`. When the downstream
 *       chain throws, the post-next phase is skipped AND the error path wipes
 *       staged headers (core/dispatch.ts buildErrorResponse), so error
 *       responses ship without X-Content-Type-Options/X-Frame-Options
 *       (and without X-Request-ID) — unlike koa-helmet, which sets them
 *       before next() and thus covers error pages too.
 *
 *  R3-6 [低] src/middleware/etag.ts:135-140 (acceptsGzip) — a wildcard entry
 *       (`*;q=1`) overrides an EXPLICIT `gzip;q=0` refusal: the preference
 *       walk returns true on `*` even though the named q=0 entry exists.
 *       The module's own contract ("`gzip;q=0` is an explicit refusal") and
 *       the `negotiator` reference semantics (specific match beats wildcard)
 *       both say the refusal must win.
 */

import { describe, expect, it } from "vitest";

import { createApp } from "../src/core/app.ts";
import { csrf } from "../src/middleware/cors.ts";
import { cache } from "../src/middleware/cache.ts";
import { compress } from "../src/middleware/etag.ts";
import { secureHeaders, requestId } from "../src/middleware/headers.ts";
import { createError } from "../src/http/errors.ts";

const quiet = { env: "test" } as const;
const req = (path: string, init?: RequestInit) => new Request(`http://localhost:3000${path}`, init);

// ---------------------------------------------------------------------------
// R3-1 — csrf() scheme-blind origin comparison
// ---------------------------------------------------------------------------

describe("R3-1: csrf() must compare the full origin (scheme+host), not just the host", () => {
  it("a cross-SCHEME Origin against an http endpoint is rejected (currently accepted)", async () => {
    const app = createApp(quiet);
    app.use(csrf());
    app.post("/x", (c) => c.text("ok"));
    // Attack request: the endpoint lives on http://localhost:3000; a page on
    // https://localhost:3000 is a DIFFERENT browser origin and must be blocked.
    const res = await app.handle(
      new Request("http://localhost:3000/x", {
        method: "POST",
        headers: { origin: "https://localhost:3000" },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("a cross-scheme Origin against an https endpoint is rejected (currently accepted)", async () => {
    const app = createApp(quiet);
    app.use(csrf());
    app.post("/x", (c) => c.text("ok"));
    const res = await app.handle(
      new Request("https://localhost:3000/x", {
        method: "POST",
        headers: { origin: "http://localhost:3000" },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("the Referer fallback is scheme-checked too (https Referer on http endpoint)", async () => {
    const app = createApp(quiet);
    app.use(csrf());
    app.post("/x", (c) => c.text("ok"));
    const res = await app.handle(
      new Request("http://localhost:3000/x", {
        method: "POST",
        headers: { referer: "https://localhost:3000/form" },
      }),
    );
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// R3-2 — cache() replays no-cache responses without revalidation
// ---------------------------------------------------------------------------

describe("R3-2: cache() must not store/replay no-cache responses", () => {
  it("a Cache-Control: no-cache response is recomputed on the next request", async () => {
    let computed = 0;
    const app = createApp(quiet);
    app.get("/x", cache({ ttl: 60_000 }), (c) => {
      computed += 1;
      c.set("Cache-Control", "no-cache");
      return c.text(`v${computed}`);
    });
    await app.handle(req("/x"));
    const second = await app.handle(req("/x"));
    expect(second.headers.get("x-cache")).toBeNull();
    expect(await second.text()).toBe("v2");
  });

  it("a Cache-Control: max-age=0 response is recomputed too", async () => {
    let computed = 0;
    const app = createApp(quiet);
    app.get("/m", cache({ ttl: 60_000 }), (c) => {
      computed += 1;
      c.set("Cache-Control", "max-age=0");
      return c.text(`v${computed}`);
    });
    await app.handle(req("/m"));
    const second = await app.handle(req("/m"));
    expect(second.headers.get("x-cache")).toBeNull();
    expect(computed).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// R3-3 — cache key omits the Host (cross-host replay)
// ---------------------------------------------------------------------------

describe("R3-3: cache entries must not leak across hosts", () => {
  it("a response captured for host A is not replayed to host B", async () => {
    const app = createApp(quiet);
    app.get("/x", cache({ ttl: 60_000 }), (c) => c.text(`host:${c.host}`));
    await app.handle(new Request("http://tenant-a.test/x"));
    const b = await app.handle(new Request("http://tenant-b.test/x"));
    expect(b.headers.get("x-cache")).toBeNull();
    expect(await b.text()).toBe("host:tenant-b.test");
  });
});

// ---------------------------------------------------------------------------
// R3-4 — request-side Cache-Control directives are ignored
// ---------------------------------------------------------------------------

describe("R3-4: cache() must honor request Cache-Control: no-store / no-cache", () => {
  it("a no-store request never seeds an entry for later requests", async () => {
    let computed = 0;
    const app = createApp(quiet);
    app.get("/x", cache({ ttl: 60_000 }), (c) => {
      computed += 1;
      return c.text(`v${computed}`);
    });
    await app.handle(
      new Request("http://localhost:3000/x", { headers: { "cache-control": "no-store" } }),
    );
    expect(computed).toBe(1);
    const plain = await app.handle(req("/x"));
    expect(plain.headers.get("x-cache")).toBeNull();
    expect(computed).toBe(2);
  });

  it("a warmed entry is bypassed for a no-cache request", async () => {
    let computed = 0;
    const app = createApp(quiet);
    app.get("/y", cache({ ttl: 60_000 }), (c) => {
      computed += 1;
      return c.text(`v${computed}`);
    });
    await app.handle(req("/y")); // warm
    const revalidate = await app.handle(
      new Request("http://localhost:3000/y", { headers: { "cache-control": "no-cache" } }),
    );
    expect(revalidate.headers.get("x-cache")).toBeNull();
    expect(computed).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// R3-6 — wildcard Accept-Encoding overrides an explicit gzip;q=0 refusal
// ---------------------------------------------------------------------------

describe("R3-6: compress() must not gzip when gzip is explicitly refused (q=0)", () => {
  it("Accept-Encoding: gzip;q=0, *;q=1 is served identity (currently gzipped)", async () => {
    const app = createApp(quiet);
    app.use(compress());
    app.get("/big", (c) => {
      c.body = "x".repeat(2000);
    });
    const res = await app.handle(
      new Request("http://localhost:3000/big", {
        headers: { "accept-encoding": "gzip;q=0, *;q=1" },
      }),
    );
    expect(res.headers.get("content-encoding")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// R3-5 — secureHeaders/requestId never reach error responses
// ---------------------------------------------------------------------------

describe("R3-5: secureHeaders()/requestId() must cover error responses", () => {
  it("an error response still carries the secureHeaders defaults", async () => {
    const app = createApp(quiet);
    app.use(secureHeaders());
    app.get("/e", () => {
      throw createError(400, "bad input", { expose: true });
    });
    const res = await app.handle(req("/e"));
    expect(res.status).toBe(400);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("an error response still echoes the request id", async () => {
    const app = createApp(quiet);
    app.use(requestId());
    app.get("/e", () => {
      throw createError(419, "boom", { expose: true });
    });
    const res = await app.handle(
      new Request("http://localhost:3000/e", { headers: { "x-request-id": "abc-123" } }),
    );
    expect(res.headers.get("x-request-id")).toBe("abc-123");
  });
});
