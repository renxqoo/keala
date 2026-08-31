/**
 * Round-5 router/matching-engine audit — "locks correct behavior" half,
 * split from agent-r5-router.test.ts for the 500-line file budget. These
 * tests passed BEFORE the fixes and must keep passing.
 */

import { describe, expect, it } from "vitest";

import { Eleu } from "../src/core/app.ts";
import { Router } from "../src/router/group.ts";

const quiet = { env: "test" } as const;
const req = (path: string, init?: RequestInit) => new Request(`http://localhost:3000${path}`, init);

describe("locks correct: percent-encoding consistency", () => {
  it("a static route is reachable through every encoding of the same path", async () => {
    const app = new Eleu(quiet);
    app.get("/foo%20bar", (c) => c.text("one"));
    expect((await app.handle(req("/foo%20bar"))).status).toBe(200);
    expect((await app.handle(req("/foo bar"))).status).toBe(200);
    // hex case-insensitivity normalizes through the canonical key
    expect((await app.handle(req("/foo%20Bar".toLowerCase()))).status).toBe(200);
  });

  it("single- and double-encoded slashes stay distinct routes (%2F never splits, %252F never conflates)", async () => {
    const app = new Eleu(quiet);
    app.get("/a%2Fb", (c) => c.text("single"));
    app.get("/a%252Fb", (c) => c.text("double"));
    const r1 = await app.handle(req("/a%2Fb"));
    expect([r1.status, await r1.text()]).toEqual([200, "single"]);
    const r2 = await app.handle(req("/a%252Fb"));
    expect([r2.status, await r2.text()]).toEqual([200, "double"]);
    // the decoded two-segment path is a DIFFERENT resource
    expect((await app.handle(req("/a/b"))).status).toBe(404);
  });

  it("malformed and hostile escapes never 500 (pass through or miss)", async () => {
    const app = new Eleu(quiet);
    app.get("/a%25b/:x", (c) => c.text(`x:${c.params?.["x"]}`));
    for (const p of ["/a%b/1", "/a%ZZ/1", "/a%/1", "/a%2/1", "/a%00b/1"]) {
      const res = await app.handle(req(p));
      expect(res.status).toBeLessThan(500);
    }
    // lone-surrogate escapes are invalid UTF-8: decodeURIComponent throws,
    // the router must pass them through rather than explode
    const app2 = new Eleu(quiet);
    app2.get("/s/:x", (c) => c.text("s"));
    expect((await app2.handle(req("/s/%ED%A0%80"))).status).toBeLessThan(500);
  });

  it("an encoded request path decodes once (params and statics, non-BMP included)", async () => {
    const app = new Eleu(quiet);
    app.get("/users/:name", (c) => c.text(`n:${c.params?.["name"]}`));
    const r1 = await app.handle(req("/users/%E4%B8%AD"));
    expect(await r1.text()).toBe("n:中");
    const r2 = await app.handle(req("/users/😀"));
    expect(await r2.text()).toBe("n:😀");
    // '%2F' inside a param decodes to a literal slash (single segment)
    const r3 = await app.handle(req("/users/a%2Fb"));
    expect(await r3.text()).toBe("n:a/b");
  });

  it("an encoded FIRST segment still reaches static and dynamic routes (bucket bypass)", async () => {
    const app = new Eleu(quiet);
    app.get("/admin", (c) => c.text("static-admin"));
    app.get("/users/:id", (c) => c.text(`u:${c.params?.["id"]}`));
    expect((await app.handle(req("/%61dmin"))).status).toBe(200);
    expect(await (await app.handle(req("/%75sers/42"))).text()).toBe("u:42");
  });

  it("static priority survives encoding: the canonical static beats the dynamic twin", async () => {
    const app = new Eleu(quiet);
    app.get("/foo/a%20b", (c) => c.text("static"));
    app.get("/foo/:x", (c) => c.text(`dyn:${c.params?.["x"]}`));
    expect(await (await app.handle(req("/foo/a%20b"))).text()).toBe("static");
    expect(await (await app.handle(req("/foo/other"))).text()).toBe("dyn:other");
  });

  it("encoded-twin dynamic routes share one bucket and both forms match", async () => {
    const app = new Eleu(quiet);
    app.get("/a%20b/:x", (c) => c.text(`one:${c.params?.["x"]}`));
    const r1 = await app.handle(req("/a%20b/1"));
    expect([r1.status, await r1.text()]).toEqual([200, "one:1"]);
    const r2 = await app.handle(req("/a b/2"));
    expect([r2.status, await r2.text()]).toEqual([200, "one:2"]);
  });

  it("conflicting param names across encoded twins still throw at registration", () => {
    const app = new Eleu(quiet);
    app.get("/a%20b/:x", () => undefined as never);
    expect(() => app.get("/a b/:y", () => undefined as never)).toThrow(
      /Conflicting parameter names/,
    );
  });
});

describe("locks correct: fast matcher / trie equivalence", () => {
  it("multi-slash and overlong paths fall back to the trie and miss cleanly", async () => {
    const app = new Eleu(quiet);
    app.get("/a/:x/:y", (c) => c.text(`${c.params?.["x"]}/${c.params?.["y"]}`));
    const ok = await app.handle(req("/a/1/2"));
    expect(await ok.text()).toBe("1/2");
    // trailing slash: fast matcher bails, trie strips and matches
    expect((await app.handle(req("/a/1/2/"))).status).toBe(200);
    // too few / empty segments / extra segments
    expect((await app.handle(req("/a/1"))).status).toBe(404);
    expect((await app.handle(req("/a/1//"))).status).toBe(404);
    expect((await app.handle(req("/a//2"))).status).toBe(404);
    expect((await app.handle(req("/a/1/2/3"))).status).toBe(404);
  });

  it("a single-param fast matcher does not answer the bare prefix", async () => {
    const app = new Eleu(quiet);
    app.get("/users/:id", (c) => c.text(`u:${c.params?.["id"]}`));
    expect((await app.handle(req("/users"))).status).toBe(404);
    expect((await app.handle(req("/users/"))).status).toBe(404);
  });

  it("static-over-param priority holds when the fast pattern is registered first", async () => {
    const app = new Eleu(quiet);
    app.get("/a/b/:y", (c) => c.text(`y:${c.params?.["y"]}`));
    app.get("/a/:x", (c) => c.text(`x:${c.params?.["x"]}`));
    expect(await (await app.handle(req("/a/b/1"))).text()).toBe("y:1");
    expect(await (await app.handle(req("/a/c"))).text()).toBe("x:c");
    // "/a/b" (two segments) matches the shorter param route, not the deeper one
    expect(await (await app.handle(req("/a/b"))).text()).toBe("x:b");
  });

  it("repeated param names keep the LATEST capture on both matcher paths", async () => {
    const app = new Eleu(quiet);
    app.get("/dup/:x/:x", (c) => c.text(`x:${c.params?.["x"]}`));
    // fast path (single simple pattern in the bucket)
    expect(await (await app.handle(req("/dup/1/2"))).text()).toBe("x:2");
    // trie path (a second dynamic pattern disables the fast matcher)
    app.get("/dup/other/*", (c) => c.text("wild"));
    expect(await (await app.handle(req("/dup/3/4"))).text()).toBe("x:4");
  });
});

describe("locks correct: trie priority matrix (optionals, variants, wildcards)", () => {
  it("first-registered wins: /a/:x? over /a/:x(\\d+) over /a/*", async () => {
    const app = new Eleu(quiet);
    app.get("/a/:x?", (c) => c.text(`opt:${c.params?.["x"] ?? "-"}`));
    app.get("/a/:x(\\d+)", (c) => c.text(`num:${c.params?.["x"]}`));
    app.get("/a/*", (c) => c.text(`wild:${c.params?.["wildcard"]}`));
    expect(await (await app.handle(req("/a"))).text()).toBe("opt:-");
    // "/a/": the optional-skip pops before the wildcard's empty capture
    expect(await (await app.handle(req("/a/"))).text()).toBe("opt:-");
    expect(await (await app.handle(req("/a/5"))).text()).toBe("opt:5");
    expect(await (await app.handle(req("/a/x"))).text()).toBe("opt:x");
    expect(await (await app.handle(req("/a/x/y"))).text()).toBe("wild:x/y");
  });

  it("an optional param in mid-position skips only when consuming dead-ends", async () => {
    const app = new Eleu(quiet);
    app.get("/a/:x?/b", (c) => c.text(`x:${c.params?.["x"] ?? "-"}`));
    expect(await (await app.handle(req("/a/b"))).text()).toBe("x:-"); // skip
    expect(await (await app.handle(req("/a/x/b"))).text()).toBe("x:x"); // consume
    expect((await app.handle(req("/a/b/c"))).status).toBe(404);
    expect((await app.handle(req("/a"))).status).toBe(404);
  });

  it("an optional custom-pattern param skips non-matching segments at the end", async () => {
    const app = new Eleu(quiet);
    app.get("/n/:x(\\d+)?", (c) => c.text(`x:${c.params?.["x"] ?? "-"}`));
    expect(await (await app.handle(req("/n"))).text()).toBe("x:-");
    expect(await (await app.handle(req("/n/"))).text()).toBe("x:-");
    expect(await (await app.handle(req("/n/5"))).text()).toBe("x:5");
    expect((await app.handle(req("/n/abc"))).status).toBe(404);
  });

  it("optional param followed by wildcard composes both skip and consume paths", async () => {
    const app = new Eleu(quiet);
    app.get("/a/:x?/*", (c) =>
      c.text(`x:${c.params?.["x"] ?? "-"} w:${c.params?.["wildcard"] ?? "-"}`),
    );
    expect(await (await app.handle(req("/a/"))).text()).toBe("x:- w:");
    expect(await (await app.handle(req("/a/b"))).text()).toBe("x:- w:b");
    expect(await (await app.handle(req("/a/b/c"))).text()).toBe("x:b w:c");
    expect((await app.handle(req("/a"))).status).toBe(404);
  });

  it("a required-param sibling is never served through another route's optional skip", async () => {
    const app = new Eleu(quiet);
    app.get("/a/:x/b", (c) => c.text(`req:${c.params?.["x"]}`));
    app.get("/a/:x?/c", (c) => c.text(`opt:${c.params?.["x"] ?? "-"}`));
    expect(await (await app.handle(req("/a/y/b"))).text()).toBe("req:y");
    expect(await (await app.handle(req("/a/c"))).text()).toBe("opt:-");
    expect(await (await app.handle(req("/a/y/c"))).text()).toBe("opt:y");
    expect((await app.handle(req("/a/b"))).status).toBe(404);
  });
});

describe("locks correct: methods, 405/Allow/501/OPTIONS", () => {
  it("HEAD on a POST-only route yields 405 with Allow: POST", async () => {
    const app = new Eleu(quiet);
    app.post("/x", (c) => c.text("p"));
    const res = await app.handle(req("/x", { method: "HEAD" }));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("unknown request methods yield 501 while advertising known ones", async () => {
    const app = new Eleu(quiet);
    app.get("/x", (c) => c.text("g"));
    const res = await app.handle(req("/x", { method: "PROPFIND" }));
    expect(res.status).toBe(501);
    expect(res.headers.get("allow")).toBe("HEAD, GET");
  });

  it("an explicit GET beats ALL; other methods fall through to ALL", async () => {
    const app = new Eleu(quiet);
    app.all("/x", (c) => c.text("all"));
    app.get("/x", (c) => c.text("get"));
    expect(await (await app.handle(req("/x"))).text()).toBe("get");
    expect(await (await app.handle(req("/x", { method: "POST" }))).text()).toBe("all");
  });

  it("registration-time guards: unknown method and empty segments throw", () => {
    const app = new Eleu(quiet);
    expect(() => app.on("FETCH", "/x", () => undefined as never)).toThrow(/Unknown HTTP method/);
    expect(() => app.get("/a//b", () => undefined as never)).toThrow(/empty segment/);
    expect(() => app.get("users", () => undefined as never)).toThrow(/must start with/);
  });
});

describe("locks correct: mounts, params and ws re-keying", () => {
  it("mount nesting through a middle app composes prefixes", async () => {
    const app = new Eleu(quiet);
    const leaf = new Router();
    leaf.get("/leaf", (c) => c.text("leaf"));
    const mid = new Eleu(quiet);
    mid.mount("/c", leaf);
    app.mount("/a", mid);
    expect(await (await app.handle(req("/a/c/leaf"))).text()).toBe("leaf");
  });

  it("mount('/') mounts at the root without doubling slashes", async () => {
    const app = new Eleu(quiet);
    const sub = new Router();
    sub.get("/x", (c) => c.text("x"));
    app.mount("/", sub);
    expect((await app.handle(req("/x"))).status).toBe(200);
  });

  it("koa order along a mounted chain: sub use() > param middleware > handler", async () => {
    const app = new Eleu(quiet);
    const order: string[] = [];
    const sub = new Router();
    sub.use(async (_c, next) => {
      order.push("use");
      await next();
    });
    sub.param("id", async (_c, next) => {
      order.push("param");
      await next();
    });
    sub.get("/u/:id", (c) => {
      order.push("handler");
      c.text("ok");
    });
    app.mount("/api", sub);
    await app.handle(req("/api/u/1"));
    expect(order).toEqual(["use", "param", "handler"]);
  });

  it("a param middleware merged by mount() also reaches routes registered before it", async () => {
    const app = new Eleu(quiet);
    let ran = false;
    app.get("/early/:id", (c) => c.text("early"));
    const sub = new Router();
    sub.param("id", (_c, next) => {
      ran = true;
      return next();
    });
    app.mount("/sub", sub);
    await app.handle(req("/early/1"));
    expect(ran).toBe(true);
  });

  it("the same router can be mounted at two prefixes", async () => {
    const app = new Eleu(quiet);
    const sub = new Router();
    sub.get("/leaf", (c) => c.text("leaf"));
    app.mount("/x", sub);
    app.mount("/y", sub);
    expect((await app.handle(req("/x/leaf"))).status).toBe(200);
    expect((await app.handle(req("/y/leaf"))).status).toBe(200);
  });

  it("ws registrations re-key under every mount level; duplicate keys refuse", () => {
    const app = new Eleu(quiet);
    const inner = new Eleu(quiet);
    inner.ws("/sock", { open: () => {} });
    const mid = new Eleu(quiet);
    mid.mount("/m", inner);
    app.mount("/top", mid);
    expect(app.wsRoutes.has("/top/m/sock")).toBe(true);
    const dup = new Eleu(quiet);
    dup.ws("/s", { open: () => {} });
    app.mount("/x", createAppWithWs("/s"));
    expect(() => app.mount("/x", dup)).toThrow(/already registered/);
  });
});

const createAppWithWs = (path: string) => {
  const a = new Eleu(quiet);
  a.ws(path, { open: () => {} });
  return a;
};

describe("locks correct: url() building and redirects", () => {
  it("a param-first pattern builds with the leading slash", () => {
    const app = new Eleu(quiet);
    app.get("p", "/:x/y", () => undefined as never);
    expect(app.url("p", { x: "1" })).toBe("/1/y");
  });

  it("decoded static ? and # are re-encoded for the wire", () => {
    const app = new Eleu(quiet);
    app.get("q", "/a%3Fb%23c", () => undefined as never);
    expect(app.url("q", {})).toBe("/a%3Fb%23c");
  });

  it("wildcard values keep '/', other unsafe characters encode", () => {
    const app = new Eleu(quiet);
    app.get("w", "/w/*", () => undefined as never);
    expect(app.url("w", { wildcard: "a/b c" })).toBe("/w/a/b%20c");
    expect(app.url("w", { wildcard: "x?y#z" })).toBe("/w/x%3Fy%23z");
    expect(() => app.url("w", {})).toThrow(/Missing required parameter/);
  });

  it("a query-string destination is verbatim; params substitute; missing ones throw eagerly", async () => {
    const app = new Eleu(quiet);
    app.redirect("/old", "/new?a=1", 302);
    app.redirect("/u/:id", "/v/:id", 302);
    expect(() => app.redirect("/plain", "/b/:x")).toThrow(/never captures/);
    const r1 = await app.handle(req("/old"));
    expect(r1.headers.get("location")).toBe("/new?a=1");
    const r2 = await app.handle(req("/u/a%20b"));
    expect(r2.headers.get("location")).toBe("/v/a%20b");
  });

  it("an optional destination param is skipped when absent at runtime", async () => {
    const app = new Eleu(quiet);
    app.redirect("/u/:id", "/v/:id?/tail", 302);
    const res = await app.handle(req("/u/9"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/v/9/tail");
  });
});

describe("locks correct: trailing-slash parity between static and dynamic routes", () => {
  it("one trailing slash matches everywhere; two do not", async () => {
    const app = new Eleu(quiet);
    app.get("/page", (c) => c.text("s"));
    app.get("/users/:id", (c) => c.text("u"));
    app.get("/opt/:x?", (c) => c.text("o"));
    app.get("/w/*", (c) => c.text("w"));
    expect((await app.handle(req("/page/"))).status).toBe(200);
    expect((await app.handle(req("/users/42/"))).status).toBe(200);
    expect((await app.handle(req("/opt/"))).status).toBe(200);
    expect((await app.handle(req("/w/"))).status).toBe(200);
    expect((await app.handle(req("/page//"))).status).toBe(404);
  });

  it("a non-root wildcard does NOT answer its bare prefix without the slash", async () => {
    const app = new Eleu(quiet);
    app.get("/w/*", (c) => c.text(`w:${c.params?.["wildcard"]}`));
    expect((await app.handle(req("/w"))).status).toBe(404);
    expect(await (await app.handle(req("/w/"))).text()).toBe("w:");
  });
});

describe("locks correct: native-sunk path conflicts see through encodings", () => {
  it("an encoded twin of a sunk static path refuses to register", () => {
    const app = new Eleu(quiet);
    app.sink("/esc%20ped", new Response("ok"));
    expect(() => app.get("/esc ped", () => undefined as never)).toThrow(/overlaps/);
  });

  it("an encoded twin inside a sunk wildcard subtree refuses to register", () => {
    const app = new Eleu(quiet);
    app.sink("/a%20b/*", { dir: "/tmp" });
    expect(() => app.get("/a b/x", () => undefined as never)).toThrow(/overlaps/);
  });
});
