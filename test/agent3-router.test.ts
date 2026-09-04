/**
 * Agent 3 — TDD red-test bug hunt on the ROUTER domain.
 *
 * Every `it()` below asserts the CORRECT behavior (RFC 9110 semantics,
 * express/@koa-router parity, or the project's own documented invariants)
 * and FAILS against the current src/ — these are bug reports, not
 * regressions of locked behavior.
 */

import { describe, expect, it } from "vitest";

import { Keala } from "../src/core/app.ts";
import { Router } from "../src/router/group.ts";

const quiet = { env: "test" } as const;
const req = (path: string, init?: RequestInit) => new Request(`http://localhost:3000${path}`, init);

describe("agent3: redirect() destinations", () => {
  it("app.redirect() accepts an absolute-URL destination (a scheme colon is not a :param)", async () => {
    const app = new Keala(quiet);
    // "https://example.com/new".includes(":") is true (the scheme colon), so
    // redirect() feeds the whole URL to compilePattern(), which rejects it as
    // a route path. Absolute destinations are plain verbatim Locations —
    // express/koa-router pass them through untouched.
    app.redirect("/old", "https://example.com/new", 302);
    const res = await app.handle(req("/old"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://example.com/new");
  });

  it("router.redirect() accepts an absolute-URL destination with a port", async () => {
    const app = new Keala(quiet);
    const api = new Router({ prefix: "/v1" });
    api.redirect("/old", "https://example.com:8080/new", 302);
    app.mount("/api", api);
    const res = await app.handle(req("/api/v1/old"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://example.com:8080/new");
  });
});

describe("agent3: static Map vs trie equivalence", () => {
  it("a %2F request path never matches a multi-segment static route (staticMap must mirror the trie)", async () => {
    // "/admin%2Fpanel" is ONE physical segment. The trie keeps %2F inside a
    // segment (locked by trie.test.ts and router.test.ts), so the dynamic
    // sibling correctly refuses it…
    const dyn = new Keala(quiet);
    dyn.get("/admin/:page", (c) => c.text(`dyn:${c.params?.["page"]}`));
    expect((await dyn.handle(req("/admin%2Fpanel"))).status).toBe(404);

    // …but matchRoute()'s decoded retry decodes the WHOLE path before the
    // staticMap lookup, so "/admin%2Fpanel" collapses onto the key of the
    // TWO-segment static route and is served. Same request, same shape,
    // different answer depending on whether the route is static.
    const stat = new Keala(quiet);
    stat.get("/admin/panel", (c) => c.text("static"));
    expect((await stat.handle(req("/admin%2Fpanel"))).status).toBe(404);
  });
});

describe("agent3: named-route URL building", () => {
  it("url() percent-encodes wildcard values so the built URL round-trips", async () => {
    const app = new Keala(quiet);
    app.get("wild", "/w/*", (c) => c.text(c.params?.["wildcard"] ?? ""));
    // A wildcard value is user data: characters that cannot appear in a URL
    // path (space, "?", "#") must be escaped, or the built string stops
    // addressing the same resource. ("/" may stay raw — a wildcard spans
    // segments, locked by test/router.test.ts "wild" => "/w/a/b".)
    expect(app.url("wild", { wildcard: "a b?c" })).toBe("/w/a%20b%3Fc");
    const res = await app.handle(req(app.url("wild", { wildcard: "a b?c" })));
    expect(await res.text()).toBe("a b?c");
  });
});

describe("agent3: native-sink overlap detection", () => {
  it("a later JS route aliasing a sunk path through percent-escapes throws (decoded keys)", () => {
    const app = new Keala(quiet);
    app.sink("/esc%20ped", new Response("native"));
    // The sunk mirror registers under the DECODED staticMap key "/esc ped",
    // while sunkPaths stores the raw "/esc%20ped". pathsConflict() compares
    // raw strings only, so this later route — which shares the mirror's exact
    // staticMap slot and is shadowed by the native table for GET — slips
    // past the guard that exists precisely to prevent silent shadowing.
    expect(() => app.get("/esc ped", (c) => c.text("js"))).toThrow(/overlaps natively-sunk/);
  });
});

describe("agent3: mount() merges websocket registrations", () => {
  it("mount() carries the sub-app's ws routes under the prefix (the upgrade stays servable)", async () => {
    const sub = new Keala(quiet);
    sub.ws("/chat", { open() {} });
    const app = new Keala(quiet);
    app.mount("/ws", sub);
    // mount() copies the sub-app's ALL-route (the upgrade handler), so
    // "GET /ws/chat" dispatches wsUpgradeHandler("/chat") — but the wsRoutes
    // map is not merged, so the serving app's adapter can never find the
    // socket handlers: the upgrade succeeds and the socket silently does
    // nothing. Either merge (re-keyed) or refuse ws-bearing apps at mount.
    expect((await app.handle(req("/ws/chat"))).status).toBe(501); // route mounted…
    expect(app.wsRoutes.has("/ws/chat")).toBe(true); // …handlers unreachable
  });
});

describe("agent3: mount() and param middleware ordering", () => {
  it("a param middleware merged by mount() reaches the parent's existing routes too", async () => {
    const app = new Keala(quiet);
    app.get("/old/:oid", (c) => c.text("parent"));
    const api = new Router();
    api.param("oid", async (c, next) => {
      c.setHeader("X-Org", c.params?.["oid"] ?? "");
      await next();
    });
    api.get("/orgs/:oid", (c) => c.text("sub"));
    app.mount("/api", api);
    // The sub's param middleware lands in the PARENT router's paramMiddlewares
    // map (same mutation app.param() makes, whose contract is "existing routes
    // capturing this param pick it up on rebuild"). mount() skips the rebuild,
    // so a parent route registered BEFORE the mount silently misses it…
    const before = await app.handle(req("/old/acme"));
    expect(before.headers.get("x-org")).toBe("acme");
    // …while a parent route registered AFTER the same mount picks it up —
    // the inconsistency is what marks this as a bug rather than a scope rule.
    app.get("/late/:oid", (c) => c.text("late"));
    const after = await app.handle(req("/late/acme"));
    expect(after.headers.get("x-org")).toBe("acme");
    // The mounted router's own routes are unaffected (sanity).
    expect((await app.handle(req("/api/orgs/acme"))).headers.get("x-org")).toBe("acme");
  });
});

describe("agent3: regression probes for adjacent behavior (green today)", () => {
  it("optional params backtrack mid-path", async () => {
    const app = new Keala(quiet);
    app.get("/users/:id?/posts", (c) => c.text(`id=${c.params?.["id"] ?? "-"}`));
    expect(await (await app.handle(req("/users/9/posts"))).text()).toBe("id=9");
    expect(await (await app.handle(req("/users/posts"))).text()).toBe("id=-");
    expect((await app.handle(req("/users"))).status).toBe(404);
  });

  it("static beats param across a mount boundary", async () => {
    const app = new Keala(quiet);
    const api = new Router();
    api.get("/:id", (c) => c.text(`param:${c.params?.["id"]}`));
    app.mount("/api", api);
    app.get("/api/list", (c) => c.text("static"));
    expect(await (await app.handle(req("/api/list"))).text()).toBe("static");
    expect(await (await app.handle(req("/api/7"))).text()).toBe("param:7");
    expect(await (await app.handle(req("/api/7/"))).text()).toBe("param:7");
  });

  it("fast matcher and trie agree on %2F inside a captured param", async () => {
    const app = new Keala(quiet);
    app.get("/users/:id", (c) => c.text(c.params?.["id"] ?? ""));
    app.get("/users/:id/posts/:tid", (c) => c.text(`${c.params?.["id"]}/${c.params?.["tid"]}`));
    expect(await (await app.handle(req("/users/a%2Fb"))).text()).toBe("a/b");
    expect(await (await app.handle(req("/users/a%2Fb/posts/c%2Fd"))).text()).toBe("a/b/c/d");
  });

  it("escaped literals in static routes match their encoded form", async () => {
    const app = new Keala(quiet);
    app.get("/a%3Fb", (c) => c.text("q"));
    app.get("/caf%C3%A9", (c) => c.text("coffee"));
    expect(await (await app.handle(req("/a%3Fb"))).text()).toBe("q");
    expect(await (await app.handle(req("/caf%C3%A9"))).text()).toBe("coffee");
  });
});
