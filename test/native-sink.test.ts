/**
 * nativeSink tests: sink guards (loud refusals), the JS mirror semantics
 * (portable across runtimes), and the adapter's native routes table.
 */

import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// globalThis.Bun is non-writable AND non-configurable on the real Bun
// runtime — these suites stub it, so they run on the Node gate only (the
// real-runtime equivalents live in scripts/smoke.ts).
const REAL_BUN = typeof Bun !== "undefined";

import {
  Keala,
  startBunServer,
  noOpFor,
  createError,
  type RouteHandler,
  type ServeImplementation,
} from "../src/index.ts";
import { bodyLimit } from "../src/middleware/limits.ts";
import { buildNativeRoutes } from "../src/core/sink.ts";
import { patternsOverlap } from "../src/router/pattern.ts";
import { sunkErrorResponse } from "../src/core/error-response.ts";
import {
  compileMiddlewareScope,
  noOpExcuses,
  scopeOverlapsPath,
} from "../src/core/middleware-stack.ts";

const quiet = { env: "test" } as const;
const req = (path: string, init?: RequestInit) => new Request(`http://localhost:3000${path}`, init);

let root = "";
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "bk-sink-"));
  await writeFile(join(root, "app.js"), "console.log(1)");
  await writeFile(join(root, "index.html"), "<h1>i</h1>");
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("sink: guard matrix (every refusal is loud)", () => {
  it("rejects non-absolute and empty paths", () => {
    const app = new Keala(quiet);
    expect(() => app.sink("health", new Response("ok"))).toThrow(/absolute path/);
    expect(() => app.sink("", new Response("ok"))).toThrow(/absolute path/);
  });

  it("rejects values that are neither Response nor { dir }", () => {
    const app = new Keala(quiet);
    // @ts-expect-error -- runtime contract check for JS callers
    expect(() => app.sink("/health", "ok")).toThrow(/Response.*\{ dir \}.*handler/);
  });

  it("rejects duplicate sinks of the same path", () => {
    const app = new Keala(quiet);
    app.sink("/health", new Response("ok"));
    expect(() => app.sink("/health", new Response("again"))).toThrow(/already registered/);
  });

  it("rejects static sinks on param/wildcard paths", () => {
    const app = new Keala(quiet);
    expect(() => app.sink("/users/:id", new Response("ok"))).toThrow(/plain paths/);
    expect(() => app.sink("/assets/*", new Response("ok"))).toThrow(/plain paths/);
  });

  it("rejects dir sinks without a /* suffix and empty dir values", () => {
    const app = new Keala(quiet);
    expect(() => app.sink("/assets", { dir: root })).toThrow(/\/\*/);
    expect(() => app.sink("/assets/*", { dir: "" })).toThrow(/directory path/);
  });

  it("rejects sinking when global middleware exists (it would be bypassed)", () => {
    const app = new Keala(quiet);
    app.use((_c, next) => next());
    expect(() => app.sink("/health", new Response("ok"))).toThrow(/without global middleware/);
  });

  it("rejects app.use(fn) after a sink exists (ordering invariants are bidirectional)", () => {
    const app = new Keala(quiet);
    app.sink("/health", new Response("ok"));
    expect(() => app.use((_c, next) => next())).toThrow(/alongside sunk routes/);
  });

  it("rejects app.param() after a sink exists", () => {
    const app = new Keala(quiet);
    app.sink("/health", new Response("ok"));
    expect(() => app.param("id", (_c, next) => next())).toThrow(/bypasses param middleware/);
  });

  it("rejects sinking when param middleware exists", () => {
    const app = new Keala(quiet);
    app.param("id", (_c, next) => next());
    expect(() => app.sink("/users/1", new Response("ok"))).toThrow(/without param middleware/);
  });

  it("rejects a sink overlapping an existing JS route (both directions)", () => {
    const direct = new Keala(quiet);
    direct.get("/health", (c) => c.text("js"));
    expect(() => direct.sink("/health", new Response("native"))).toThrow(/overlaps/);

    const subtree = new Keala(quiet);
    subtree.get("/assets/logo.png", (c) => c.text("js"));
    expect(() => subtree.sink("/assets/*", { dir: root })).toThrow(/overlaps/);
  });

  it("rejects JS routes registered AFTER a sink (native table would shadow them)", () => {
    const app = new Keala(quiet);
    app.sink("/health", new Response("ok"));
    expect(() => app.get("/health", (c) => c.text("js"))).toThrow(/natively-sunk/);
    // A deeper path is a different route — no shadowing, no refusal.
    expect(() => app.get("/health/x", (_c) => undefined)).not.toThrow();
    expect(() => app.ws("/health", { open: () => undefined })).toThrow(/natively-sunk/);
  });

  it("rejects mount() introducing param middleware alongside sinks", () => {
    const sub = new Keala(quiet);
    sub.param("id", (_c, next) => next());
    sub.get("/x/:id", (c) => c.text("x"));
    const app = new Keala(quiet);
    app.sink("/health", new Response("ok"));
    expect(() => app.mount("/m", sub)).toThrow(/param middleware alongside sunk/);

    const clean = new Keala(quiet);
    clean.get("/y", (c) => c.text("y"));
    expect(() => app.mount("/n", clean)).not.toThrow();
  });

  it("a 205 null-body sunk response survives the rebuild", async () => {
    const app = new Keala(quiet);
    app.sink("/reset", new Response(null, { status: 205 }));
    const res = await app.handle(req("/reset"));
    expect(res.status).toBe(205);
    expect(await res.text()).toBe("");
  });

  it("sibling subtrees and unrelated paths never conflict", () => {
    const app = new Keala(quiet);
    app.sink("/health", new Response("ok"));
    app.get("/users/:id", (c) => c.text("u"));
    app.sink("/assets/*", { dir: root });
    app.get("/assetx", (c) => c.text("x"));
    expect(app.stack.length).toBeGreaterThan(0);
  });

  it("function sinks refuse unsupported pattern shapes loudly", () => {
    const app = new Keala(quiet);
    expect(() => app.sink("/users/:id?", () => new Response("x"))).toThrow(/plain ":param"/);
    expect(() => app.sink("/users/:id(\\d+)", () => new Response("x"))).toThrow(/plain ":param"/);
    expect(() => app.sink("/files/*", () => new Response("x"))).toThrow(/plain ":param"/);
    expect(() => app.sink("/a%2Fb", () => new Response("x"))).toThrow(/percent-encoded/);
    expect(() => app.sink("/dup", () => new Response("x"))).not.toThrow();
    expect(() => app.sink("/dup", () => new Response("x"))).toThrow(/already registered/);
  });

  it("param sinks and literal JS routes shadow-refuse in BOTH directions", () => {
    const sinkFirst = new Keala(quiet);
    sinkFirst.sink("/users/:id", () => new Response("sunk"));
    expect(() => sinkFirst.get("/users/admin", (c) => c.text("js"))).toThrow(
      /overlaps natively-sunk/,
    );
    const routeFirst = new Keala(quiet);
    routeFirst.get("/users/admin", (c) => c.text("js"));
    expect(() => routeFirst.sink("/users/:id", () => new Response("sunk"))).toThrow(
      /overlaps an existing/,
    );
    // Param-vs-param shapes are equally a shadow risk.
    const paramFirst = new Keala(quiet);
    paramFirst.get("/users/:uid", (c) => c.text("js"));
    expect(() => paramFirst.sink("/users/:id", () => new Response("sunk"))).toThrow(
      /overlaps an existing/,
    );
  });

  it("function sinks and app.onError() are mutually exclusive, both orders", () => {
    const mapperFirst = new Keala(quiet);
    mapperFirst.onError(() => new Response("mapped"));
    expect(() => mapperFirst.sink("/users/:id", () => new Response("x"))).toThrow(/onError/);
    const sinkFirst = new Keala(quiet);
    sinkFirst.sink("/users/:id", () => new Response("x"));
    expect(() => sinkFirst.onError(() => new Response("mapped"))).toThrow(/onError/);
    // Static sinks cannot throw — the mapper stays legal next to them.
    const staticSink = new Keala(quiet);
    staticSink.sink("/health", new Response("ok"));
    expect(() => staticSink.onError(() => new Response("mapped"))).not.toThrow();
  });

  it("noOpFor-excused middleware sinks alongside, undeclared does not", () => {
    // Excused (bodyLimit declares itself bodyless-transparent): both orders.
    const sinkFirst = new Keala(quiet);
    sinkFirst.sink("/health", new Response("ok"));
    expect(() => sinkFirst.use(bodyLimit(1024))).not.toThrow();
    const useFirst = new Keala(quiet);
    useFirst.use(bodyLimit(1024));
    expect(() => useFirst.sink("/health", new Response("ok"))).not.toThrow();
    // A plain fn is not excused.
    const plain = new Keala(quiet);
    plain.sink("/health", new Response("ok"));
    expect(() => plain.use((_c, next) => next())).toThrow(/noOpFor/);
    // A methods:["GET"] declaration excuses a GET-serving sink.
    const methodDeclared = new Keala(quiet);
    methodDeclared.use(noOpFor((_c, next) => next(), { methods: ["get"] }));
    expect(() => methodDeclared.sink("/health", new Response("ok"))).not.toThrow();
    // Scoped layers follow the same rule.
    const scoped = new Keala(quiet);
    scoped.use("/health", bodyLimit(1024));
    expect(() => scoped.sink("/health", new Response("ok"))).not.toThrow();
    const scopedPlain = new Keala(quiet);
    scopedPlain.use("/health", (_c, next) => next());
    expect(() => scopedPlain.sink("/health", new Response("ok"))).toThrow(
      /conflicts with \/health middleware/,
    );
  });

  it("noOpFor validates its declaration", () => {
    const fn: RouteHandler = (_c, next) => next();
    expect(() => noOpFor(fn, {})).toThrow(/methods, bodyless, or both/);
    expect(() => noOpFor(fn, { methods: [] })).toThrow(/methods, bodyless, or both/);
    expect(() => noOpFor(fn, { methods: [""] })).toThrow(/non-empty strings/);
    expect(() => noOpFor(fn, { methods: ["GET"] })).not.toThrow();
  });
});

describe("sink: JS mirror (runtime-portable serving)", () => {
  it("serves the sunk response body, status and headers repeatedly", async () => {
    const app = new Keala(quiet);
    app.sink("/health", new Response("ok", { status: 200, headers: { "x-sunk": "yes" } }));
    for (let i = 0; i < 3; i++) {
      const res = await app.handle(req("/health"));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
      expect(res.headers.get("x-sunk")).toBe("yes");
    }
  });

  it("HEAD reuses the GET mirror (empty body, same status)", async () => {
    const app = new Keala(quiet);
    app.sink("/health", new Response("ok"));
    const res = await app.handle(new Request("http://localhost:3000/health", { method: "HEAD" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("non-GET methods answer 405 with the allowed set", async () => {
    const app = new Keala(quiet);
    app.sink("/health", new Response("ok"));
    const res = await app.handle(new Request("http://localhost:3000/health", { method: "POST" }));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toContain("GET");
  });

  it("a null-body (204) sunk response survives the rebuild", async () => {
    const app = new Keala(quiet);
    app.sink("/noop", new Response(null, { status: 204 }));
    const res = await app.handle(req("/noop"));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("multi-value headers (Set-Cookie) survive the rebuild", async () => {
    const headers = new Headers();
    headers.append("set-cookie", "a=1");
    headers.append("set-cookie", "b=2");
    const app = new Keala(quiet);
    app.sink("/sweet", new Response("ok", { headers }));
    const res = await app.handle(req("/sweet"));
    expect(res.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
  });

  it("the sunk Response instance stays unconsumed for the native table", async () => {
    const response = new Response("precious");
    const app = new Keala(quiet);
    app.sink("/health", response);
    await app.handle(req("/health"));
    // The native table reuses THIS instance; a consumed body would 500 there.
    expect(await response.text()).toBe("precious");
  });

  it("dir sinks mirror to serveStatic semantics (index, 404, traversal denial)", async () => {
    const app = new Keala(quiet);
    app.sink("/assets/*", { dir: root });
    expect((await app.handle(req("/assets/app.js"))).status).toBe(200);
    expect((await app.handle(req("/assets/"))).status).toBe(200); // index.html
    expect((await app.handle(req("/assets/missing.js"))).status).toBe(404);
    const escape = await app.handle(req("/assets/..%2f..%2fetc%2fpasswd"));
    expect([403, 404]).toContain(escape.status);
  });
});

describe("sink: native routes table (adapter)", () => {
  const fakeServe = (captured: { options: Record<string, unknown> }): ServeImplementation => {
    return (_options) => {
      captured.options = _options;
      return {
        port: 0,
        hostname: "localhost",
        stop: () => undefined,
        fetch: async () => new Response("fake"),
        reload: () => undefined,
      };
    };
  };

  it("builds the table with Response entries and {dir} entries", () => {
    const app = new Keala(quiet);
    const health = new Response("ok");
    app.sink("/health", health);
    app.sink("/assets/*", { dir: root });
    const routes = buildNativeRoutes(app.nativeSinks);
    // Method-scoped: a bare key would answer POST with the sunk response
    // (verified against Bun 1.4) while the JS mirror answers 405.
    expect(routes["/health"]).toEqual({ GET: health });
    expect(routes["/assets/*"]).toEqual({ GET: { dir: root } });
  });

  it("startBunServer embeds the routes table and honors nativeRoutes: false", () => {
    const app = new Keala(quiet);
    app.sink("/health", new Response("ok"));

    const withTable: { options: Record<string, unknown> } = { options: {} };
    startBunServer(app, { port: 0 }, undefined, fakeServe(withTable));
    expect((withTable.options["routes"] as Record<string, unknown>)["/health"]).toBeDefined();

    const withoutTable: { options: Record<string, unknown> } = { options: {} };
    startBunServer(app, { port: 0, nativeRoutes: false }, undefined, fakeServe(withoutTable));
    expect(withoutTable.options["routes"]).toBeUndefined();
  });

  it("an app without sinks gets no routes key", () => {
    const app = new Keala(quiet);
    app.get("/x", (c) => c.text("x"));
    const captured: { options: Record<string, unknown> } = { options: {} };
    startBunServer(app, { port: 0 }, undefined, fakeServe(captured));
    expect(captured.options["routes"]).toBeUndefined();
  });

  it("reloadNativeRoutes throws before listen()", () => {
    const app = new Keala(quiet);
    app.sink("/health", new Response("ok"));
    expect(() => app.reloadNativeRoutes()).toThrow(/app\.listen/);
  });

  it.skipIf(REAL_BUN)(
    "sinking after listen() hot-reloads the table; reloadNativeRoutes works",
    async () => {
      const originalBun = (globalThis as { Bun?: unknown }).Bun;
      const reloads: unknown[] = [];
      const impl: ServeImplementation = (_options) => {
        return {
          port: 0,
          hostname: "localhost",
          stop: () => undefined,
          fetch: async () => new Response("fake"),
          reload: (next) => reloads.push(next),
        };
      };
      (globalThis as { Bun?: unknown }).Bun = { serve: impl };
      try {
        const app = new Keala(quiet);
        const server = app.listen(0);
        expect(reloads.length).toBe(0);
        app.sink("/health", new Response("ok"));
        expect(reloads.length).toBe(1);
        expect((reloads[0] as Record<string, unknown>)["routes"]).toBeDefined();
        app.reloadNativeRoutes();
        expect(reloads.length).toBe(2);
        server.stop();

        // The opt-out is sticky: sinks after listen({nativeRoutes: false})
        // must NOT silently install a native table later.
        const optOut = new Keala(quiet);
        const optServer = optOut.listen({ port: 0, nativeRoutes: false });
        optOut.sink("/ping", new Response("pong"));
        expect(reloads.length).toBe(2); // no new reload
        expect(() => optOut.reloadNativeRoutes()).toThrow(/nativeRoutes: false/);
        expect((await optOut.handle(req("/ping"))).status).toBe(200); // JS mirror still serves
        optServer.stop();
      } finally {
        if (originalBun === undefined) delete (globalThis as { Bun?: unknown }).Bun;
        else (globalThis as { Bun?: unknown }).Bun = originalBun;
      }
    },
  );
});

describe("sink: unit contracts for the native-only machinery", () => {
  it("patternsOverlap detects param-vs-literal and param-vs-param shadows", () => {
    // Shadows (some URL matches both).
    expect(patternsOverlap("/users/:id", "/users/admin")).toBe(true);
    expect(patternsOverlap("/users/admin", "/users/:id")).toBe(true);
    expect(patternsOverlap("/users/:id", "/users/:uid")).toBe(true);
    expect(patternsOverlap("/users/:id/posts/:pid", "/users/a/posts/b")).toBe(true);
    expect(patternsOverlap("/a/*", "/a/b/c")).toBe(true);
    expect(patternsOverlap("/a/*", "/a")).toBe(true); // bare-prefix twin rule
    expect(patternsOverlap("/users/:id?", "/users")).toBe(true); // optional may collapse
    // Disjoint shapes.
    expect(patternsOverlap("/users/:id", "/health")).toBe(false);
    expect(patternsOverlap("/users/:id", "/assetx")).toBe(false);
    expect(patternsOverlap("/a/*", "/b/c")).toBe(false);
    // Unparseable input reports overlap (callers refuse loudly).
    expect(patternsOverlap("not-a-path", "/x")).toBe(true);
  });

  it("the native fn wrapper keeps sync sync and funnels every failure", async () => {
    const app = new Keala(quiet);
    app.sink("/ok", (_request, params) => new Response(`v:${params["id"] ?? "-"}`));
    app.sink("/slow", async () => new Response("later"));
    app.sink("/boom", () => {
      throw createError(418, "teapot", { expose: true });
    });
    app.sink("/rejects", async () => {
      throw new Error("hidden");
    });
    // @ts-expect-error -- runtime contract check for JS callers
    app.sink("/bad", () => "not-a-response");
    const routes = buildNativeRoutes(app.nativeSinks) as Record<
      string,
      { GET: (request: Request) => Response | Promise<Response> }
    >;
    const requestFor = (path: string, params?: Record<string, string>): Request => {
      const request = new Request(`http://localhost:3000${path}`);
      if (params !== undefined) {
        (request as Request & { params?: Record<string, string> }).params = params;
      }
      return request;
    };
    const routeAt = (path: string): { GET: (request: Request) => Response | Promise<Response> } =>
      routes[path] as { GET: (request: Request) => Response | Promise<Response> };
    expect(routeAt("/ok").GET(requestFor("/ok/7", { id: "7" }))).toBeInstanceOf(Response);
    expect(await (await routeAt("/slow").GET(requestFor("/slow"))).text()).toBe("later");
    const thrown = routeAt("/boom").GET(requestFor("/boom")) as Response;
    expect([thrown.status, await thrown.text()]).toEqual([418, "teapot"]);
    const rejected = await routeAt("/rejects").GET(requestFor("/rejects"));
    expect([rejected.status, await rejected.text()]).toEqual([500, "Internal Server Error"]);
    const bad = await routeAt("/bad").GET(requestFor("/bad"));
    expect([bad.status, await bad.text(), bad.headers.get("content-type")]).toEqual([
      500,
      "Internal Server Error",
      "text/plain; charset=utf-8",
    ]);
  });

  it("sunkErrorResponse mirrors the builtin funnel byte for byte", async () => {
    const exposed = sunkErrorResponse("GET", createError(404, "no such user", { expose: true }));
    expect([exposed.status, await exposed.text()]).toEqual([404, "no such user"]);
    expect(exposed.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    // Hidden errors never leak the message.
    const hidden = sunkErrorResponse("GET", new Error("secret"));
    expect([hidden.status, await hidden.text()]).toEqual([500, "Internal Server Error"]);
    // HEAD stays bodiless even for exposed errors.
    const head = sunkErrorResponse("HEAD", createError(418, "teapot", { expose: true }));
    expect([head.status, head.body]).toEqual([418, null]);
    // Error-declared headers ride along.
    const decorated = sunkErrorResponse(
      "GET",
      createError(400, "bad", { expose: true, headers: { "x-reason": "sink" } }),
    );
    expect(decorated.headers.get("x-reason")).toBe("sink");
  });

  it("scoped middleware overlapping a PARAM sink refuses with the sink error (B1/B2 regression)", () => {
    const app = new Keala(quiet);
    app.use("/users/*", (_c, next) => next());
    // B1 regression: used to throw "app.use() scope must be a static path".
    expect(() => app.sink("/users/:id", () => new Response("u"))).toThrow(
      /conflicts with \/users\/\* middleware/,
    );
    const reverse = new Keala(quiet);
    reverse.sink("/users/:id", () => new Response("u"));
    expect(() => reverse.use("/users/*", (_c, next) => next())).toThrow(
      /overlaps natively-sunk \/users\/:id/,
    );
  });
});

describe("sink: transparency predicate edges", () => {
  it("a bodyless declaration does not excuse non-bodyless methods", () => {
    const layer: RouteHandler = noOpFor((_c, next) => next(), { bodyless: true });
    expect(noOpExcuses(layer, new Set(["GET"]))).toBe(true);
    expect(noOpExcuses(layer, new Set(["GET", "HEAD"]))).toBe(true);
    expect(noOpExcuses(layer, new Set(["POST"]))).toBe(false);
    expect(noOpExcuses((_c, next) => next(), new Set(["GET"]))).toBe(false);
  });

  it("an exact scope overlaps an optional-tail route that can collapse to it", () => {
    expect(scopeOverlapsPath(compileMiddlewareScope("/users"), "/users/:id?")).toBe(true);
    expect(scopeOverlapsPath(compileMiddlewareScope("/users"), "/users/:id")).toBe(false);
  });

  it("a root directory sink mirrors onto the bare root route", async () => {
    const app = new Keala(quiet);
    app.sink("/*", { dir: root });
    const res = await app.handle(req("/app.js"));
    expect([res.status, await res.text()]).toEqual([200, "console.log(1)"]);
  });
});
