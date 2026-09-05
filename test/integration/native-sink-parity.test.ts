/**
 * Sink parity — L1 of the dual-router differential (双路由对拍) the P3 exit
 * gate demands: the JS MIRROR of every sink shape must be indistinguishable
 * from an ordinary JS route across the divergence-prone URL corpus
 * (percent-decoding, trailing slashes, case, method fan-out). The real-Bun
 * legs (native table vs these predictions, and nativeRoutes:false) run in
 * scripts/smoke.ts — Bun-global stubbing cannot reach a genuine Bun.serve.
 *
 * Native-only divergences are LEDGERED in docs/PARITY.md and pinned by the
 * smoke legs, never here: the mirror is the reference, and this suite locks
 * the mirror to the ordinary router.
 */

import { describe, expect, it } from "vitest";

import { Keala } from "../../src/index.ts";
import { startNodeServer } from "../../src/adapters/node.ts";
import { rateLimit } from "../../src/middleware/rate-limit.ts";
import { metrics } from "../../src/middleware/metrics.ts";
import { createError } from "../../src/http/errors.ts";
import type { SunkHandler, Context } from "../../src/index.ts";

const quiet = { env: "test" } as const;

/** Handler shapes shared by the twin apps — bodies depend on params so a
 *  keyspace divergence cannot hide behind a constant. */
const healthHandler: SunkHandler = () =>
  new Response("ok", { headers: { "content-type": "text/plain; charset=utf-8" } });

const userHandler: SunkHandler = (_request, params) => Response.json({ id: params["id"] ?? null });

const postHandler: SunkHandler = (_request, params) =>
  Response.json({ user: params["id"] ?? null, post: params["pid"] ?? null });

const registerPlain = (app: InstanceType<typeof Keala>): void => {
  app.get(
    "/health",
    () => new Response("ok", { headers: { "content-type": "text/plain; charset=utf-8" } }),
  );
  app.get("/users/:id", (c) => Response.json({ id: c.params["id"] ?? null }));
  app.get("/users/:id/posts/:pid", (c) =>
    Response.json({ user: c.params["id"] ?? null, post: c.params["pid"] ?? null }),
  );
};

const registerSunk = (app: InstanceType<typeof Keala>): void => {
  app.sink("/health", healthHandler);
  app.sink("/users/:id", userHandler);
  app.sink("/users/:id/posts/:pid", postHandler);
};

interface Wire {
  status: number;
  contentType: string | null;
  allow: string | null;
  body: string;
}

const wireOf = async (
  app: InstanceType<typeof Keala>,
  path: string,
  method = "GET",
): Promise<Wire> => {
  const res = await app.handle(new Request(`http://localhost:3000${path}`, { method }));
  return {
    status: res.status,
    contentType: res.headers.get("content-type"),
    allow: res.headers.get("allow"),
    body: await res.text(),
  };
};

describe("sink parity: the JS mirror matches the ordinary router", () => {
  const corpus: Array<[string, string]> = [
    ["/health", "GET"],
    ["/health", "HEAD"],
    ["/health", "POST"],
    ["/health", "OPTIONS"],
    ["/health/", "GET"],
    ["/Health", "GET"],
    ["/users/12345", "GET"],
    ["/users/caf%C3%A9", "GET"],
    ["/users/%31%32%33", "GET"],
    ["/users/a%2Fb", "GET"],
    ["/users/%zz", "GET"],
    ["/users/", "GET"],
    ["/users", "GET"],
    ["/users/1/posts/2", "GET"],
    ["/users/1/posts/", "GET"],
    ["/definitely-not-here", "GET"],
  ];

  it("every corpus row is byte-identical between mirror and plain routes", async () => {
    const plain = new Keala(quiet);
    registerPlain(plain);
    const sunk = new Keala(quiet);
    registerSunk(sunk);
    for (const [path, method] of corpus) {
      expect(JSON.stringify(await wireOf(sunk, path, method)), `${method} ${path}`).toBe(
        JSON.stringify(await wireOf(plain, path, method)),
      );
    }
  });

  it("malformed escapes pass through verbatim to the handler (security contract #5)", async () => {
    const sunk = new Keala(quiet);
    registerSunk(sunk);
    const res = await wireOf(sunk, "/users/%zz");
    // The mirror decodes per-segment and lets malformed escapes through
    // UNTOUCHED — the native table substitutes U+FFFD (ledgered divergence,
    // pinned by the smoke leg).
    expect(res.body).toBe(JSON.stringify({ id: "%zz" }));
  });

  it("the mirror runs declared-transparent middleware the native table skips", async () => {
    const sunk = new Keala(quiet);
    // An UNDECLARED no-op layer: the mirror applies it (x-mw header rides),
    // which is exactly why a lying noOpFor declaration stays observable.
    sunk.use((_c, next) => next());
    expect(() => registerSunk(sunk)).toThrow(/noOpFor|alongside sunk routes/);
  });

  it("an exposed thrown HttpError answers through the builtin funnel", async () => {
    const sunk = new Keala(quiet);
    sunk.sink("/teapot", () => {
      throw createError(418, "short and stout", { expose: true });
    });
    const res = await wireOf(sunk, "/teapot");
    expect(res.status).toBe(418);
    expect(res.body).toBe("short and stout");
    expect(res.contentType).toMatch(/^text\/plain/);
  });

  it("a non-Response return is a loud 500, never a help page", async () => {
    const sunk = new Keala(quiet);
    // @ts-expect-error -- runtime contract check for JS callers
    sunk.sink("/bad", () => "not a response");
    const res = await wireOf(sunk, "/bad");
    expect(res.status).toBe(500);
    expect(res.body).toBe("Internal Server Error");
  });

  it("async handlers and async rejections keep the same contract", async () => {
    const sunk = new Keala(quiet);
    sunk.sink(
      "/slow",
      async () => new Response("later", { headers: { "content-type": "text/plain" } }),
    );
    sunk.sink("/rejects", async () => {
      throw createError(503, "upstream gone", { expose: true });
    });
    expect((await wireOf(sunk, "/slow")).body).toBe("later");
    const rejected = await wireOf(sunk, "/rejects");
    expect(rejected.status).toBe(503);
    expect(rejected.body).toBe("upstream gone");
  });

  it("params records are null-prototype on the mirror (native parity is probe-locked)", async () => {
    let seen: unknown = "unset";
    const sunk = new Keala(quiet);
    sunk.sink("/probe/:id", (_request, params) => {
      seen = Object.getPrototypeOf(params);
      return new Response("done");
    });
    await wireOf(sunk, "/probe/7");
    expect(seen).toBe(null);
  });
});

describe("production hardening: trustedHosts and unknownMethodAs404", () => {
  it("trustedHosts refuses forged Host authorities before routing", async () => {
    const app = new Keala({ env: "test", trustedHosts: ["example.com", "*.subs.example.com"] });
    app.get("/x", (c) => c.text("reached"));
    const ok = await app.handle(new Request("http://example.com/x"));
    expect([ok.status, await ok.text()]).toEqual([200, "reached"]);
    const wildcard = await app.handle(new Request("http://a.subs.example.com/x"));
    expect(wildcard.status).toBe(200);
    // A port never participates in the authority comparison.
    const withPort = await app.handle(new Request("http://example.com:3000/x"));
    expect(withPort.status).toBe(200);
    const forged = await app.handle(
      new Request("http://evil.com/x", { headers: { host: "evil.com" } }),
    );
    expect([forged.status, await forged.text()]).toEqual([403, "Forbidden Host"]);
    // `deep.subs.example.com` must NOT match `*.subs.example.com` (single label).
    const deep = await app.handle(new Request("http://deep.a.subs.example.com/x"));
    expect(deep.status).toBe(403);
  });

  it("an unset or empty trustedHosts list admits everything", async () => {
    for (const options of [{}, { trustedHosts: [] as string[] }]) {
      const app = new Keala({ env: "test", ...options });
      app.get("/x", (c) => c.text("any"));
      const res = await app.handle(new Request("http://anything.example/x"));
      expect(res.status).toBe(200);
    }
  });

  it("unknownMethodAs404 answers 404 instead of 501 for non-grammar methods", async () => {
    const app = new Keala({ env: "test", unknownMethodAs404: true });
    app.get("/x", (c) => c.text("ok"));
    // Bun's Request constructor silently coerces unknown methods to GET, so
    // the non-grammar leg only runs where Request keeps the method.
    if (typeof Bun === "undefined") {
      const unknown = await app.handle(
        new Request("http://localhost:3000/x", { method: "FROBNICATE" }),
      );
      expect(unknown.status).toBe(404);
    }
    // A KNOWN but unregistered method still gets 405 + Allow.
    const known = await app.handle(new Request("http://localhost:3000/x", { method: "POST" }));
    expect([known.status, known.headers.get("allow")?.split(", ").sort()]).toEqual([
      405,
      ["GET", "HEAD"],
    ]);
  });
});

describe("observability: rateLimit and metrics", () => {
  it("rateLimit enforces a fixed window per key with 429 + Retry-After", async () => {
    const app = new Keala(quiet);
    app.use(rateLimit({ limit: 2, windowMs: 1000, retryAfterSeconds: 2, headers: true }));
    app.get("/x", (c) => c.text("ok"));
    const request = () => app.handle(new Request("http://127.0.0.1:3000/x"));
    const first = await request();
    const second = await request();
    const third = await request();
    expect([first.status, second.status, third.status]).toEqual([200, 200, 429]);
    expect(third.headers.get("retry-after")).toBe("2");
    expect(third.headers.get("ratelimit-remaining")).toBe("0");
    expect(await third.text()).toBe("Too Many Requests");
  });

  it("rateLimit resets after the window passes", async () => {
    const app = new Keala(quiet);
    app.use(rateLimit({ limit: 1, windowMs: 40 }));
    app.get("/x", (c) => c.text("ok"));
    const hit = () => app.handle(new Request("http://127.0.0.1:3000/x"));
    expect((await hit()).status).toBe(200);
    expect((await hit()).status).toBe(429);
    await new Promise((r) => setTimeout(r, 60));
    expect((await hit()).status).toBe(200);
  });

  it("metrics counts requests by status class and renders Prometheus text", async () => {
    const app = new Keala(quiet);
    const m = metrics();
    app.use(m.middleware);
    app.get("/ok", (c) => c.text("fine"));
    app.get("/teapot", (c) => c.throw(418, "short and stout"));
    app.get("/metrics", m.page);
    const ok = await app.handle(new Request("http://127.0.0.1:3000/ok"));
    const teapot = await app.handle(new Request("http://127.0.0.1:3000/teapot"));
    expect([ok.status, teapot.status]).toEqual([200, 418]);
    const page = await app.handle(new Request("http://127.0.0.1:3000/metrics"));
    const body = await page.text();
    expect(page.headers.get("content-type")).toContain("text/plain");
    expect(body).toContain("keala_requests_total 2");
    expect(body).toContain('keala_requests_total{status="4xx"} 1');
    expect(body).toContain("keala_request_duration_ms_bucket");
    expect(m.registry.snapshot().inFlight).toBe(0);
  });
});

describe("observability: async-error and metricsPage parity", () => {
  it("metrics observes async rejections with the thrown status", async () => {
    const app = new Keala(quiet);
    const m = metrics();
    app.use(m.middleware);
    app.get("/late", async () => {
      throw (await Promise.resolve(), new Error("async boom"));
    });
    const res = await app.handle(new Request("http://127.0.0.1:3000/late"));
    expect(res.status).toBe(500);
    const snap = m.registry.snapshot();
    expect([snap.requestsTotal, snap.byClass["5xx"] ?? 0, snap.inFlight]).toEqual([1, 1, 0]);
  });
});

describe("documents intentional divergence: targeted query reads (0.6.2)", () => {
  it("repeated keys collect via queries(); empty-name keys are dropped", async () => {
    const app = new Keala(quiet);
    app.get("/q", (c) => c.json({ a: c.queries("a"), empty: c.query("") }));
    const res = await app.handle(new Request("http://x/q?a=1&a=2&=x"));
    // `empty` is undefined and JSON.stringify drops it — the empty-name pair
    // is invisible to targeted reads by design.
    expect(await res.text()).toBe('{"a":["1","2"]}');
  });

  it("unsafe-looking keys are plain string reads — structurally pollution-free", async () => {
    const app = new Keala(quiet);
    app.get("/q", (c) => c.json({ proto: c.query("__proto__"), ok: c.query("ok") }));
    const res = await app.handle(new Request("http://x/q?__proto__=1&constructor=2&ok=3"));
    expect(await res.text()).toBe('{"proto":"1","ok":"3"}');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("query: targeted read semantics (0.6.2)", () => {
  const app = new Keala(quiet);
  app.get("/q", (c) =>
    c.json({
      first: c.query("a") ?? null,
      all: c.queries("a"),
      miss: c.query("missing") ?? null,
      bare: c.query("bare") ?? null,
      boundary: c.query("page") ?? null,
    }),
  );

  it("first/queries/miss/bare-key/boundary-match all behave", async () => {
    const res = await app.handle(
      new Request("http://localhost:3000/q?a=1&a=2&pagesize=9&bare&page=3"),
    );
    expect(await res.json()).toEqual({
      first: "1",
      all: ["1", "2"],
      miss: null,
      bare: "",
      boundary: "3",
    });
  });

  it("decodes escapes and '+', malformed escapes stay verbatim", async () => {
    const read = async (qs: string) => {
      const res = await app.handle(new Request(`http://localhost:3000/q${qs}`));
      return (await res.json()) as { first: string | null };
    };
    expect((await read("?a=%C3%A9")).first).toBe("é");
    expect((await read("?a=b+c")).first).toBe("b c");
    expect((await read("?a=%2B")).first).toBe("+");
    expect((await read("?a=%ZZ")).first).toBe("%ZZ");
  });

  it("canonically encoded keys are findable by their decoded name", async () => {
    // encodeURIComponent encodes reserved chars (brackets), so the canonical
    // encoded form of a hostile key round-trips through the fallback.
    // Non-canonical encoding of UNRESERVED chars (e.g. %5F for _) is not
    // decoded on the match path — documented boundary; read c.querystring
    // for that.
    const probe = new Keala(quiet);
    probe.get("/p", (c) => c.json({ v: c.query("__proto__[polluted]") ?? null }));
    const out = await probe.handle(
      new Request(`http://localhost:3000/p?${encodeURIComponent("__proto__[polluted]")}=1`),
    );
    expect(((await out.json()) as { v: string | null }).v).toBe("1");
  });
});

describe("review fixes: 0.6.3 regression locks", () => {
  it("rateLimit evicts expired keys — the store stays bounded across windows", async () => {
    const store = new Map<string, { count: number; resetAt: number }>();
    const app = new Keala(quiet);
    app.use(
      rateLimit({ limit: 5, windowMs: 30, maxKeys: 10, key: (c) => c.header("x-k") ?? "?", store }),
    );
    app.get("/x", (c) => c.text("ok"));
    const hit = (k: string) =>
      app.handle(new Request("http://127.0.0.1:3000/x", { headers: { "x-k": k } }));
    for (let i = 0; i < 30; i++) await hit(`k${i}`);
    expect(store.size).toBeLessThanOrEqual(10);
    await new Promise((r) => setTimeout(r, 50));
    await hit("fresh");
    expect(store.size).toBeLessThanOrEqual(10);
  });

  it("trustedHosts also gates X-Forwarded-Host under proxy trust", async () => {
    const app = new Keala({ env: "test", proxy: true, trustedHosts: ["app.example.com"] });
    app.get("/x", (c) => c.text(c.host));
    const poisoned = await app.handle(
      new Request("http://app.example.com/x", { headers: { "x-forwarded-host": "evil.net" } }),
    );
    expect(poisoned.status).toBe(403);
    const ok = await app.handle(
      new Request("http://app.example.com/x", {
        headers: { "x-forwarded-host": "app.example.com" },
      }),
    );
    expect([ok.status, await ok.text()]).toEqual([200, "app.example.com"]);
  });

  it("Node transport: a staged content-length never desyncs a streamed committed Response", async () => {
    const app = new Keala({ env: "test" });
    app.get("/cl", (c) => {
      c.setHeader("content-length", "50"); // staged lie
      return new Response("hi"); // 2-byte body
    });
    const server = await startNodeServer(app, { port: 0, hostname: "127.0.0.1" }).ready();
    const first = await fetch(`http://127.0.0.1:${server.port}/cl`);
    expect(first.status).toBe(200);
    expect(await first.text()).toBe("hi");
    // With the stale length dropped the framing is chunked or exact —
    // either way a second request on a NEW connection gets its own answer.
    const second = await fetch(`http://127.0.0.1:${server.port}/cl`);
    expect(await second.text()).toBe("hi");
  });

  it("c.query() reads '+ '-encoded space keys (browser form encoding)", async () => {
    const app = new Keala(quiet);
    app.get("/q", (c) => c.json({ v: c.query("user name") ?? null }));
    const res = await app.handle(new Request("http://127.0.0.1:3000/q?user+name=1"));
    expect(await res.json()).toEqual({ v: "1" });
  });

  it("redirect() rejects non-3xx codes eagerly at registration", () => {
    const app = new Keala(quiet);
    expect(() => app.redirect("/a", "/b", 999)).toThrow(/3xx/);
    expect(() => app.redirect("/a", "/b", 250)).toThrow(/3xx/);
    expect(() => app.redirect("/a", "/b", 301)).not.toThrow();
  });

  it("overload options refuse unknown keys (typo disarm protection)", () => {
    expect(() => new Keala({ env: "test", overload: { maxConcurreny: 1 } as never })).toThrow(
      /typo/,
    );
    expect(() => new Keala({ env: "test", overload: { maxConcurrency: 1 } })).not.toThrow();
    expect(
      () => new Keala({ env: "test", overload: { maxConcurrency: 1, maxQueue: 0 } }),
    ).not.toThrow();
  });

  it("post-next observers see the committed Response's status/type", async () => {
    const app = new Keala(quiet);
    const seen: unknown[] = [];
    app.use(async (c, next) => {
      await next();
      // 0.7: c.message is gone; the commit-aware reads are status/type.
      seen.push(c.status, c.type);
    });
    app.get(
      "/x",
      () =>
        new Response("body", {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );
    const res = await app.handle(new Request("http://127.0.0.1:3000/x"));
    expect(res.status).toBe(201);
    expect(seen).toEqual([201, "application/json"]);
  });

  it("has() sees committed Response headers — security-header guards cannot clobber", async () => {
    const app = new Keala(quiet);
    app.use(async (c, next) => {
      await next();
      if (!c.has("x-frame-options")) c.setHeader("x-frame-options", "DENY");
    });
    app.get("/x", () => new Response("ok", { headers: { "x-frame-options": "SAMEORIGIN" } }));
    const res = await app.handle(new Request("http://127.0.0.1:3000/x"));
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });

  it("synthesized 405s answer on the wire; routerAllowed is the observer surface", async () => {
    const app = new Keala(quiet);
    const seen: unknown[] = [];
    app.use(async (c, next) => {
      await next();
      // c.status still reads the pre-synthesis state here (finalize runs
      // after the chain settles); allowed methods are the observable truth.
      seen.push(c.routerAllowed.has("GET"), c.routerAllowed.has("DELETE"));
    });
    app.get("/x", (c) => c.text("ok"));
    const res = await app.handle(new Request("http://127.0.0.1:3000/x", { method: "DELETE" }));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toContain("GET");
    expect(seen).toEqual([true, false]);
  });

  it("a retained pooled context's query() stays callable (dead-proto method read)", async () => {
    const app = new Keala({ ...quiet, pooling: true });
    const held: Context[] = [];
    app.use((c, next) => {
      held.push(c);
      return next();
    });
    app.get("/x", (c) => c.text("ok"));
    await (await app.handle(new Request("http://127.0.0.1:3000/x?v=1"))).text();
    await (await app.handle(new Request("http://127.0.0.1:3000/x?v=2"))).text();
    const retained = held[0] as unknown as { query(name: string): string | undefined };
    // The guard must not shadow the METHOD (previously a TypeError). The
    // value follows the object's generation — request 2 recycled it — which
    // is the documented retention boundary, not a bug.
    expect(typeof retained.query).toBe("function");
    expect(typeof retained.query("v")).toBe("string");
  });
});
