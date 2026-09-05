/**
 * R411 API ergonomics locks (docs/R411-API-ERGONOMICS-PLAN.md, v2).
 *
 * Fix 1 — bodyOf(c): the typed body-reader accessor, its loud guidance
 * error without the plugin, and full facade reachability.
 * Fix 3 — c.params is never null (EMPTY_PARAMS sentinel).
 * Fix 4 — c.routePath / c.routeName: the matched-pattern facts, published
 * beside params at dispatch, including the 405 path, mount prefixes,
 * named routes and pool recycling.
 */

import { describe, expect, it } from "vitest";

import { Keala } from "../../src/core/app.ts";
import { Router } from "../../src/router/group.ts";
import { bodyOf, createBodyParser } from "../../src/plugins/body-parser.ts";

const quiet = { env: "test" } as const;
const req = (path: string, init?: RequestInit): Request =>
  new Request(`http://localhost${path}`, init);

describe("R411 Fix 1: bodyOf(c)", () => {
  it("reads JSON with zero cast and memoizes across calls", async () => {
    const app = new Keala(quiet);
    app.use(createBodyParser({ jsonLimit: 256 }));
    app.post("/echo", async (c) => {
      const first = await bodyOf(c).json();
      const second = await bodyOf(c).json();
      return c.json({ value: first, memoized: first === second });
    });
    const res = await app.handle(
      req("/echo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"n":1}',
      }),
    );
    const body = (await res.json()) as { value: unknown; memoized: boolean };
    expect(body.value).toEqual({ n: 1 });
    expect(body.memoized).toBe(true);
  });

  it("throws a guidance TypeError when the plugin is not installed", async () => {
    const app = new Keala(quiet);
    let caught: unknown;
    app.post("/x", async (c) => {
      try {
        await bodyOf(c).json();
      } catch (error) {
        caught = error;
      }
      return c.text("done");
    });
    await app.handle(req("/x", { method: "POST", body: "{}" }));
    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as Error).message).toMatch(/bodyParser plugin/);
    expect((caught as Error).message).toMatch(/createBodyParser/);
  });

  it("reaches the whole facade: text, arrayBuffer, blob, formData", async () => {
    const app = new Keala(quiet);
    app.use(createBodyParser({ jsonLimit: 256 }));
    let reachability = "";
    app.post("/form", async (c) => {
      const body = bodyOf(c);
      reachability = ["json", "text", "arrayBuffer", "blob", "formData"]
        .map((name) => typeof (body as unknown as Record<string, unknown>)[name])
        .join(",");
      const fd = await body.formData();
      return c.text(fd.get("a") === null ? "" : String(fd.get("a")));
    });
    const res = await app.handle(
      req("/form", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "a=1",
      }),
    );
    expect(reachability).toBe("function,function,function,function,function");
    expect(await res.text()).toBe("1");
  });
});

describe("U2: params is a functional read (never an object)", () => {
  it("an unmatched middleware reads undefined for every name, never null", async () => {
    const app = new Keala(quiet);
    let observed: unknown = "unset";
    app.use(async (c, next) => {
      await next();
      observed = c.params("id");
    });
    const res = await app.handle(req("/nowhere"));
    expect(res.status).toBe(404);
    expect(observed).toBe(undefined);
  });

  it("prototype names miss (no Record to pollute), missing/optional names miss", async () => {
    const app = new Keala(quiet);
    // null-proto: a plain object literal would swallow the "__proto__" write
    // through its setter and the assertion would never see the probe value.
    const seen: Record<string, unknown> = Object.create(null);
    app.get("/u/:id/:rest?", (c) => {
      for (const name of ["id", "rest", "toString", "__proto__", "constructor", "missing"]) {
        seen[name] = c.params(name);
      }
      return c.text("ok");
    });
    await app.handle(req("/u/42"));
    expect(seen["id"]).toBe("42");
    expect(seen["rest"]).toBe(undefined); // optional, absent
    expect(seen["toString"]).toBe(undefined);
    expect(seen["__proto__"]).toBe(undefined);
    expect(seen["constructor"]).toBe(undefined);
    expect(seen["missing"]).toBe(undefined);
  });

  it("repeated names keep the LATEST capture", async () => {
    const app = new Keala(quiet);
    app.get("/dup/:x/:x", (c) => c.text(c.params("x") ?? "none"));
    expect(await (await app.handle(req("/dup/1/2"))).text()).toBe("2");
  });
});

describe("R411 Fix 4: c.routePath / c.routeName", () => {
  it("a matched dynamic route publishes its pattern", async () => {
    const app = new Keala(quiet);
    let seen = "";
    app.get("/users/:id", (c) => {
      seen = c.routePath;
      return c.text(`user ${c.params("id")}`);
    });
    const res = await app.handle(req("/users/7"));
    expect(await res.text()).toBe("user 7");
    expect(seen).toBe("/users/:id");
  });

  it("an unmatched request keeps routePath empty through the fallback chain", async () => {
    const app = new Keala(quiet);
    let afterNext = "unset";
    app.use(async (c, next) => {
      await next();
      afterNext = c.routePath;
    });
    const res = await app.handle(req("/nowhere"));
    expect(res.status).toBe(404);
    expect(afterNext).toBe("");
  });

  it("a 405 still names the matched pattern (right route, wrong method)", async () => {
    const app = new Keala(quiet);
    let observed: unknown = "unset";
    app.use(async (c, next) => {
      await next();
      observed = c.routePath;
    });
    app.get("/only", (c) => c.text("get"));
    const res = await app.handle(req("/only", { method: "POST" }));
    expect(res.status).toBe(405);
    expect(observed).toBe("/only");
  });

  it("a mounted router carries the full prefix in the pattern", async () => {
    const app = new Keala(quiet);
    const api = new Router();
    let seen = "";
    api.get("/u/:id", (c) => {
      seen = c.routePath;
      return c.text("ok");
    });
    app.mount("/api", api);
    await app.handle(req("/api/u/42"));
    expect(seen).toBe("/api/u/:id");
  });

  it("a named route publishes routeName; unnamed stays undefined", async () => {
    const app = new Keala(quiet);
    let named: string | undefined = "unset";
    let plain: string | undefined = "unset";
    app.get("report-route", "/report", (c) => {
      named = c.routeName;
      return c.text("r");
    });
    app.get("/plain", (c) => {
      plain = c.routeName;
      return c.text("p");
    });
    await app.handle(req("/report"));
    await app.handle(req("/plain"));
    expect(named).toBe("report-route");
    expect(plain).toBe(undefined);
  });

  it("pool recycling resets both slots between requests", async () => {
    const app = new Keala({ env: "test", pooling: true });
    let observed = "";
    app.use(async (c, next) => {
      await next();
      observed = `${c.routePath}|${String(c.routeName)}`;
    });
    app.get("user", "/users/:id", (c) => c.text("ok"));
    await app.handle(req("/users/1"));
    expect(observed).toBe("/users/:id|user");
    await app.handle(req("/nowhere"));
    expect(observed).toBe("|undefined"); // recycled: no stale pattern leaks
  });
});

describe("c.URL (ported from the retired koa parity suite, U1)", () => {
  it("c.URL exposes the live WHATWG URL view", async () => {
    const app = new Keala(quiet);
    app.get("/u", (c) => {
      return c.text(c.URL instanceof URL ? c.URL.pathname : "not a URL");
    });
    const res = await app.handle(req("/u"));
    expect(await res.text()).toBe("/u");
  });
});
