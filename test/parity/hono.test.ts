/**
 * Round-6 DIFFERENTIAL audit vs real hono 4.13.5 (node_modules/hono).
 *
 * Harness: the same requests are driven against keala (`app.handle(req)`)
 * and hono (`app.fetch(req)`) — both fetch-style — and the observable
 * responses compared. CONFIRMED BUG -> `it()` asserts the CORRECT
 * (hono-referenced) behavior and FAILS against the current src/.
 * DIVERGENCE -> "documents intentional divergence" describes, all GREEN.
 *
 * CONFIRMED-BUG ledger (one root cause: the sugar helpers merge the per-call
 * `headers` record in RAW-key space instead of the lowercased canonical one):
 *
 * R6-1 HIGH src/core/context/sugar.ts:45-54 (mergedHeadersOf) + :132 (sugarText)
 *   The per-call headers are spread verbatim (`{...record, ...headers}`), so a
 *   key whose CASE differs from the lowercased space survives as a SECOND
 *   entry; the fetch Headers record-init APPENDS every entry, producing a
 *   comma-joined INVALID singleton header:
 *     c.text("hi", 200, { "Content-Type": "text/plain" })
 *       keala "text/plain, text/plain; charset=utf-8"  hono "text/plain"
 *     c.setHeader("x-foo","staged") + c.text("hi",200,{ "X-Foo":"call" })
 *       keala "staged, call"  hono "call"
 *
 * R6-2 MEDIUM src/core/context/sugar.ts:180-181 (sugarHtml)
 *   sugarHtml unconditionally overwrites content-type with TEXT_HTML, so the
 *   caller's own content-type is discarded even in canonical lowercase:
 *     c.html("<i>x</i>", 200, { "content-type": "text/plain" })
 *       keala "text/html; charset=utf-8"  hono "text/plain"
 *   (hono's setDefaultContentType spreads the DEFAULT first, user headers
 *   after — the caller always wins; sugarText honors a lowercase override,
 *   sugarHtml has no override path at all.)
 *
 * Fix direction: normalize per-call header keys to lowercase in
 * mergedHeadersOf and let the default-content-type decision fall out of that
 * normalized merge instead of a raw `merged["content-type"] === undefined`
 * probe / unconditional write.
 *
 * Intentional divergences (GREEN, with the governing contract):
 *   trailing slash optional          @koa/router non-strict (hono 404s)
 *   `/w/*` needs the `/w/` prefix    @koa/router (hono also answers `/w`)
 *   static beats param, always       express/@koa/router (hono: order-dependent)
 *   duplicate param name: last wins  express/@koa/router (hono: first wins)
 *   staged c.set content-type survives c.text()   koa (hono overwrites default)
 *   c.json(undefined) -> "null"      valid JSON (hono ships an EMPTY body)
 *   sugar 204/304 -> clean empty     keala (hono c.text(x,204) throws -> 500)
 *   c.body = null -> 204             koa (hono c.body(null) -> 200)
 *   c.redirect -> 302 + koa body     koa (hono: bare 302, no body/type)
 *   405 + Allow, OPTIONS -> 200      @koa/router allowedMethods (hono 404s)
 *   not-found body "Not Found"       koa (hono: "404 Not Found")
 *   query repeats -> arrays, empty names kept    koa querystring.parse
 *   unsafe query keys dropped        keala security contract
 *   middleware Response after next() rewrites    koa state semantics
 *   HEAD backfills Content-Length; c.path stays percent-encoded   koa
 *   param regex is per-segment       keala trie contract (hono `{...}` spans "/")
 * Open questions (NOT red-tested): hono matches static/param by REGISTRATION
 * ORDER; hono's getPath uses decodeURI so reserved escapes (`%3B`) stay
 * escaped while keala decodes into one canonical space; hono's mid-path
 * `:x?` keeps the "?" in the name and never serves the skip variant; the bare
 * `*` captures under params.wildcard (hono: unnamed); `//` answers the root
 * route (hono 404s).
 */
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { Keala } from "../../src/core/app.ts";
import { paramsRecord } from "../../src/router/router.ts";
import type { Context } from "../../src/core/context/context.ts";
const quiet = { env: "test" } as const;
const drive = (app: InstanceType<typeof Keala>, req: Request) => app.handle(req);
// CONFIRMED BUG R6-1 (HIGH): per-call sugar headers merge in raw-key space.
describe("R6-1 CONFIRMED-BUG: sugar per-call headers must merge in the canonical (lowercased) keyspace", () => {
  it('c.text(body, status, { "Content-Type": … }) ships ONE content-type, not a comma-joined duplicate', async () => {
    const app = new Keala(quiet);
    app.get("/r", (c) => c.text("hi", 200, { "Content-Type": "text/plain" }));
    const res = await drive(app, new Request("http://x/r"));
    // hono 4.13.5: the user key (any case) replaces the default exactly once.
    expect(res.headers.get("content-type")).toBe("text/plain");
  });

  it("staged c.setHeader() plus a case-mismatched per-call key produces one value, not two comma-joined", async () => {
    const app = new Keala(quiet);
    app.get("/r", (c) => {
      c.setHeader("x-foo", "staged");
      return c.text("hi", 200, { "X-Foo": "call" });
    });
    const res = await drive(app, new Request("http://x/r"));
    // hono 4.13.5: "call" (the per-call headers replace the staged value).
    expect(res.headers.get("x-foo")).toBe("call");
    expect(res.headers.getSetCookie()).toEqual([]);
  });
});

// CONFIRMED BUG R6-2 (MEDIUM): c.html overrides the caller's content-type.
describe("R6-2 CONFIRMED-BUG: c.html must honor the caller's per-call content-type", () => {
  it('c.html(body, status, { "content-type": "text/plain" }) ships text/plain, not text/html', async () => {
    const app = new Keala(quiet);
    app.get("/r", (c) => c.html("<i>x</i>", 200, { "content-type": "text/plain" }));
    const res = await drive(app, new Request("http://x/r"));
    // hono 4.13.5 setDefaultContentType: the default is spread FIRST, user
    // headers after — the caller's value wins.
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(await res.text()).toBe("<i>x</i>");
  });

  it("c.html with a capitalized user content-type ships it once (no duplicate)", async () => {
    const app = new Keala(quiet);
    app.get("/r", (c) => c.html("<i>x</i>", 200, { "CONTENT-TYPE": "text/plain" }));
    const res = await drive(app, new Request("http://x/r"));
    expect(res.headers.get("content-type")).toBe("text/plain");
  });
});

// ---------------------------------------------------------------------------
// Intentional divergences — every test here is GREEN by design.
// ---------------------------------------------------------------------------
describe("documents intentional divergence: trailing slash is optional (koa-router non-strict; hono 404s)", () => {
  it("static, param and optional-param routes answer their trailing-slash form", async () => {
    const app = new Keala(quiet);
    app.get("/plain/static", (c) => c.text("static"));
    app.get("/users/:id", (c) => c.json(paramsRecord(c.paramNames, c.paramValues, c.paramOffset)));
    app.get("/opt/:x?", (c) => c.json(paramsRecord(c.paramNames, c.paramValues, c.paramOffset)));
    for (const [path, want] of [
      ["/plain/static/", "static"],
      ["/users/42/", '{"id":"42"}'],
      ["/opt/x/", '{"x":"x"}'],
    ] as const) {
      const res = await drive(app, new Request(`http://x${path}`));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(want);
    }
  });
});

describe("documents intentional divergence: '/w/*' requires the '/w/' prefix (hono also answers '/w')", () => {
  it("the bare prefix without a slash is a different resource; '/w/' captures the empty wildcard", async () => {
    const app = new Keala(quiet);
    app.get("/w/*", (c) => c.json(paramsRecord(c.paramNames, c.paramValues, c.paramOffset)));
    const bare = await drive(app, new Request("http://x/w"));
    expect(bare.status).toBe(404);
    const empty = await drive(app, new Request("http://x/w/"));
    expect(await empty.text()).toBe('{"wildcard":""}');
  });
});

describe("documents intentional divergence: static beats param regardless of registration order (hono is order-dependent)", () => {
  it("a static sibling wins even when the param route was registered first", async () => {
    const app = new Keala(quiet);
    app.get("/users/:id", (c) => c.json({ via: "param" }));
    app.get("/users/me", (c) => c.json({ via: "static" }));
    const res = await drive(app, new Request("http://x/users/me"));
    expect(await res.text()).toBe('{"via":"static"}');
    // hono 4.13.5 with the same registration order answers {"via":"param"} —
    // its RegExpRouter alternation priority follows registration order.
  });
});

describe("documents intentional divergence: duplicate param name keeps the LAST capture (express/@koa/router; hono keeps the first)", () => {
  it("/:x/:x resolves to the later segment", async () => {
    const app = new Keala(quiet);
    app.get("/:x/:x", (c) => c.json(paramsRecord(c.paramNames, c.paramValues, c.paramOffset)));
    const res = await drive(app, new Request("http://x/1/2"));
    expect(await res.text()).toBe('{"x":"2"}');
  });
});

describe("documents intentional divergence: a staged c.setHeader('Content-Type') survives c.text() (hono overwrites it with its default)", () => {
  it("the staged type wins over the helper default", async () => {
    const app = new Keala(quiet);
    app.get("/r", (c) => {
      c.setHeader("Content-Type", "application/xml");
      return c.text("hi");
    });
    const res = await drive(app, new Request("http://x/r"));
    expect(res.headers.get("content-type")).toBe("application/xml");
    // hono 4.13.5: "text/plain; charset=UTF-8" — setDefaultContentType always
    // writes its default into the response headers.
  });
});

describe("documents intentional divergence: c.json(undefined) answers valid JSON 'null' (hono ships an EMPTY body with content-type application/json)", () => {
  it("undefined payloads serialize as null", async () => {
    const app = new Keala(quiet);
    app.get("/r", (c) => c.json(undefined));
    const res = await drive(app, new Request("http://x/r"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.text()).toBe("null");
  });
});

describe("documents intentional divergence: sugar helpers answer 204/304 with a clean empty Response (hono's c.text(x, 204) throws -> 500)", () => {
  it.each([
    ["text", (c: Context) => c.text("x", 204)],
    ["json", (c: Context) => c.json({}, 204)],
    ["html", (c: Context) => c.html("x", 304)],
  ] as const)("%s with an empty status stays empty and header-clean", async (_name, handler) => {
    const app = new Keala(quiet);
    app.get("/r", (c) => handler(c));
    const res = await drive(app, new Request("http://x/r"));
    expect([204, 304]).toContain(res.status);
    expect(await res.text()).toBe("");
    expect(res.headers.get("content-type")).toBeNull();
    expect(res.headers.get("content-length")).toBeNull();
  });
});

describe("documents intentional divergence: c.body = null answers 204 (koa); hono's c.body(null) answers 200", () => {
  it("null body collapses to an empty 204", async () => {
    const app = new Keala(quiet);
    app.get("/r", (c) => void (c.body = null));
    const res = await drive(app, new Request("http://x/r"));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });
});

describe("0.7 alignment: c.redirect() ships a bare 302 exactly like hono (the koa body is gone)", () => {
  it("location, status and an empty body", async () => {
    const app = new Keala(quiet);
    app.get("/r", (c) => {
      c.redirect("/elsewhere");
    });
    const res = await drive(app, new Request("http://x/r"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/elsewhere");
    expect(await res.text()).toBe("");
  });
});

describe("documents intentional divergence: 405 + Allow and OPTIONS 200 come from @koa/router allowedMethods (hono 404s both)", () => {
  it("an unregistered method on a known path yields 405 with the koa-ordered Allow header", async () => {
    const app = new Keala(quiet);
    app.get("/r", (c) => c.text("get"));
    app.put("/r", (c) => c.text("put"));
    const res = await drive(app, new Request("http://x/r", { method: "POST" }));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("HEAD, GET, PUT");
  });

  it("OPTIONS on a path without an OPTIONS handler answers 200 with Allow", async () => {
    const app = new Keala(quiet);
    app.get("/r", (c) => c.text("get"));
    const res = await drive(app, new Request("http://x/r", { method: "OPTIONS" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("allow")).toBe("HEAD, GET");
  });
});

describe("documents intentional divergence: the default not-found body is koa's 'Not Found' (hono: '404 Not Found')", () => {
  it("404 shape", async () => {
    const app = new Keala(quiet);
    const res = await drive(app, new Request("http://x/none"));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not Found");
  });
});

describe("documents intentional divergence: a middleware Response returned after await next() REWRITES the response (koa state semantics; hono keeps the first finalized response)", () => {
  it("last committer wins", async () => {
    const app = new Keala(quiet);
    app.use(async (_c, next) => {
      await next();
      return new Response("rewritten", { status: 299 });
    });
    app.get("/r", (c) => c.text("handler"));
    const res = await drive(app, new Request("http://x/r"));
    expect(res.status).toBe(299);
    expect(await res.text()).toBe("rewritten");
  });
});

describe("documents intentional divergence: HEAD backfills Content-Length from the would-be body (koa; hono omits it)", () => {
  it("HEAD on a GET route", async () => {
    const app = new Keala(quiet);
    app.get("/r", (c) => c.text("body"));
    const res = await drive(app, new Request("http://x/r", { method: "HEAD" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("4");
    expect(await res.text()).toBe("");
  });
});

describe("documents intentional divergence: c.path stays percent-encoded (koa; hono decodes with decodeURI)", () => {
  it("params decode, the path does not", async () => {
    const app = new Keala(quiet);
    app.get("/r/:p", (c) => c.json({ path: c.path, p: c.params("p") }));
    const res = await drive(app, new Request("http://x/r/a%20b"));
    expect(await res.text()).toBe('{"path":"/r/a%20b","p":"a b"}');
  });
});

describe("documents intentional divergence: a custom param pattern is tested per SEGMENT (keala trie contract); hono's {…} patterns can span '/'", () => {
  it("'/file/:f(.+\\.png)' does not match multi-segment values", async () => {
    const app = new Keala(quiet);
    app.get("/file/:f(.+\\.png)", (c) =>
      c.json(paramsRecord(c.paramNames, c.paramValues, c.paramOffset)),
    );
    const nested = await drive(app, new Request("http://x/file/dir/a.png"));
    expect(nested.status).toBe(404);
    const flat = await drive(app, new Request("http://x/file/a.png"));
    expect(await flat.text()).toBe('{"f":"a.png"}');
  });
});

// ---------------------------------------------------------------------------
// Differential locks — behavior where keala and hono 4.13.5 AGREE; locked
// here so the divergences above cannot regress into equivalence bugs.
// ---------------------------------------------------------------------------
describe("differential locks: matching agrees with hono on the encoded-path matrix", () => {
  const CASES: Array<[string, string, string, number, Record<string, string> | null]> = [
    // [keala pattern, hono pattern, request path, expected status, expected params]
    ["/users/:id", "/users/:id", "/users/42", 200, { id: "42" }],
    ["/users/:id", "/users/:id", "/users/%2Fadmin", 200, { id: "/admin" }],
    ["/users/:id", "/users/:id", "/users/%252F", 200, { id: "%2F" }],
    ["/users/:id", "/users/:id", "/users/%ZZ", 200, { id: "%ZZ" }],
    ["/users/:id", "/users/:id", "/users/a+b", 200, { id: "a+b" }],
    ["/users/:id", "/users/:id", "/users/%C3%A9", 200, { id: "é" }],
    ["/users/:id", "/users/:id", "/users/a..b", 200, { id: "a..b" }],
    ["/users/:id", "/users/:id", "/USERS/42", 404, null],
    ["/users/:id", "/users/:id", "/users/a/b", 404, null],
    ["/users/:id", "/users/:id", "/users", 404, null],
    ["/users/:id(\\d+)", "/users/:id{\\d+}", "/users/42", 200, { id: "42" }],
    ["/users/:id(\\d+)", "/users/:id{\\d+}", "/users/abc", 404, null],
    ["/hex/:h([a-f0-9]+)", "/hex/:h{[a-f0-9]+}", "/hex/abc123", 200, { h: "abc123" }],
    ["/hex/:h([a-f0-9]+)", "/hex/:h{[a-f0-9]+}", "/hex/ABC", 404, null],
    ["/n/:id(\\d{2,4})", "/n/:id{\\d{2,4}}", "/n/123", 200, { id: "123" }],
    ["/n/:id(\\d{2,4})", "/n/:id{\\d{2,4}}", "/n/1", 404, null],
    ["/a;b", "/a;b", "/a;b", 200, null],
    [
      "/posts/:y(\\d{4})/:m(\\d{2})",
      "/posts/:y{\\d{4}}/:m{\\d{2}}",
      "/posts/2024/03",
      200,
      { y: "2024", m: "03" },
    ],
    ["/posts/:y(\\d{4})/:m(\\d{2})", "/posts/:y{\\d{4}}/:m{\\d{2}}", "/posts/2024/3", 404, null],
    ["/*", "/*", "/", 200, { wildcard: "" }],
    ["/*", "/*", "/a/b", 200, { wildcard: "a/b" }],
    ["/w/*", "/w/*", "/w/a/b", 200, { wildcard: "a/b" }],
    ["/w/*", "/w/*", "/w/a%2Fb", 200, { wildcard: "a/b" }],
    ["/plain/static", "/plain/static", "/plain//static", 404, null],
    ["/plain/static", "/plain/static", "/plain/static", 200, null],
  ];

  for (const [koaPath, honoPath, reqPath, status, params] of CASES) {
    it(`${koaPath} matches ${reqPath} identically on both frameworks`, async () => {
      const kApp = new Keala(quiet);
      kApp.get(koaPath, (c) => c.json(paramsRecord(c.paramNames, c.paramValues, c.paramOffset)));
      const hApp = new Hono();
      hApp.get(honoPath, (c) => c.json(c.req.param()));

      const kr = await drive(kApp, new Request(`http://x${reqPath}`));
      const hr = await hApp.fetch(new Request(`http://x${reqPath}`));
      expect(kr.status).toBe(status);
      expect(hr.status).toBe(status); // hono agrees
      if (params !== null) expect(JSON.parse(await kr.text())).toEqual(params);
    });
  }
});

describe("differential locks: middleware semantics agree with hono", () => {
  it("onion order, headers written around next(), and the handler body", async () => {
    const app = new Keala(quiet);
    app.use(async (c, next) => {
      c.setHeader("X-Mw", "1");
      await next();
      c.setHeader("X-Mw-After", "a");
    });
    app.get("/r", (c) => c.text("handler"));
    const res = await drive(app, new Request("http://x/r"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-mw")).toBe("1");
    expect(res.headers.get("x-mw-after")).toBe("a");
    expect(await res.text()).toBe("handler");
  });

  it("an early-returned Response from middleware short-circuits the route; a thrown error 500s; double next() 500s", async () => {
    const blocked = new Keala(quiet);
    let hit = false;
    blocked.use((c) => c.text("blocked", 401));
    blocked.get("/r", () => {
      hit = true;
      return new Response("nope");
    });
    const bres = await drive(blocked, new Request("http://x/r"));
    expect(bres.status).toBe(401);
    expect(await bres.text()).toBe("blocked");
    expect(hit).toBe(false);

    const throwing = new Keala(quiet);
    throwing.get("/r", () => {
      throw new Error("boom");
    });
    const tres = await drive(throwing, new Request("http://x/r"));
    expect(tres.status).toBe(500);
    expect(await tres.text()).toBe("Internal Server Error");

    const doubled = new Keala(quiet);
    doubled.use(async (_c, next) => {
      await next();
      await next();
    });
    doubled.get("/r", (c) => c.text("ok"));
    const dres = await drive(doubled, new Request("http://x/r"));
    expect(dres.status).toBe(500);
  });
});

describe("differential locks: sugar responses agree with hono where behavior is shared", () => {
  it("c.text/c.json/c.html defaults (body, status, single content-type)", async () => {
    const app = new Keala(quiet);
    app.get("/t", (c) => c.text("hi"));
    app.get("/j", (c) => c.json({ a: 1 }));
    app.get("/h", (c) => c.html("<b>x</b>"));
    app.get("/s", (c) => c.text("nope", 404));
    app.get("/e", (c) => c.text(""));
    app.get("/b", () => new Response("bare"));
    const cases: Array<[string, number, string, string | null]> = [
      ["/t", 200, "hi", "text/plain"],
      ["/j", 200, '{"a":1}', "application/json"],
      ["/h", 200, "<b>x</b>", "text/html"],
      ["/s", 404, "nope", "text/plain"],
      ["/e", 200, "", "text/plain"],
      ["/b", 200, "bare", "text/plain"],
    ];
    for (const [path, status, body, type] of cases) {
      const res = await drive(app, new Request(`http://x${path}`));
      expect(res.status).toBe(status);
      expect(await res.text()).toBe(body);
      // Bun materializes a string body's content-type only at send time —
      // absent at handle() level (documented D1); undici sets it eagerly.
      const ct = res.headers.get("content-type");
      expect(ct === null ? typeof Bun !== "undefined" : ct.startsWith(type ?? "")).toBe(true);
    }
  });

  it("multi-value set-cookie in per-call headers stays two distinct cookies", async () => {
    const app = new Keala(quiet);
    app.get("/r", (c) => c.text("hi", 200, { "set-cookie": ["a=1", "b=2"] }));
    const res = await drive(app, new Request("http://x/r"));
    expect(res.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
  });

  it('c.json(body, status, { "CONTENT-TYPE": … }) ships one content-type (json sets no default)', async () => {
    const app = new Keala(quiet);
    app.get("/r", (c) => c.json({ a: 1 }, 200, { "CONTENT-TYPE": "application/vnd.x+json" }));
    const res = await drive(app, new Request("http://x/r"));
    // Same as hono 4.13.5: the user's value replaces Response.json's default.
    expect(res.headers.get("content-type")).toBe("application/vnd.x+json");
  });

  it("a staged ARRAY header plus a per-call case-variant scalar resolves to the per-call value", async () => {
    const app = new Keala(quiet);
    app.get("/r", (c) => {
      c.setHeader("x-multi", ["1", "2"]);
      return c.text("hi", 200, { "X-Multi": "call" });
    });
    const res = await drive(app, new Request("http://x/r"));
    // Same as hono 4.13.5: the per-call scalar replaces the staged array.
    expect(res.headers.get("x-multi")).toBe("call");
  });

  it("query values decode percent-escapes and '+' like hono", async () => {
    const app = new Keala(quiet);
    app.get("/q", (c) => c.json({ a: c.query("a") }));
    for (const [qs, want] of [
      ["?a=%C3%A9", "é"],
      ["?a=b+c", "b c"],
      ["?a=%2B", "+"],
      ["?a=1;2", "1;2"],
      ["?a", ""],
      ["?a=", ""],
    ] as const) {
      const res = await drive(app, new Request(`http://x/q${qs}`));
      expect(JSON.parse(await res.text()).a).toBe(want);
    }
  });

  it("HEAD falls back to the GET handler (both frameworks); a fragment never leaks into the path", async () => {
    const app = new Keala(quiet);
    app.get("/r", (c) => c.text("body"));
    const head = await drive(app, new Request("http://x/r", { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const frag = await drive(app, new Request("http://x/r#frag?q=1"));
    expect(frag.status).toBe(200);
  });
});
