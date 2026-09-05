import { describe, expect, it } from "vitest";

import { Keala } from "../../src/core/app.ts";
import { Router } from "../../src/router/group.ts";
/**
 * Hybrid router through the app surface: static Map path, bucket fast
 * matchers, trie fallback, 405/Allow/OPTIONS/501, duplicates, mounts,
 * named-route URL building, redirects and param middleware.
 */

const quiet = { env: "test" } as const;
const req = (path: string, init?: RequestInit) => new Request(`http://localhost:3000${path}`, init);

const appWith = (setup: (app: InstanceType<typeof Keala>) => void) => {
  const app = new Keala(quiet);
  setup(app);
  return (path: string, init?: RequestInit) => app.handle(req(path, init));
};

describe("router: matching layers", () => {
  it("static paths hit the exact Map (including trailing-slash retry)", async () => {
    const request = appWith((app) => {
      app.get("/page", (c) => c.text("page"));
    });
    expect((await request("/page")).status).toBe(200);
    expect((await request("/page/")).status).toBe(200);
    expect((await request("/pages")).status).toBe(404);
  });

  it("simple param routes take the bucket fast matcher", async () => {
    const request = appWith((app) => {
      app.get("/users/:id", (c) => c.text(`user ${c.params("id")}`));
    });
    expect(await (await request("/users/42")).text()).toBe("user 42");
    expect((await request("/users")).status).toBe(404);
    expect((await request("/users/1/posts")).status).toBe(404);
    expect((await request("/users/")).status).toBe(404);
  });

  it("multi-pattern buckets fall back to the trie with static-over-param order", async () => {
    const request = appWith((app) => {
      app.get("/shop/*", (c) => c.text("wildcard"));
      app.get("/shop/:name", (c) => c.text(`param:${c.params("name")}`));
      app.get("/shop/new", (c) => c.text("static"));
      app.get("/shop/:name/price", (c) => c.text(`price:${c.params("name")}`));
    });
    expect(await (await request("/shop/new")).text()).toBe("static");
    expect(await (await request("/shop/abc")).text()).toBe("param:abc");
    expect(await (await request("/shop/abc/price")).text()).toBe("price:abc");
    expect(await (await request("/shop/a/b/c")).text()).toBe("wildcard");
  });

  it("complex shapes (optionals, patterns, wildcards) always work", async () => {
    const request = appWith((app) => {
      app.get("/files/:name?", (c) => c.text(c.params("name") ?? "index"));
      app.get("/n/:num(\\d+)", (c) => c.text(c.params("num") ?? ""));
      app.get("/hex/:h([0-9a-f]+)", (c) => c.text(c.params("h") ?? ""));
    });
    expect(await (await request("/files")).text()).toBe("index");
    expect(await (await request("/files/f.txt")).text()).toBe("f.txt");
    expect((await request("/n/abc")).status).toBe(404);
    expect(await (await request("/n/77")).text()).toBe("77");
    expect(await (await request("/hex/deadbeef")).text()).toBe("deadbeef");
    expect((await request("/hex/XYZ")).status).toBe(404);
  });

  it("encoding: captured params decode; %2F stays one segment; case-sensitive", async () => {
    const request = appWith((app) => {
      app.get("/users/:name", (c) => c.text(c.params("name") ?? ""));
      app.get("/Case", (c) => c.text("exact"));
    });
    expect(await (await request("/users/%E4%B8%AD")).text()).toBe("中");
    expect(await (await request("/users/a%20b")).text()).toBe("a b");
    expect(await (await request("/users/%2F")).text()).toBe("/");
    expect(await (await request("/users/a+b")).text()).toBe("a+b");
    expect((await request("/case")).status).toBe(404);
    expect((await request("/Case")).status).toBe(200);
  });

  it("fast-matcher static heads match on segment boundaries only", async () => {
    const request = appWith((app) => {
      app.get("/v1/users/:id", (c) => c.text(`u:${c.params("id")}`));
      app.get("/v1/u/:x/:y", (c) => c.text(`${c.params("x")}/${c.params("y")}`));
    });
    expect(await (await request("/v1/users/7")).text()).toBe("u:7");
    // prefix "/v1/users" must not capture "/v1/usersXYZ/5"
    expect((await request("/v1/usersXYZ/5")).status).toBe(404);
    // prefix "/v1/u" must not capture "/v1/ux/1" (boundary violation)
    expect((await request("/v1/ux/1")).status).toBe(404);
    expect(await (await request("/v1/u/1/2")).text()).toBe("1/2");
  });
});

describe("router: methods, 405/Allow/501/OPTIONS", () => {
  const methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

  it.each(methods)("%s-only routes answer 405 to the others", async (method) => {
    const request = appWith((app) => {
      app.on(method.toLowerCase(), "/only", (c) => c.text(method));
    });
    const hit = await request("/only", { method });
    expect(hit.status).toBe(200);
    for (const other of methods) {
      if (other === method || other === "OPTIONS") continue;
      if (method === "GET" && other === "HEAD") continue; // HEAD falls back to GET
      const miss = await request("/only", { method: other });
      expect(miss.status).toBe(405);
      expect(miss.headers.get("allow")).toContain(method);
    }
    const options = await request("/only", { method: "OPTIONS" });
    expect(options.status).toBe(200);
    // An explicit OPTIONS route answers itself; the synthesized Allow only
    // appears when no OPTIONS handler exists.
    if (method !== "OPTIONS") expect(options.headers.get("allow")).toContain(method);
  });

  it.each(["PROPFIND", "MKCOL", "REPORT", "CHECKOUT"])("%s yields 501", async (method) => {
    const request = appWith((app) => {
      app.get("/x", (c) => c.text("x"));
    });
    expect((await request("/x", { method })).status).toBe(501);
  });

  it("GET routes advertise HEAD in Allow (koa-router convention)", async () => {
    const request = appWith((app) => {
      app.get("/g", (c) => c.text("g"));
    });
    const miss = await request("/g", { method: "DELETE" });
    expect(miss.headers.get("allow")).toBe("HEAD, GET");
  });

  it("Allow order is canonical regardless of registration order", async () => {
    // Re-homed from the retired koa differential (U1): POST registered first
    // must not make Allow read "POST, HEAD, GET".
    const request = appWith((app) => {
      app.post("/g", (c) => c.text("p"));
      app.get("/g", (c) => c.text("g"));
    });
    const miss = await request("/g", { method: "PUT" });
    expect(miss.headers.get("allow")).toBe("HEAD, GET, POST");
  });

  it("an explicit OPTIONS route handles the request itself", async () => {
    const request = appWith((app) => {
      app.options("/o", (c) => c.text("custom-options"));
    });
    const res = await request("/o", { method: "OPTIONS" });
    expect(await res.text()).toBe("custom-options");
  });

  it("lowercase method registration is accepted (app.on)", async () => {
    const request = appWith((app) => {
      app.on("post", "/lc", (c) => c.text("posted"));
    });
    expect((await request("/lc", { method: "POST" })).status).toBe(200);
  });

  it("all() answers every method", async () => {
    const request = appWith((app) => {
      app.all("/any", (c) => c.text("any"));
    });
    for (const method of ["GET", "POST", "PUT", "DELETE"]) {
      expect((await request("/any", { method })).status).toBe(200);
    }
  });
});

describe("router: registration behaviors", () => {
  it("duplicate path+method registrations chain in registration order", async () => {
    const request = appWith((app) => {
      app.get("/dup", async (c, next) => {
        c.setHeader("X-First", "1");
        await next();
      });
      app.get("/dup", (c) => c.text("second"));
    });
    const res = await request("/dup");
    expect(res.headers.get("x-first")).toBe("1");
    expect(await res.text()).toBe("second");
  });

  it("route handlers run as an onion in registration order", async () => {
    const order: string[] = [];
    const request = appWith((app) => {
      app.get(
        "/chain",
        async (_c, next) => {
          order.push("mw1-before");
          await next();
          order.push("mw1-after");
        },
        async (_c, next) => {
          order.push("mw2-before");
          await next();
          order.push("mw2-after");
        },
        (c) => {
          order.push("leaf");
          return c.text("done");
        },
      );
    });
    await request("/chain");
    expect(order).toEqual(["mw1-before", "mw2-before", "leaf", "mw2-after", "mw1-after"]);
  });

  it("named routes build URLs (encoding, optionals, wildcards)", () => {
    const app = new Keala(quiet);
    app.get("user", "/users/:id(\\d+)", () => undefined);
    app.get("file", "/files/:name?", () => undefined);
    app.get("wild", "/w/*", () => undefined);
    expect(app.url("user", { id: "1" })).toBe("/users/1");
    expect(app.url("file", {})).toBe("/files");
    expect(app.url("file", { name: "中文.txt" })).toBe("/files/%E4%B8%AD%E6%96%87.txt");
    expect(app.url("wild", { wildcard: "a/b" })).toBe("/w/a/b");
    expect(() => app.url("user", {})).toThrow(/Missing required parameter/);
    expect(() => app.url("ghost", {})).toThrow(/No route registered/);
  });

  it("app.redirect emits a GET redirect route (param substitution included)", async () => {
    const app = new Keala(quiet);
    app.get("/users/:id", (c) => c.text("u"));
    app.redirect("/u/:id", "/users/:id", 302);
    const res = await app.handle(req("/u/9"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/users/9");
  });
});

describe("router: groups and mounts", () => {
  it("prefix groups, nesting and fallthrough", async () => {
    const app = new Keala(quiet);
    const users = new Router();
    users.get("/:id", (c) => c.text(`user ${c.params("id")}`));
    users.get("/", (c) => c.text("index"));
    app.mount("/v1/users", users);
    app.get("/v1/admin/panel", (c) => c.text("panel"));
    expect(await (await app.handle(req("/v1/users/42"))).text()).toBe("user 42");
    expect(await (await app.handle(req("/v1/users"))).text()).toBe("index");
    expect(await (await app.handle(req("/v1/admin/panel"))).text()).toBe("panel");
    expect((await app.handle(req("/v1/missing"))).status).toBe(404);
    expect((await app.handle(req("/users"))).status).toBe(404);
  });

  it("router.use middleware applies to the group's routes only", async () => {
    const app = new Keala(quiet);
    const api = new Router();
    api.use(async (c, next) => {
      c.setHeader("X-Api", "1");
      await next();
    });
    api.get("/inside", (c) => c.text("in"));
    app.mount("/api", api);
    app.get("/outside", (c) => c.text("out"));
    expect((await app.handle(req("/api/inside"))).headers.get("x-api")).toBe("1");
    expect((await app.handle(req("/outside"))).headers.get("x-api")).toBeNull();
  });

  it("router.param middleware applies to capturing routes in the group", async () => {
    const app = new Keala(quiet);
    const api = new Router();
    api.param("oid", async (c, next) => {
      c.setHeader("X-Org", c.params("oid") ?? "");
      await next();
    });
    api.get("/orgs/:oid", (c) => c.text("org"));
    api.get("/others/:x", (c) => c.text("other"));
    app.mount("/api", api);
    const res = await app.handle(req("/api/orgs/acme"));
    expect(res.headers.get("x-org")).toBe("acme");
    expect((await app.handle(req("/api/others/1"))).headers.get("x-org")).toBeNull();
  });

  it("an array of routes shares handlers", async () => {
    const app = new Keala(quiet);
    for (const path of ["/a", "/b"]) app.get(path, (c) => c.text(`hit:${c.path}`));
    expect(await (await app.handle(req("/a"))).text()).toBe("hit:/a");
    expect(await (await app.handle(req("/b"))).text()).toBe("hit:/b");
  });
});

/**
 * Agent 3 — TDD red-test bug hunt on the ROUTER domain.
 *
 * Every `it()` below asserts the CORRECT behavior (RFC 9110 semantics,
 * express/@koa-router parity, or the project's own documented invariants)
 * and FAILS against the current src/ — these are bug reports, not
 * regressions of locked behavior.
 */

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
    dyn.get("/admin/:page", (c) => c.text(`dyn:${c.params("page")}`));
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
    app.get("wild", "/w/*", (c) => c.text(c.params("wildcard") ?? ""));
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
      c.setHeader("X-Org", c.params("oid") ?? "");
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
    app.get("/users/:id?/posts", (c) => c.text(`id=${c.params("id") ?? "-"}`));
    expect(await (await app.handle(req("/users/9/posts"))).text()).toBe("id=9");
    expect(await (await app.handle(req("/users/posts"))).text()).toBe("id=-");
    expect((await app.handle(req("/users"))).status).toBe(404);
  });

  it("static beats param across a mount boundary", async () => {
    const app = new Keala(quiet);
    const api = new Router();
    api.get("/:id", (c) => c.text(`param:${c.params("id")}`));
    app.mount("/api", api);
    app.get("/api/list", (c) => c.text("static"));
    expect(await (await app.handle(req("/api/list"))).text()).toBe("static");
    expect(await (await app.handle(req("/api/7"))).text()).toBe("param:7");
    expect(await (await app.handle(req("/api/7/"))).text()).toBe("param:7");
  });

  it("fast matcher and trie agree on %2F inside a captured param", async () => {
    const app = new Keala(quiet);
    app.get("/users/:id", (c) => c.text(c.params("id") ?? ""));
    app.get("/users/:id/posts/:tid", (c) => c.text(`${c.params("id")}/${c.params("tid")}`));
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
