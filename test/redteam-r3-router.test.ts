/**
 * Red-team round 3 — ROUTER deep-dive bug reports (assertion-fail red tests).
 *
 * Every `it()` asserts the CORRECT behavior and FAILS against the current
 * src/ — these are bug reports, not locked behavior. Ledger:
 *
 * R3-1  HIGH   src/router/trie.ts:252-267 (insertPattern) + :76-94
 *        (pushVariant)  A same-(name,pattern) param variant is SHARED between
 *        routes and `existing.optional = true` is sticky on the shared node,
 *        so the optional-skip transition also reaches subtrees registered by
 *        OTHER routes whose param is REQUIRED. A required-param route becomes
 *        servable with the param absent (and at the wrong segment count) as
 *        soon as any sibling route declares the position optional.
 * R3-2  MEDIUM src/router/group.ts:58-78 (add) + src/core/app.ts:361-377
 *        (mount)  Group paths/prefixes are never validated for a leading "/":
 *        `${base}${def.path}` concatenates into a plausible path, so a mounted
 *        `new Router({prefix:"/v1"}).get("users")` silently serves
 *        "/api/v1users" while app.get("users") throws.
 * R3-3  MEDIUM src/router/trie.ts:163-169 vs src/router/router.ts:294-298
 *        staticMap compares CANONICAL keys (decoded, re-escaped) but the trie
 *        static-child lookup also accepts the RAW segment, so a pattern whose
 *        decoded static segment contains "%" matches a request whose DECODED
 *        segment differs — the static twin of the same pair 404s. Breaks the
 *        documented "staticMap ≡ trie static walk" invariant.
 * R3-4  MEDIUM src/router/router.ts:322-329 (fastMatch) vs src/router/trie.ts
 *        :174-182 (recordOf)  Duplicate param names in one pattern
 *        ("/dup/:x/:x") are accepted; the fast matcher keeps the LAST value,
 *        the trie's cons-list keeps the FIRST — adding any second dynamic
 *        pattern to the bucket (disabling the fast matcher) silently flips
 *        the captured value. Express/@koa-router keep the last.
 * R3-5  LOW    src/core/app.ts:377 + src/router/router.ts:186 (bindDef)
 *        A param middleware merged via mount() runs OUTSIDE the sub-router's
 *        own use() middleware ([global, param, use, handler]). @koa/router
 *        runs use > param (verified against @koa/router 15.7), and the
 *        app-level order in this framework (app.use before app.param) is the
 *        opposite of the mounted order.
 * R3-6  LOW    src/router/pattern.ts:71-84  The custom-pattern parser slices
 *        the regex at the LAST ")" and silently DISCARDS any text after it:
 *        ":id(\\d+)beta" registers ":id(\\d+)" — a route that matches MORE
 *        than written, while every neighboring malformed shape throws.
 * R3-7  LOW    src/core/app.ts:382-400 (redirect) + router.ts:408-411
 *        A redirect destination path with a required :param the source never
 *        captures compiles fine at registration and explodes per-request as a
 *        500 — breaking the eager-validation contract ("malformed patterns
 *        throw before anything is registered").
 * R3-8  LOW    src/router/trie.ts:103-129 (matchPattern) +
 *        router.ts:375-400 (buildURL)  buildURL emits "/w/" for an empty
 *        wildcard value, but end-of-path handling never offers the wildcard,
 *        so the router 404s the very URL its own url() built (no round-trip;
 *        express serves "/w/*" at "/w/" with an empty capture).
 */

import { describe, expect, it } from "vitest";

import { Keala } from "../src/core/app.ts";
import { Router } from "../src/router/group.ts";
import { compilePattern } from "../src/router/pattern.ts";

const quiet = { env: "test" } as const;
const req = (path: string, init?: RequestInit) => new Request(`http://localhost:3000${path}`, init);

describe("R3-1 sticky optionality contaminates required-param routes (trie)", () => {
  it("a required-param route must 404 a path with the param absent once a sibling declares the position optional", async () => {
    // Control: the required-param route alone refuses "/a/c".
    const alone = new Keala(quiet);
    alone.get("/a/:x/c", (c) => c.text(`x=${c.params?.["x"]}`));
    expect((await alone.handle(req("/a/c"))).status).toBe(404);

    // Registering an unrelated optional variant at the same position makes
    // the SAME request answer 200 with `x` MISSING — the skip transition of
    // ":x?" reaches the "/c" tail registered by the required-param pattern.
    const app = new Keala(quiet);
    app.get("/a/:x/c", (c) => c.text(`x=${c.params?.["x"] ?? "MISSING"}`));
    app.get("/a/:x?/b", (c) => c.text("b"));
    const res = await app.handle(req("/a/c"));
    expect(res.status).toBe(404);
  });

  it("a plain single-param route must not become servable at the bare prefix (no param captured)", async () => {
    const app = new Keala(quiet);
    app.get("/u/:id", (c) => c.text(`id=${c.params?.["id"] ?? "MISSING"}`));
    app.get("/u/:id?/posts", (c) => c.text("posts"));
    const res = await app.handle(req("/u"));
    expect(res.status).toBe(404);
  });

  it("the contamination must not flip 404 into 405+Allow for other methods", async () => {
    const app = new Keala(quiet);
    app.post("/a/:x/c", (c) => c.text("c"));
    app.get("/a/:x?/b", (c) => c.text("b"));
    const res = await app.handle(req("/a/c", { method: "DELETE" }));
    expect(res.status).toBe(404);
  });
});

describe("R3-2 mounted group paths without a leading slash concatenate silently", () => {
  it("router.get('users') must throw like app.get('users') does (path must start with '/')", () => {
    const router = new Router({ prefix: "/v1" });
    expect(() => router.get("users", (c) => c.text("u"))).toThrow(/must start with/);
  });

  it("a router prefix without a leading slash throws at CONSTRUCTION (fail fast)", () => {
    // The Router class validates the prefix in the constructor — the bad
    // config surfaces where it was written, not at the first registration.
    expect(() => new Router({ prefix: "v1" })).toThrow(/must start with/);
  });
});

describe("R3-3 staticMap and trie disagree on decoded static segments containing %", () => {
  it("a dynamic route must not match a request whose decoded static segment differs (static twin 404s)", async () => {
    // Static control: the pattern segment decodes to "a%2Fb"; the request
    // segment "a%2Fb" decodes to "a/b" — different values, no match.
    const stat = new Keala(quiet);
    stat.get("/a%252Fb", (c) => c.text("static"));
    expect((await stat.handle(req("/a%2Fb"))).status).toBe(404);

    // Same pair through a dynamic route: the trie's raw-first static-child
    // lookup accepts the RAW "a%2Fb" against the decoded key "a%2Fb".
    const dyn = new Keala(quiet);
    dyn.get("/a%252Fb/:id", (c) => c.text(`dyn:${c.params?.["id"]}`));
    expect((await dyn.handle(req("/a%2Fb/5"))).status).toBe(404);
  });
});

describe("R3-4 duplicate param names: fast matcher and trie capture different values", () => {
  it("adding an unrelated route to the bucket must not flip the captured param value (last one wins)", async () => {
    const fast = new Keala(quiet);
    fast.get("/dup/:x/:x", (c) => c.text(`x=${c.params?.["x"]}`));
    const fastRes = await fast.handle(req("/dup/1/2"));
    expect(await fastRes.text()).toBe("x=2");

    // A second dynamic pattern under "/dup" disables the fast matcher —
    // the trie's cons-list keeps the FIRST capture instead.
    const trieApp = new Keala(quiet);
    trieApp.get("/dup/:x/:x", (c) => c.text(`x=${c.params?.["x"]}`));
    trieApp.get("/dup/x/:y", (c) => c.text(`y=${c.params?.["y"]}`));
    const trieRes = await trieApp.handle(req("/dup/1/2"));
    expect(await trieRes.text()).toBe("x=2");
  });
});

describe("R3-5 mounted param middleware runs outside the router's use() middleware", () => {
  it("a group's use() middleware is prepended to every route — it must run before its param() middleware (koa parity)", async () => {
    const order: string[] = [];
    const app = new Keala(quiet);
    const api = new Router();
    api.use(async (_c, next) => {
      order.push("use");
      await next();
    });
    api.param("id", async (_c, next) => {
      order.push("param");
      await next();
    });
    api.get("/x/:id", (c) => {
      order.push("leaf");
      return c.text("leaf");
    });
    app.mount("/api", api);
    await app.handle(req("/api/x/7"));
    expect(order).toEqual(["use", "param", "leaf"]);
  });
});

describe("R3-6 custom-pattern parser silently discards text after the closing paren", () => {
  it("':id(\\\\d+)beta' is malformed (trailing junk after the custom regex) and must throw", () => {
    expect(() => compilePattern("/n/:id(\\d+)beta")).toThrow(TypeError);
  });
});

describe("R3-7 redirect destination params the source never captures explode per-request", () => {
  it("registration must throw when a destination :param is not captured by the source route", () => {
    const app = new Keala(quiet);
    expect(() => app.redirect("/a", "/x/:missing", 302)).toThrow();
  });
});

describe("R3-8 url() builds '/w/' for an empty wildcard value but the router 404s it", () => {
  it("a trailing wildcard must match the bare prefix+'/' with an empty capture (url round-trip)", async () => {
    const app = new Keala(quiet);
    app.get("w", "/w/*", (c) => c.text(`[${c.params?.["wildcard"] ?? ""}]`));
    const built = app.url("w", { wildcard: "" });
    expect(built).toBe("/w/");
    const res = await app.handle(req("/w/"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("[]");
  });
});
