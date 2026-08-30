import { describe, expect, it } from "vitest";

import { createApp } from "../src/application/app.ts";
import { createRouter } from "../src/router/router.ts";

const harness = () => {
  const app = createApp();
  const router = createRouter();
  return { app, router };
};

const run = async (
  setup: (router: ReturnType<typeof createRouter>) => void,
  url: string,
  init?: RequestInit,
): Promise<Response> => {
  const { app, router } = harness();
  setup(router);
  app.use(router.routes()).use(router.allowedMethods());
  return app.handle(new Request(`http://localhost:3000${url}`, init));
};

describe("router", () => {
  it("dispatches static routes per method", async () => {
    const res = await run((router) => {
      router.get("/health", (ctx) => {
        ctx.body = "get";
      });
      router.post("/health", (ctx) => {
        ctx.body = "post";
      });
    }, "/health");
    expect(await res.text()).toBe("get");
    const post = await run(
      (router) => {
        router.post("/health", (ctx) => {
          ctx.body = "post";
        });
      },
      "/health",
      { method: "POST" },
    );
    expect(await post.text()).toBe("post");
  });

  it("dispatches all remaining verbs through the method shortcuts", async () => {
    const verbs = ["put", "patch", "delete", "head", "options"] as const;
    for (const verb of verbs) {
      const res = await run(
        (router) => {
          router[verb]("/x", (ctx) => {
            ctx.body = verb;
          });
        },
        "/x",
        { method: verb.toUpperCase() },
      );
      expect(res.status).toBe(200);
    }
  });

  it("extracts params and runs multiple handlers per route", async () => {
    const res = await run((router) => {
      router.get(
        "/users/:id",
        async (ctx, next) => {
          ctx.state["seen"] = true;
          await next();
        },
        async (ctx) => {
          ctx.body = { id: ctx.params["id"], seen: ctx.state["seen"] };
        },
      );
    }, "/users/77");
    expect(await res.json()).toEqual({ id: "77", seen: true });
  });

  it("runs param middleware before route handlers", async () => {
    const res = await run((router) => {
      router.param("id", async (ctx, next) => {
        ctx.state["param"] = ctx.params["id"];
        await next();
      });
      router.get("/users/:id", (ctx) => {
        ctx.body = { param: ctx.state["param"] };
      });
    }, "/users/9");
    expect(await res.json()).toEqual({ param: "9" });
  });

  it("returns 405 with Allow for known methods, 501 for unknown", async () => {
    const router = createRouter();
    router.get("/thing", (ctx) => {
      ctx.body = "thing";
    });
    router.post("/thing", (ctx) => {
      ctx.body = "created";
    });
    const app = createApp();
    app.use(router.routes()).use(router.allowedMethods());

    const wrong = await app.handle(
      new Request("http://localhost:3000/thing", { method: "DELETE" }),
    );
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toBe("HEAD, GET, POST");

    const unknown = await app.handle(
      new Request("http://localhost:3000/thing", { method: "PROPFIND" }),
    );
    expect(unknown.status).toBe(501);
  });

  it("throws on 405/501 when option is set", async () => {
    const router = createRouter();
    router.get("/only-get", (ctx) => {
      ctx.body = "ok";
    });
    const app = createApp({ env: "test" });
    app.use(router.routes()).use(router.allowedMethods({ throw: true }));
    const res = await app.handle(new Request("http://localhost:3000/only-get", { method: "POST" }));
    expect(res.status).toBe(405);
  });

  it("serves HEAD requests through GET handlers", async () => {
    const res = await run(
      (router) => {
        router.get("/file", (ctx) => {
          ctx.type = "text/plain";
          ctx.body = "payload";
        });
      },
      "/file",
      { method: "HEAD" },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("7");
    expect(await res.text()).toBe("");
  });

  it("falls through to 404 when nothing matches", async () => {
    const res = await run((router) => {
      router.get("/known", (ctx) => {
        ctx.body = "ok";
      });
    }, "/unknown");
    expect(res.status).toBe(404);
  });

  it("router.all matches every method", async () => {
    for (const method of ["GET", "POST", "PUT", "DELETE"]) {
      const res = await run(
        (router) => {
          router.all("/any", (ctx) => {
            ctx.body = method;
          });
        },
        "/any",
        { method },
      );
      expect(res.status).toBe(200);
    }
  });

  it("supports prefixes via option and prefix()", async () => {
    const res = await run((router) => {
      router.get("/ping", (ctx) => {
        ctx.body = "pong";
      });
      router.prefix("/api");
    }, "/api/ping");
    expect(await res.text()).toBe("pong");

    const direct = await run((router) => {
      router.get("/ping", (ctx) => {
        ctx.body = "pong";
      });
    }, "/ping");
    expect(direct.status).toBe(200);
  });

  it("rebuilds param middleware and method tables after prefix()", async () => {
    const router = createRouter();
    router.param("id", async (ctx, next) => {
      ctx.set("X-Param-Mw", "ran");
      await next();
    });
    router.get("/users/:id(\\d+)", (ctx) => {
      ctx.body = ctx.params["id"];
    });
    router.post("/users/:id(\\d+)", (ctx) => {
      ctx.body = "posted";
    });
    router.prefix("/v2");
    const app = createApp();
    app.use(router.routes()).use(router.allowedMethods());
    const got = await app.handle(new Request("http://localhost:3000/v2/users/5"));
    expect(await got.text()).toBe("5");
    expect(got.headers.get("x-param-mw")).toBe("ran");
    const posted = await app.handle(
      new Request("http://localhost:3000/v2/users/5", { method: "POST" }),
    );
    expect(await posted.text()).toBe("posted");
  });

  it("mounts middleware with optional path prefixes", async () => {
    const res = await run((router) => {
      router.use(async (ctx, next) => {
        ctx.set("X-Global", "1");
        await next();
      });
      router.use("/admin", async (ctx, next) => {
        ctx.set("X-Admin", "1");
        await next();
      });
      router.get("/admin/panel", (ctx) => {
        ctx.body = "panel";
      });
      router.get("/public", (ctx) => {
        ctx.body = "public";
      });
    }, "/admin/panel");
    expect(res.headers.get("x-admin")).toBe("1");
    const pub = await run((router) => {
      router.use("/admin", async (ctx, next) => {
        ctx.set("X-Admin", "1");
        await next();
      });
      router.get("/public", (ctx) => {
        ctx.body = "public";
      });
    }, "/public");
    expect(pub.headers.get("x-admin")).toBe(null);
  });

  it("nests routers via use(prefix, childRoutes)", async () => {
    const child = createRouter();
    child.get("/items/:sku", (ctx) => {
      ctx.body = { sku: ctx.params["sku"] };
    });
    const parent = createRouter();
    parent.use("/shop", child.routes());
    const app = createApp();
    app.use(parent.routes()).use(parent.allowedMethods());
    const res = await app.handle(new Request("http://localhost:3000/shop/items/abc"));
    expect(await res.json()).toEqual({ sku: "abc" });
  });

  it("registers redirects", async () => {
    const res = await run((router) => {
      router.redirect("/old", "/new");
    }, "/old");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/new");
  });

  it("redirects with params and custom codes", async () => {
    const res = await run((router) => {
      router.redirect("/u/:id", "/users/:id", 302);
    }, "/u/42");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/users/42");
  });

  it("supports named routes and url building", () => {
    const router = createRouter({ prefix: "/api" });
    router.get("user", "/users/:id(\\d+)", (ctx) => void ctx);
    router.get("file", "/files/:name?", (ctx) => void ctx);
    expect(router.url("user", { id: "42" })).toBe("/api/users/42");
    expect(router.url("file", {})).toBe("/api/files");
    expect(router.url("file", { name: "a b.txt" })).toBe("/api/files/a%20b.txt");
    expect(router.route("user")?.path).toBe("/api/users/:id(\\d+)");
    expect(() => router.url("missing")).toThrow(Error);
  });

  it("register accepts custom names and validates input", () => {
    const router = createRouter();
    router.register("get", "/ok", [(ctx) => void ctx], { name: "ok" });
    expect(router.stack.length).toBe(1);
    expect(() => router.register("BOGUS", "/x", [])).toThrow(TypeError);
    expect(() => router.register("get", "/x", [null as unknown as () => void])).toThrow(TypeError);
    expect(() => router.use(...([] as unknown as [() => void]))).toThrow(TypeError);
    expect(() => router.param("", (ctx) => void ctx)).toThrow(TypeError);
    expect(() => router.param("x", undefined as unknown as () => void)).toThrow(TypeError);
    expect(() => createRouter().get("bad-path", (ctx) => void ctx)).toThrow(TypeError);
  });

  it("shares state up the onion across router and route handlers", async () => {
    const order: string[] = [];
    const res = await run((router) => {
      router.use(async (_ctx, next) => {
        order.push("router-mw");
        await next();
      });
      router.get(
        "/flow",
        async (_ctx, next) => {
          order.push("route-a");
          await next();
        },
        async (ctx) => {
          order.push("route-b");
          ctx.body = "flow";
        },
      );
    }, "/flow");
    expect(await res.text()).toBe("flow");
    expect(order).toEqual(["router-mw", "route-a", "route-b"]);
  });
});
