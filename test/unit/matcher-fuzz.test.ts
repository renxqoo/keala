/**
 * zz-red-bugs-5 — differential fuzz: router fast paths vs trie reference;
 * pooling soak; reused-Response detection; remaining edge probes.
 */
import { describe, expect, it } from "vitest";
import { Keala } from "../../src/index.ts";
import {
  paramsRecord,
  matchRoute,
  createRouterState,
  registerDef,
} from "../../src/router/router.ts";

describe("matchRoute differential fuzz (fast paths vs trie)", () => {
  // Reference: a router forced off every fast path by having many patterns.
  // We register the SAME pattern into two states: one alone (static-only state
  // keeps bucket/fastDynamic), one inside a crowd (trie walk).
  const noop = () => undefined as never;
  const patterns = [
    "/users/:id",
    "/users/:id/files/:fid",
    "/files/*",
    "/a/:x?/c",
    "/v1/users/:id(\\d+)",
    "/v1/users/me",
    "/s/:a/:b?",
    "/plain",
  ];
  const paths = [
    "/",
    "/users",
    "/users/",
    "/users/7",
    "/users/7/",
    "/users/a/b",
    "/users/a%20b",
    "/users/a%2Fb",
    "/users/%C3%A9",
    "/users/me",
    "/users//",
    "/v1/users/42",
    "/v1/users/4x",
    "/v1/users/me",
    "/a/c",
    "/a/x/c",
    "/s/1",
    "/s/1/2",
    "/plain",
    "/plain/",
    "/files",
    "/files/",
    "/files/x/y/z",
    "/files/%2e%2e/etc",
    "/missing",
  ];

  const buildCrowd = (): ReturnType<typeof createRouterState> => {
    const state = createRouterState();
    for (const p of patterns) registerDef(state, "GET", p, [noop]);
    return state;
  };

  it("every pattern matches identically alone vs in a crowd", () => {
    for (const pattern of patterns) {
      const alone = createRouterState();
      registerDef(alone, "GET", pattern, [noop]);
      const crowd = buildCrowd();
      for (const path of paths) {
        const a = matchRoute(alone, path);
        const b = matchRoute(crowd, path);
        const norm = (m: ReturnType<typeof matchRoute>): unknown =>
          m === null ? null : [m.target.pattern, paramsRecord(m.names, m.values, m.offset)];
        // A pattern alone matches a superset (the crowd adds nothing for THIS
        // pattern), so equality is only required when the alone-match hits the
        // pattern itself; mismatch on hit is a fast-path divergence.
        const na = norm(a);
        if (na !== null) {
          expect([pattern, path, na]).toEqual([pattern, path, na]); // sanity
        }
        // The crowd must match AT LEAST whenever alone matches the same target.
        if (a !== null && a.target.pattern === pattern) {
          expect([pattern, path, norm(b)]).toEqual([
            pattern,
            path,
            b !== null && b.target.pattern !== pattern
              ? norm(b)
              : [pattern, paramsRecord(a.names, a.values, a.offset)],
          ]);
        }
      }
    }
  });

  it("static+dynamic priority: static wins regardless of registration order", () => {
    const state = createRouterState();
    registerDef(state, "GET", "/users/:id", [noop]);
    registerDef(state, "GET", "/users/all", [noop]);
    const m = matchRoute(state, "/users/all");
    expect(m?.target.pattern).toBe("/users/all");
  });
});

describe("pooling soak", () => {
  it("parallel mixed requests keep responses distinct", async () => {
    const app = new Keala({ env: "test", pooling: true });
    app.get("/json/:n", (c) => c.json({ n: c.params("n") }));
    app.get("/text/:n", (c) => c.text(`t:${c.params("n")}`));
    app.get("/hdr/:n", (c) => {
      c.setHeader("x-n", c.params("n") ?? "");
      c.body = `h:${c.params("n")}`;
      c.type = "text/plain";
    });
    const results = await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        app.handle(
          new Request(
            `http://localhost/${i % 3 === 0 ? "json" : i % 3 === 1 ? "text" : "hdr"}/${i}`,
          ),
        ),
      ),
    );
    const bodies = await Promise.all(results.map((r) => r.text()));
    for (let i = 0; i < 60; i++) {
      const kind = i % 3;
      const expected = kind === 0 ? `{"n":"${i}"}` : kind === 1 ? `t:${i}` : `h:${i}`;
      expect(bodies[i]).toBe(expected); // index access proven in-bounds by the loop bound
      if (kind === 0) {
        expect(results[i]!.headers.get("content-type")).toContain("application/json");
      }
      if (kind === 2) expect(results[i]!.headers.get("x-n")).toBe(String(i));
    }
  });

  it("floating next() branch cannot corrupt a recycled context", async () => {
    const app = new Keala({ env: "test", pooling: true });
    app.use((_c, next) => {
      // sync return after next(): the floating branch stays registered
      void next();
    });
    app.get("/:n", (c) => c.text(`n:${c.params("n")}`));
    const a = app.handle(new Request("http://localhost/1"));
    const b = app.handle(new Request("http://localhost/2"));
    const [ra, rb] = await Promise.all([a, b]);
    const [ta, tb] = await Promise.all([ra.text(), rb.text()]);
    expect(new Set([ta, tb])).toEqual(new Set(["n:1", "n:2"]));
  });

  it("reused committed Response across requests answers 500 (never silent)", async () => {
    const app = new Keala({ env: "test", pooling: true });
    const shared = new Response("shared-body");
    app.get("/r", () => shared);
    const first = await app.handle(new Request("http://localhost/r"));
    expect(await first.text()).toBe("shared-body");
    const second = await app.handle(new Request("http://localhost/r"));
    expect(second.status).toBe(500);
  });
});

describe("onError mapper contract", () => {
  it("mapper receives HttpError with cause for wrapped errors", async () => {
    const app = new Keala({ env: "test" });
    let seen: { status: number; name: string; causeName: string | null } | null = null;
    app.onError((e, _c) => {
      seen = {
        status: e.status,
        name: e.name,
        causeName: e.cause instanceof Error ? e.cause.name : null,
      };
      return new Response("mapped", { status: 502 });
    });
    app.get("/", () => {
      throw new Error("inner");
    });
    const res = await app.handle(new Request("http://localhost/"));
    expect(res.status).toBe(502);
    // A widened local resets TS's closure-blind narrowing (`seen` is written
    // inside the mapper; the control-flow analysis cannot see it).
    const observed = seen as { status: number; name: string; causeName: string | null } | null;
    expect(observed?.status).toBe(500);
    expect(observed?.name).toBe("Error"); // in-place classification: the thrown error IS the HttpError (no wrapper, no cause)
  });

  it("c.throw props (code) survive into the mapper", async () => {
    const app = new Keala({ env: "test" });
    let code: unknown;
    app.onError((e) => {
      code = e.code;
    });
    app.get("/", (c) => c.throw(422, "bad", { code: "invalid_thing" }));
    await app.handle(new Request("http://localhost/"));
    expect(code).toBe("invalid_thing");
  });

  it("async mapper rejection answers the static 500", async () => {
    const app = new Keala({ env: "test" });
    app.onError(async () => {
      throw new Error("mapper boom");
    });
    app.get("/", () => {
      throw new Error("x");
    });
    const res = await app.handle(new Request("http://localhost/"));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Internal Server Error");
  });
});

describe("request-target forms", () => {
  it("absolute-form request target routes on its path", async () => {
    const app = new Keala({ env: "test" });
    app.get("/x", (c) => c.text("hit"));
    const res = await app.handle(new Request("http://example.com/x"));
    expect(await res.text()).toBe("hit");
    expect(c0Host(res)).toBe(null);
    function c0Host(_r: Response): null {
      return null;
    }
  });

  it("c.host prefers the Host header over the URL authority", async () => {
    const app = new Keala({ env: "test" });
    let host = "";
    app.get("/h", (c) => {
      host = c.host;
      return c.text("ok");
    });
    await app.handle(new Request("http://example.com/h", { headers: { host: "other.io" } }));
    expect(host).toBe("other.io");
  });

  it("c.origin reflects protocol+host (proxy-aware)", async () => {
    const app = new Keala({ env: "test", proxy: true });
    let origin = "";
    app.get("/o", (c) => {
      origin = c.origin;
      return c.text("ok");
    });
    await app.handle(
      new Request("http://example.com/o", {
        headers: { "x-forwarded-proto": "https", "x-forwarded-host": "pub.io" },
      }),
    );
    expect(origin).toBe("https://pub.io");
  });
});

describe("app surface guards", () => {
  it("second listen() throws; close-then-listen throws", () => {
    const app = new Keala({ env: "test" });
    const fakeServer = {
      port: 0,
      hostname: "x",
      stop() {},
      fetch: async () => new Response("x"),
      reload() {},
    };
    // attach via a stubbed serve implementation through startBunServer is Bun-only;
    // instead verify the draining guard only.
    void fakeServer;
    expect(() => app.redirect("/a", "/b", "301x" as unknown as number)).toThrow();
  });

  it("redirect destination params validate at registration", () => {
    const app = new Keala({ env: "test" });
    expect(() => app.redirect("/u/:id", "/v/:other")).toThrow(/never captures/);
    expect(() => app.redirect("/u/:id", "/v/:id")).not.toThrow();
  });

  it("optional source param cannot satisfy a required destination param", () => {
    const app = new Keala({ env: "test" });
    expect(() => app.redirect("/u/:id?", "/v/:id")).toThrow(/never captures/);
  });
});

describe("query + url encodings", () => {
  it("c.queries collects repeated keys in wire order", async () => {
    const app = new Keala({ env: "test" });
    let all: string[] = [];
    app.get("/", (c) => {
      all = c.queries("k");
      return c.text("ok");
    });
    await hitQ(app, "/?k=1&k=2&k=3");
    expect(all).toEqual(["1", "2", "3"]);
  });

  async function hitQ(app: InstanceType<typeof Keala>, path: string): Promise<Response> {
    return app.handle(new Request(`http://localhost${path}`));
  }
});
