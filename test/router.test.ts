/**
 * Hybrid router through the app surface: static Map path, bucket fast
 * matchers, trie fallback, 405/Allow/OPTIONS/501, duplicates, mounts,
 * named-route URL building, redirects and param middleware.
 */

import { describe, expect, it } from "vitest";

import { Keala } from "../src/core/app.ts";
import { Router } from "../src/router/group.ts";

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
      app.get("/users/:id", (c) => c.text(`user ${c.params?.["id"]}`));
    });
    expect(await (await request("/users/42")).text()).toBe("user 42");
    expect((await request("/users")).status).toBe(404);
    expect((await request("/users/1/posts")).status).toBe(404);
    expect((await request("/users/")).status).toBe(404);
  });

  it("multi-pattern buckets fall back to the trie with static-over-param order", async () => {
    const request = appWith((app) => {
      app.get("/shop/*", (c) => c.text("wildcard"));
      app.get("/shop/:name", (c) => c.text(`param:${c.params?.["name"]}`));
      app.get("/shop/new", (c) => c.text("static"));
      app.get("/shop/:name/price", (c) => c.text(`price:${c.params?.["name"]}`));
    });
    expect(await (await request("/shop/new")).text()).toBe("static");
    expect(await (await request("/shop/abc")).text()).toBe("param:abc");
    expect(await (await request("/shop/abc/price")).text()).toBe("price:abc");
    expect(await (await request("/shop/a/b/c")).text()).toBe("wildcard");
  });

  it("complex shapes (optionals, patterns, wildcards) always work", async () => {
    const request = appWith((app) => {
      app.get("/files/:name?", (c) => c.text(c.params?.["name"] ?? "index"));
      app.get("/n/:num(\\d+)", (c) => c.text(c.params?.["num"] ?? ""));
      app.get("/hex/:h([0-9a-f]+)", (c) => c.text(c.params?.["h"] ?? ""));
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
      app.get("/users/:name", (c) => c.text(c.params?.["name"] ?? ""));
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
      app.get("/v1/users/:id", (c) => c.text(`u:${c.params?.["id"]}`));
      app.get("/v1/u/:x/:y", (c) => c.text(`${c.params?.["x"]}/${c.params?.["y"]}`));
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
          c.body = "done";
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
    users.get("/:id", (c) => c.text(`user ${c.params?.["id"]}`));
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
      c.setHeader("X-Org", c.params?.["oid"] ?? "");
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
