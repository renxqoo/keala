import { describe, expect, it } from "vitest";

import { Keala } from "../src/core/app.ts";
import type { Context } from "../src/core/context/context.ts";
import { createBodyParser, type ContextWithBody } from "../src/plugins/body-parser.ts";

const quiet = { env: "test" } as const;
const request = (path: string, init?: RequestInit): Request =>
  new Request(`http://localhost${path}`, init);
const pass = (_c: Context, next: () => Promise<void>) => next();

describe("HOTPATH-R3 path-scoped app.use", () => {
  it("matches exact and wildcard scopes without touching adjacent or outside routes", async () => {
    const app = new Keala(quiet);
    const seen: string[] = [];
    app.use("/health", async (c, next) => {
      seen.push(`exact:${c.path}`);
      await next();
    });
    app.use("/v1/*", async (c, next) => {
      seen.push(`wild:${c.path}`);
      await next();
    });
    for (const path of ["/health", "/v1", "/v1/", "/v1/users/:id", "/v10", "/other"]) {
      app.get(path, (c) => c.text("ok"));
    }

    for (const path of ["/health", "/v1", "/v1/", "/v1/users/7", "/v10", "/other"]) {
      expect((await app.handle(request(path))).status).toBe(200);
    }
    expect(seen).toEqual(["exact:/health", "wild:/v1", "wild:/v1/", "wild:/v1/users/7"]);
  });

  it("preserves interleaved registration order and applies late scoped middleware", async () => {
    const app = new Keala(quiet);
    const order: string[] = [];
    const layer = (name: string) => async (_c: Context, next: () => Promise<void>) => {
      order.push(`${name}:in`);
      await next();
      order.push(`${name}:out`);
    };
    app.use(layer("global-a"));
    app.get("/v1/x", layer("route"));
    app.use("/v1/*", layer("scope"));
    app.use(layer("global-b"));

    expect((await app.handle(request("/v1/x"))).status).toBe(404);
    expect(order).toEqual([
      "global-a:in",
      "scope:in",
      "global-b:in",
      "route:in",
      "route:out",
      "global-b:out",
      "scope:out",
      "global-a:out",
    ]);
  });

  it("runs scoped middleware for in-scope 404, 405 and automatic OPTIONS", async () => {
    const app = new Keala(quiet);
    app.use("/v1/*", async (c, next) => {
      await next();
      c.set("x-scope", "yes");
    });
    app.get("/v1/users", (c) => c.text("ok"));

    const missing = await app.handle(request("/v1/missing"));
    const wrongMethod = await app.handle(request("/v1/users", { method: "POST" }));
    const options = await app.handle(request("/v1/users", { method: "OPTIONS" }));
    const outside = await app.handle(request("/outside"));
    expect([missing.status, wrongMethod.status, options.status]).toEqual([404, 405, 200]);
    expect([missing, wrongMethod, options].map((res) => res.headers.get("x-scope"))).toEqual([
      "yes",
      "yes",
      "yes",
    ]);
    expect(outside.headers.get("x-scope")).toBeNull();
  });

  it("supports root scope, multiple handlers and scoped middleware on a mounted app", async () => {
    const child = new Keala(quiet);
    const seen: string[] = [];
    child.use("/users/*", async (_c, next) => {
      seen.push("child-scope");
      await next();
    });
    child.get("/users/:id", (c) => c.text(c.params?.["id"] ?? ""));

    const app = new Keala(quiet);
    app.use(
      "/*",
      async (_c, next) => {
        seen.push("root-a");
        await next();
      },
      async (_c, next) => {
        seen.push("root-b");
        await next();
      },
    );
    app.mount("/api", child);

    const response = await app.handle(request("/api/users/42"));
    expect(await response.text()).toBe("42");
    expect(seen).toEqual(["root-a", "root-b", "child-scope"]);
  });

  it("keeps exact scopes correct on ambiguous dynamic routes and nested mounts", async () => {
    const seen: string[] = [];
    const leaf = new Keala(quiet);
    leaf.use("/users", async (_c, next) => {
      seen.push("scoped");
      await next();
    });
    leaf.get("/:section", (c) => c.text(c.params?.["section"] ?? ""));

    const middle = new Keala(quiet);
    middle.mount("/inner", leaf);
    const app = new Keala(quiet);
    app.mount("/api", middle);

    expect(await (await app.handle(request("/api/inner/users"))).text()).toBe("users");
    expect(await (await app.handle(request("/api/inner/other"))).text()).toBe("other");
    expect(seen).toEqual(["scoped"]);
  });

  it.each(["v1", "/v1/:id", "/v1/**", "/v1/*/x", ""])(
    "rejects unsupported scope pattern %j at registration",
    (pattern) => {
      const app = new Keala(quiet);
      expect(() => app.use(pattern, (_c, next) => next())).toThrow(TypeError);
    },
  );

  it("rejects an empty scoped middleware list", () => {
    const app = new Keala(quiet);
    expect(() => (app.use as (pattern: string) => unknown)("/v1/*")).toThrow(
      /at least one middleware/,
    );
  });

  it("rejects a plugin in scoped form", () => {
    const app = new Keala(quiet);
    expect(() => app.use("/v1/*", createBodyParser() as unknown as (c: Context) => void)).toThrow(
      /plugin/i,
    );
  });

  it("allows disjoint native sinks but rejects overlap in both registration orders", () => {
    const disjoint = new Keala(quiet);
    disjoint.use("/v1/*", pass);
    expect(() => disjoint.sink("/livez", new Response("ok"))).not.toThrow();

    const middlewareFirst = new Keala(quiet);
    middlewareFirst.use("/v1/*", pass);
    expect(() => middlewareFirst.sink("/v1/static", new Response("x"))).toThrow(/middleware/);

    const sinkFirst = new Keala(quiet);
    sinkFirst.sink("/v1/static", new Response("x"));
    expect(() => sinkFirst.use("/v1/*", pass)).toThrow(/middleware/);

    const prefixTrees = new Keala(quiet);
    prefixTrees.use("/v1/*", pass);
    expect(() => prefixTrees.sink("/v1/assets/*", { dir: "/tmp" })).toThrow(/middleware/);
  });

  it("precompiles exact, nested and root fallback chains for 404 paths", async () => {
    const app = new Keala({ env: "development" });
    const seen: string[] = [];
    app.use(((_c, next) => next()) as typeof pass);
    app.use("/*", async (_c, next) => {
      seen.push("root");
      await next();
    });
    app.use("/v1/*", async (_c, next) => {
      seen.push("v1");
      await next();
    });
    app.use("/v1/users", async (_c, next) => {
      seen.push("exact");
      await next();
    });
    expect(app.globalMiddleware).toHaveLength(1);

    expect((await app.handle(request("/v1/users"))).status).toBe(404);
    expect((await app.handle(request("/v1/missing"))).status).toBe(404);
    expect((await app.handle(request("/"))).status).toBe(404);
    expect(seen).toEqual(["root", "v1", "exact", "root", "v1", "root"]);
  });

  it("keeps a longer prefix conditional on a shorter dynamic route", async () => {
    const app = new Keala({ env: "development" });
    let hits = 0;
    app.use("/api/users/*", async (_c, next) => {
      hits += 1;
      await next();
    });
    app.get("/:first", (c) => c.text(c.params?.["first"] ?? ""));
    app.get("/api", (c) => c.text("api"));
    expect(await (await app.handle(request("/other"))).text()).toBe("other");
    expect(await (await app.handle(request("/api"))).text()).toBe("api");
    expect(hits).toBe(0);
  });
});

describe("HOTPATH-R3 body in-flight memoization", () => {
  it("concurrent json readers share the same promise, parse and object identity", async () => {
    const app = new Keala(quiet);
    app.use(createBodyParser());
    app.post("/", async (c0) => {
      const c = c0 as ContextWithBody;
      const first = c.req.json();
      const second = c.req.json();
      const [a, b] = await Promise.all([first, second]);
      return c.json({ samePromise: first === second, sameObject: a === b });
    });
    const response = await app.handle(
      request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"n":1}',
      }),
    );
    expect(await response.json()).toEqual({ samePromise: true, sameObject: true });
  });

  it("memoizes concurrent text, blob and formData readers before they settle", async () => {
    const cases = [
      {
        contentType: "text/plain",
        body: "hello",
        read: (c: ContextWithBody) => c.req.text(),
      },
      {
        contentType: "application/octet-stream",
        body: "hello",
        read: (c: ContextWithBody) => c.req.arrayBuffer(),
      },
      {
        contentType: "application/octet-stream",
        body: "hello",
        read: (c: ContextWithBody) => c.req.blob(),
      },
      {
        contentType: "application/x-www-form-urlencoded",
        body: "a=1",
        read: (c: ContextWithBody) => c.req.formData(),
      },
    ];
    for (const testCase of cases) {
      const app = new Keala(quiet);
      app.use(createBodyParser());
      app.post("/", async (c0) => {
        const c = c0 as ContextWithBody;
        const first = testCase.read(c);
        const second = testCase.read(c);
        const [a, b] = await Promise.all([first, second]);
        return c.json({ samePromise: first === second, sameValue: a === b });
      });
      const response = await app.handle(
        request("/", {
          method: "POST",
          headers: { "content-type": testCase.contentType },
          body: testCase.body,
        }),
      );
      expect(await response.json()).toEqual({ samePromise: true, sameValue: true });
    }
  });

  it("memoizes malformed-json rejection without weakening the 400 contract", async () => {
    const app = new Keala(quiet);
    app.use(createBodyParser());
    app.post("/", async (c0) => {
      const c = c0 as ContextWithBody;
      const first = c.req.json();
      const second = c.req.json();
      const errors = await Promise.allSettled([first, second]);
      const statuses = errors.map((result) =>
        result.status === "rejected" ? (result.reason as { status?: number }).status : 0,
      );
      return c.json({ samePromise: first === second, statuses });
    });
    const response = await app.handle(
      request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json",
      }),
    );
    expect(await response.json()).toEqual({ samePromise: true, statuses: [400, 400] });
  });

  it("memoizes a declared-length 413 before the body read starts", async () => {
    const app = new Keala(quiet);
    app.use(createBodyParser({ jsonLimit: 2 }));
    app.post("/", async (c0) => {
      const c = c0 as ContextWithBody;
      const first = c.req.arrayBuffer();
      const second = c.req.arrayBuffer();
      const [a, b] = await Promise.allSettled([first, second]);
      return c.json({
        samePromise: first === second,
        sameReason: a.status === "rejected" && b.status === "rejected" && a.reason === b.reason,
        statuses: [a, b].map((result) =>
          result.status === "rejected" ? (result.reason as { status?: number }).status : 0,
        ),
      });
    });
    const response = await app.handle(
      request("/", {
        method: "POST",
        headers: { "content-type": "application/octet-stream", "content-length": "3" },
        body: "abc",
      }),
    );
    expect(await response.json()).toEqual({
      samePromise: true,
      sameReason: true,
      statuses: [413, 413],
    });
  });

  it("returns cached bytes when a later smaller limit still fits", async () => {
    const app = new Keala(quiet);
    app.use(createBodyParser({ formLimit: 100, jsonLimit: 5 }));
    app.post("/", async (c0) => {
      const c = c0 as ContextWithBody;
      await c.req.formData();
      return c.text(String((await c.req.arrayBuffer()).byteLength));
    });
    const response = await app.handle(
      request("/", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "a=1",
      }),
    );
    expect(await response.text()).toBe("3");
  });
});
