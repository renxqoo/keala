/**
 * R413 bucket-regex fast layer — the differential and behavior locks.
 *
 * The trie stays the semantic reference: for every probe path, matchRoute
 * (which may answer from the static map, bucket fast matcher, bucket regex
 * or trie) must return the SAME target object and params as the bare trie
 * walk. Behavior tests then pin the layer's own contract: precedence,
 * static tails, late registration, escaped-path bypass and interplay with
 * c.routePath (Fix 4 reads the same RouteTarget).
 */

import { describe, expect, it } from "vitest";

import { Keala } from "../src/core/app.ts";
import { createRouterState, matchRoute, registerDef } from "../src/router/router.ts";
import { matchPattern } from "../src/router/trie.ts";

const quiet = { env: "test" } as const;
const handler = () => new Response("x");

/** A table mixing eligible, non-eligible and static shapes. */
const buildState = () => {
  const state = createRouterState();
  const add = (method: string, path: string): void => {
    registerDef(state, method, path, [handler]);
  };
  add("GET", "/user");
  add("GET", "/user/comments");
  add("GET", "/user/avatar");
  add("GET", "/user/lookup/username/:username");
  add("GET", "/user/lookup/email/:address");
  add("GET", "/event/:id");
  add("GET", "/event/:id/comments");
  add("POST", "/event/:id/comment");
  add("GET", "/map/:location/events");
  add("GET", "/status");
  add("GET", "/very/deeply/nested/route/hello/there");
  add("GET", "/static/*");
  // Non-eligible shapes: the trie must keep answering them.
  add("GET", "/opt/:maybe?");
  add("GET", "/digits/:id(\\d+)");
  add("GET", "/mixed/:a/:b?");
  return state;
};

const PROBES = [
  "/user",
  "/user/comments",
  "/user/lookup/username/hey",
  "/user/lookup/email/a@b.c",
  "/event/abcd1234",
  "/event/abcd1234/comments",
  "/map/berlin/events",
  "/very/deeply/nested/route/hello/there",
  "/static/index.html",
  "/opt/sure",
  "/opt",
  "/digits/123",
  "/digits/notdigits",
  "/mixed/x",
  "/mixed/x/y",
  "/nowhere",
  "/event",
  "/event/",
  "/map/berlin",
  "/user/lookup/username/caf%C3%A9",
  "/event/%31%32%33/comments",
];

describe("R413 bucket regex: differential against the trie", () => {
  it("matchRoute and the bare trie walk agree on target identity and params", () => {
    const state = buildState();
    for (const path of PROBES) {
      // The bare trie walk is the oracle for DYNAMIC matching only — exact
      // static probes are answered by the staticMap before either layer.
      if (state.staticMap.has(path)) continue;
      const fast = matchRoute(state, path);
      const slow = matchPattern(state.trieRoot, path);
      if (slow === null) {
        expect(fast, path).toBeNull();
        continue;
      }
      expect(fast, path).not.toBeNull();
      expect(fast?.target, path).toBe(slow.target);
      expect(fast?.params ?? null, path).toEqual(slow.params);
    }
  });

  it("the bucket regex actually served the multi-route shapes (coverage guard)", () => {
    const state = buildState();
    // First match compiles and caches; the epoch stays valid.
    expect(matchRoute(state, "/event/7/comments")?.params).toEqual({ id: "7" });
    expect(matchRoute(state, "/event/8")?.params).toEqual({ id: "8" });
    // "event" holds 3 dynamic defs → bucket.fast is null → regex layer.
    expect(state.buckets.get("event")?.fast ?? null).toBeNull();
    expect(state.buckets.get("event")?.regex?.compiled ?? null).not.toBeNull();
    // "map" is a single NON-simple def (static tail) → regex, not fast.
    expect(matchRoute(state, "/map/berlin/events")?.params).toEqual({ location: "berlin" });
    expect(state.buckets.get("map")?.fast ?? null).toBeNull();
    expect(state.buckets.get("map")?.regex?.compiled ?? null).not.toBeNull();
  });

  it("statics beat params at the first divergence (wildcard stays lowest)", () => {
    const state = createRouterState();
    registerDef(state, "GET", "/a/:x/tail", [handler]);
    registerDef(state, "GET", "/a/b/:y", [handler]);
    expect(matchRoute(state, "/a/b/zz")?.params).toEqual({ y: "zz" });

    // A wildcard sibling must neither join the regex nor shadow the param.
    const wild = createRouterState();
    registerDef(wild, "GET", "/w/*", [handler]);
    registerDef(wild, "GET", "/w/:x", [handler]);
    expect(wild.regexIndex.has("/w/*")).toBe(false);
    expect(matchRoute(wild, "/w/one")?.params).toEqual({ x: "one" });
    expect(matchRoute(wild, "/w/one/two")?.params).toEqual({ wildcard: "one/two" });

    const wildReversed = createRouterState();
    registerDef(wildReversed, "GET", "/w/:x", [handler]);
    registerDef(wildReversed, "GET", "/w/*", [handler]);
    expect(matchRoute(wildReversed, "/w/one")?.params).toEqual({ x: "one" });
    expect(matchRoute(wildReversed, "/w/one/two")?.params).toEqual({ wildcard: "one/two" });
  });

  it("a late registration retires the epoch and recompiles the bucket", () => {
    const state = createRouterState();
    registerDef(state, "GET", "/n/:a", [handler]);
    expect(matchRoute(state, "/n/1")?.params).toEqual({ a: "1" });
    registerDef(state, "GET", "/n/:a/x", [handler]);
    expect(matchRoute(state, "/n/1/x")?.params).toEqual({ a: "1" });
    expect(matchRoute(state, "/n/1")?.params).toEqual({ a: "1" });
  });
});

describe("R413 bucket regex: end-to-end contract", () => {
  it("params, routePath and routeName read the same target through the fast layer", async () => {
    const app = new Keala(quiet);
    app.get("comments", "/event/:id/comments", (c) =>
      c.text(`${c.params["id"]}:${c.routePath}:${c.routeName ?? ""}`),
    );
    app.get("/event/:id", (c) => c.text(`bare:${c.params["id"]}`));
    const res = await app.handle(new Request("http://x/event/42/comments"));
    expect(await res.text()).toBe("42:/event/:id/comments:comments");
    expect(await (await app.handle(new Request("http://x/event/42"))).text()).toBe("bare:42");
  });

  it("escaped paths keep trie semantics (decoded params, canonical statics)", async () => {
    const app = new Keala(quiet);
    app.get("/user/lookup/username/:username", (c) => c.text(c.params["username"]!));
    app.get("/event/:id/comments", (c) => c.text(c.params["id"]!));
    const name = await app.handle(new Request("http://x/user/lookup/username/caf%C3%A9"));
    expect(await name.text()).toBe("café");
    const encoded = await app.handle(new Request("http://x/event/%31%32%33/comments"));
    expect(await encoded.text()).toBe("123");
  });

  it("405 through the fast layer still carries the matched target", async () => {
    const app = new Keala(quiet);
    app.get("/event/:id/comments", (c) => c.text("ok"));
    const res = await app.handle(new Request("http://x/event/1/comments", { method: "POST" }));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toContain("GET");
  });
});
