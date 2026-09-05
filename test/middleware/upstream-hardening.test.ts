/**
 * Upstream-hardening regression suite — one lock per confirmed finding from
 * the four-way upstream audit (koa test corpus, hono test corpus, koa
 * GitHub issues, hono GitHub issues). Written test-first (red) against the
 * unfixed code, then made green by the fixes in this round.
 *
 * Sources per case are noted (koa#N / hono#N / corpus file).
 */

import { describe, expect, it } from "vitest";

import { Keala } from "../../src/core/app.ts";
import { toHttpError } from "../../src/http/errors.ts";
import { compress } from "../../src/middleware/etag.ts";
import { etag } from "../../src/middleware/etag.ts";
import { cache } from "../../src/middleware/cache.ts";
import { compilePattern } from "../../src/router/pattern.ts";
import { parseCookies, serializeCookie } from "../../src/context/cookies.ts";

const quiet = { env: "test" } as const;
const req = (path: string, init?: RequestInit) => new Request(`http://localhost:3000${path}`, init);

// ---------------------------------------------------------------------------
// compress — hono#5310/#897 (q=0) + hono corpus compress gates
// ---------------------------------------------------------------------------

const gzipBody = "compressible-content-".repeat(40); // > 200 bytes
const gzipAccepted = { headers: { "accept-encoding": "gzip" } } as RequestInit;

describe("upstream hardening: compress gates", () => {
  it("hono#5310: gzip;q=0 is an explicit refusal — never compressed", async () => {
    const app = new Keala(quiet);
    app.use(compress());
    app.get("/big", (c) => {
      c.body = gzipBody;
    });
    const refused = await app.handle(req("/big", { headers: { "accept-encoding": "gzip;q=0" } }));
    expect(refused.headers.get("content-encoding")).toBeNull();
    const mixed = await app.handle(
      req("/big", { headers: { "accept-encoding": "deflate, gzip;q=0" } }),
    );
    expect(mixed.headers.get("content-encoding")).toBeNull();
  });

  it("hono corpus: Cache-Control: no-transform is never compressed", async () => {
    const app = new Keala(quiet);
    app.use(compress());
    app.get("/big", (c) => {
      c.setHeader("Cache-Control", "no-transform");
      c.body = gzipBody;
    });
    const res = await app.handle(req("/big", gzipAccepted));
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-transform");
  });

  it("hono corpus: 206 Partial Content is never compressed", async () => {
    const app = new Keala(quiet);
    app.use(compress());
    app.get("/big", (c) => {
      c.status = 206;
      c.body = gzipBody;
    });
    const res = await app.handle(req("/big", gzipAccepted));
    expect(res.status).toBe(206);
    expect(res.headers.get("content-encoding")).toBeNull();
  });

  it("hono corpus: inherently-compressed content types are skipped", async () => {
    const app = new Keala(quiet);
    app.use(compress());
    app.get("/png", (c) => {
      c.type = "image/png";
      c.body = "PNG".repeat(200); // large enough, wrong type
    });
    const res = await app.handle(req("/png", gzipAccepted));
    expect(res.headers.get("content-encoding")).toBeNull();
    // textual types still compress
    app.get("/svg", (c) => {
      c.type = "image/svg+xml";
      c.body = gzipBody;
    });
    const svg = await app.handle(req("/svg", gzipAccepted));
    expect(svg.headers.get("content-encoding")).toBe("gzip");
  });

  it("hono corpus: `Accept-Encoding: *` accepts gzip", async () => {
    const app = new Keala(quiet);
    app.use(compress());
    app.get("/big", (c) => {
      c.body = gzipBody;
    });
    const res = await app.handle(req("/big", { headers: { "accept-encoding": "*" } }));
    expect(res.headers.get("content-encoding")).toBe("gzip");
  });
});

// ---------------------------------------------------------------------------
// etag — hono corpus: no 304 for unsafe methods
// ---------------------------------------------------------------------------

describe("upstream hardening: etag method gate", () => {
  it("POST with If-None-Match answers 200, never 304", async () => {
    const app = new Keala(quiet);
    app.use(etag());
    app.post("/e", (c) => {
      c.body = "payload";
    });
    app.get("/e", (c) => {
      c.body = "payload";
    });
    const res = await app.handle(req("/e", { method: "POST", headers: { "if-none-match": "*" } }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("payload");
    // GET still negotiates normally.
    const get = await app.handle(req("/e", { headers: { "if-none-match": "*" } }));
    expect(get.status).toBe(304);
  });
});

// ---------------------------------------------------------------------------
// cache — hono corpus: no-cache="Set-Cookie" must not be cached
// ---------------------------------------------------------------------------

describe("upstream hardening: responseCache skip rules", () => {
  it('no-cache="Set-Cookie" responses are not cached', async () => {
    const app = new Keala(quiet);
    app.use(cache({ ttl: 60_000 }));
    let hits = 0;
    let skipHits = 0;
    app.get("/c", (c) => c.text(`hit ${++hits}`)); // committed body: cacheable
    app.get("/s", (c) => {
      skipHits++;
      c.setHeader("Cache-Control", 'no-cache="Set-Cookie"');
      return c.text(`hit ${skipHits}`);
    });
    await app.handle(req("/c"));
    await app.handle(req("/c"));
    expect(hits).toBe(1); // control: the cache works when allowed
    await app.handle(req("/s"));
    await app.handle(req("/s"));
    expect(skipHits).toBe(2); // the skip rule keeps it uncached
    expect(hits).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// pattern — hono#4623 (`**` footgun) + hono corpus (suffix wildcard no-op)
// ---------------------------------------------------------------------------

describe("upstream hardening: pattern registration guards", () => {
  it("`**` is refused at registration (it is not a wildcard)", () => {
    expect(() => compilePattern("/auth/**")).toThrow(/wildcard/i);
  });

  it("a `*` inside a static segment (suffix wildcard) is refused", () => {
    expect(() => compilePattern("/assets*")).toThrow(/wildcard/i);
  });

  it("multi-segment custom patterns are a documented divergence: no cross-segment capture", async () => {
    // Lock the CURRENT (segment-scoped) semantics: /files/:name(.*) must not
    // capture across segments — documented deliberate divergence from hono.
    const app = new Keala(quiet);
    app.get("/files/:name(.*)", (c) => {
      c.body = `got ${c.params["name"]}`;
    });
    expect((await app.handle(req("/files/a/b"))).status).toBe(404);
    expect(await (await app.handle(req("/files/a"))).text()).toBe("got a");
  });
});

// ---------------------------------------------------------------------------
// cross-realm errors — koa corpus (context/onerror, application/onerror)
// ---------------------------------------------------------------------------

describe("upstream hardening: cross-realm errors", () => {
  it("an Error from another realm classifies in place as an unexposed 500", () => {
    const vm = require("node:vm") as typeof import("node:vm");
    const foreign = vm.runInNewContext("new Error('from another realm')");
    expect(foreign instanceof Error).toBe(false); // cross-realm, by construction
    const error = toHttpError(foreign);
    // In-place classification: the SAME object comes back, now an HttpError.
    expect(error).toBe(foreign);
    expect(error.status).toBe(500);
    expect(error.expose).toBe(false);
    expect(error.message).toBe("from another realm");
  });

  it("a thrown cross-realm Error answers a clean 500 with the message hidden", async () => {
    const vm = require("node:vm") as typeof import("node:vm");
    const app = new Keala(quiet);
    app.get("/boom", () => {
      throw vm.runInNewContext("new Error('realm secret')");
    });
    const res = await app.handle(req("/boom"));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("realm secret");
  });
});

// ---------------------------------------------------------------------------
// response — hono#2343 (json undefined), koa#1899 (Content-Type singleton),
// koa#1939 (stale Content-Length on stream/Response swap)
// ---------------------------------------------------------------------------

describe("upstream hardening: response invariants", () => {
  it("hono#2343: c.json(undefined) serializes as null, not a 500", async () => {
    const app = new Keala(quiet);
    app.get("/u/:id", (c) => c.json(undefined));
    const res = await app.handle(req("/u/404"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("null");
  });

  it("koa#1899: Content-Type cannot be set to an array (singleton header)", async () => {
    const app = new Keala(quiet);
    app.get("/a", (c) => {
      c.setHeader("Content-Type", ["text/html", "text/plain"]);
    });
    const res = await app.handle(req("/a"));
    expect(res.status).toBe(500); // the guard THROWS — never a joined header
    // The object form must be covered by the same guard.
    app.get("/b", (c) => {
      c.setHeader({ "Content-Type": ["text/html", "text/plain"] });
    });
    const resB = await app.handle(req("/b"));
    expect(resB.status).toBe(500);
  });

  it("koa#1939: replacing a sized body with a stream drops the stale Content-Length", async () => {
    const app = new Keala(quiet);
    app.get("/s", (c) => {
      c.body = "hello";
      c.setHeader("Content-Length", "5");
      c.body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("a-much-longer-body"));
          controller.close();
        },
      });
    });
    const res = await app.handle(req("/s"));
    expect(res.headers.get("content-length")).toBeNull();
    // A stream has unknown length by construction — an explicit stale CL
    // goes even WITHOUT a prior body.
    app.get("/s2", (c) => {
      c.setHeader("Content-Length", "10");
      c.body = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
    });
    const res2 = await app.handle(req("/s2"));
    expect(res2.headers.get("content-length")).toBeNull();
  });

  // 0.7: koa#1939 (`c.body = new Response(...)` dropping the stale CL) is
  // gone with the Response-as-body quirk — return the Response instead.
});

// ---------------------------------------------------------------------------
// request — koa corpus (XFH userinfo) + koa#827 (XFF ports)
// ---------------------------------------------------------------------------

describe("upstream hardening: forwarded headers", () => {
  it("koa host.test: userinfo in X-Forwarded-Host is stripped", async () => {
    const app = new Keala({ ...quiet, proxy: true });
    let host = "";
    app.get("/h", (c) => {
      host = c.host;
      c.body = host;
    });
    const res = await app.handle(
      req("/h", { headers: { "x-forwarded-host": "evil.com:fake@legitimate.com" } }),
    );
    expect(await res.text()).toBe("legitimate.com");
    void host;
  });

  it("koa#827: X-Forwarded-For entries carry stripped ports", async () => {
    // 0.7: c.ips is gone; c.ip keeps the same stripPort treatment of the
    // chain's leftmost entry.
    const app = new Keala({ ...quiet, proxy: true });
    app.get("/ip", (c) => {
      c.body = c.ip;
    });
    const res = await app.handle(
      req("/ip", { headers: { "x-forwarded-for": "23.243.1.1:38242, [::1]:8080, ::1, 5.6.7.8" } }),
    );
    expect(await res.text()).toBe("23.243.1.1");
  });
});

// ---------------------------------------------------------------------------
// cookies — hono corpus (NBSP names) + hono corpus serialize guards +
// koa corpus (secure derived from request)
// ---------------------------------------------------------------------------

describe("upstream hardening: cookies", () => {
  it("hono corpus: NBSP-prefixed names never alias a real cookie", () => {
    // \u00a0dummy must NOT be trimmed onto dummy (silent override vector).
    const jar = parseCookies("dummy=victim; \u00a0dummy=evil");
    expect(jar["dummy"]).toBe("victim");
    expect(jar["\u00a0dummy"]).toBeUndefined();
  });

  it("hono corpus: maxAge/expires beyond 400 days are refused", () => {
    expect(() => serializeCookie("a", "1", { maxAge: 401 * 24 * 60 * 60 })).toThrow(/400/);
    expect(() =>
      serializeCookie("a", "1", { expires: new Date(Date.now() + 401 * 86400_000) }),
    ).toThrow(/400/);
    expect(serializeCookie("a", "1", { maxAge: 400 * 24 * 60 * 60 })).toContain("Max-Age");
  });

  it("koa corpus: Secure is derived from the request when unset", async () => {
    const app = new Keala(quiet);
    app.get("/s", (c) => {
      c.cookies.set("sid", "1");
      c.body = "ok";
    });
    const https = await app.handle(new Request("https://localhost:3000/s"));
    expect(https.headers.getSetCookie()[0]).toContain("Secure");
    const http = await app.handle(new Request("http://localhost:3000/s"));
    expect(http.headers.getSetCookie()[0]).not.toContain("Secure");
    // Explicit opt-out wins even over TLS.
    app.get("/o", (c) => {
      c.cookies.set("sid", "1", { secure: false });
      c.body = "ok";
    });
    const optedOut = await app.handle(new Request("https://localhost:3000/o"));
    expect(optedOut.headers.getSetCookie()[0]).not.toContain("Secure");
  });

  it("hono corpus (locked divergence): malformed cookie VALUES parse leniently", () => {
    // koa-ecosystem leniency, deliberate: values with backslashes or an
    // unterminated quote are kept on the read side (serialize-side
    // validation still rejects them if re-set).
    const jar = parseCookies('y=choco\\nchip; best="sugar');
    expect(jar["y"]).toBe("choco\\nchip");
    expect(jar["best"]).toBe('"sugar');
  });
});
