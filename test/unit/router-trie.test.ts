import { describe, expect, it } from "vitest";

import { compilePattern, decodeSegment, paramNamesOf } from "../../src/router/pattern.ts";
import {
  createNode,
  createTarget,
  insertPattern,
  matchPattern,
  type TrieNode,
} from "../../src/router/trie.ts";
import { Keala } from "../../src/core/app.ts";
import { createRouterState, matchRoute, registerDef } from "../../src/router/router.ts";
/**
 * Trie unit semantics: pattern IR compilation and the dynamic-match source of
 * truth (priority, optionals, custom patterns, wildcards, encoding).
 */

const setTargets = (root: ReturnType<typeof createNode>, pattern: string) => {
  // insertPattern returns EVERY terminal (optional params yield one per
  // skip/consume combination) — they all share one target.
  const terminals = insertPattern(root, compilePattern(pattern).segments);
  const target = createTarget();
  for (const terminal of terminals) terminal.target = target;
};

const withTarget = (pattern: string) => {
  const root = createNode();
  setTargets(root, pattern);
  return root;
};

describe("compilePattern", () => {
  it("parses static, param, optional, custom-pattern and wildcard segments", () => {
    const ir = compilePattern("/users/:id(\\d+)/files/:name?/*");
    expect(ir.segments.map((s) => [s.kind, s.value])).toEqual([
      ["static", "users"],
      ["param", "id"],
      ["static", "files"],
      ["param", "name"],
      ["wildcard", "wildcard"],
    ]);
    expect(ir.isStatic).toBe(false);
    expect(paramNamesOf(ir.segments)).toEqual(["id", "name", "wildcard"]);
    expect(ir.segments[1]?.optional).toBe(false);
    expect(ir.segments[3]?.optional).toBe(true);
  });

  it("flags simple shapes (static head + plain params) for the fast matcher", () => {
    expect(compilePattern("/users/:id").isSimple).toBe(true);
    expect(compilePattern("/a/:x/:y").isSimple).toBe(true);
    expect(compilePattern("/:first/:x").isSimple).toBe(false); // param head
    expect(compilePattern("/a/:x?").isSimple).toBe(false); // optional
    expect(compilePattern("/a/:x(\\d+)").isSimple).toBe(false); // custom pattern
    expect(compilePattern("/a/*").isSimple).toBe(false); // wildcard
    expect(compilePattern("/a/b").isSimple).toBe(false); // static (not dynamic)
  });

  it("decodes static segments at compile time", () => {
    expect(compilePattern("/caf%C3%A9/x").segments[0]?.value).toBe("café");
  });

  it.each(["", "no-slash", "/a//b", "/a/:", "/a/:x(y", "/*/middle", "/a/:na?me?"])(
    "rejects malformed pattern %p",
    (pattern) => {
      expect(() => compilePattern(pattern)).toThrow(TypeError);
    },
  );

  it("decodeSegment is identity for escape-free input and verbatim for bad escapes", () => {
    expect(decodeSegment("plain")).toBe("plain");
    expect(decodeSegment("a%20b")).toBe("a b");
    expect(decodeSegment("%E4%B8%AD")).toBe("中");
    expect(decodeSegment("%")).toBe("%");
    expect(decodeSegment("100%25")).toBe("100%");
  });
});

describe("trie matching", () => {
  it.each([
    ["/users/:id", "/users/7", { id: "7" }],
    ["/files/:name?", "/files/f", { name: "f" }],
    ["/files/:name?", "/files", {}],
    ["/n/:num(\\d+)", "/n/42", { num: "42" }],
    ["/n/:num(\\d+)", "/n/abc", null],
    ["/assets/*", "/assets/a/b/c", { wildcard: "a/b/c" }],
    ["/x/:a/:b?", "/x/1", { a: "1" }],
    ["/x/:a/:b?", "/x/1/2", { a: "1", b: "2" }],
  ] as const)("pattern %s on %s", (pattern, path, params) => {
    const root = withTarget(pattern);
    const match = matchPattern(root, path);
    if (params === null) {
      expect(match).toBeNull();
      return;
    }
    expect(match?.params).toEqual(params);
  });

  it("static beats param beats wildcard at the same position", () => {
    const root = createNode();
    for (const pattern of ["/shop/*", "/shop/:name", "/shop/new"]) {
      setTargets(root, pattern);
    }
    expect(matchPattern(root, "/shop/new")?.target).toBeDefined();
    expect(matchPattern(root, "/shop/abc")?.params).toEqual({ name: "abc" });
    expect(matchPattern(root, "/shop/new/extra")?.params).toEqual({
      wildcard: "new/extra",
    });
  });

  it("escaped static segments retry decoded (trie static children)", () => {
    const root = withTarget("/caf%C3%A9/menu");
    expect(matchPattern(root, "/caf%C3%A9/menu")).not.toBeNull();
    expect(matchPattern(root, "/café/menu")).not.toBeNull();
  });

  it("request escapes decode in captures; %2F stays one segment", () => {
    const root = withTarget("/u/:name");
    expect(matchPattern(root, "/u/%E4%B8%AD")?.params).toEqual({ name: "中" });
    expect(matchPattern(root, "/u/a%2Fb")?.params).toEqual({ name: "a/b" });
  });

  it("empty segments never match params (404, not empty capture)", () => {
    const root = withTarget("/a/:x");
    expect(matchPattern(root, "/a/")).toBeNull();
    expect(matchPattern(root, "/a//b")).toBeNull();
  });

  it("conflicting param names at one position throw at insert", () => {
    const root = createNode();
    insertPattern(root, compilePattern("/:a/x").segments);
    expect(() => insertPattern(root, compilePattern("/:b/y").segments)).toThrow(
      /Conflicting parameter names/,
    );
  });

  it("same-name params with different patterns stay separate variants, both reachable", () => {
    const root = createNode();
    setTargets(root, "/n/:id");
    setTargets(root, "/n/:id(\\d+)?");
    const node = root.children.get("n");
    // The plain head keeps its identity — the custom pattern is a variant.
    expect(node?.param?.pattern).toBeNull();
    expect(node?.paramMore?.length).toBe(1);
    expect(node?.paramMore?.[0]?.skipNode).not.toBeNull();
    // Every variant's subtree stays reachable.
    expect(matchPattern(root, "/n/word")).not.toBeNull();
    expect(matchPattern(root, "/n/7")).not.toBeNull();
    expect(matchPattern(root, "/n")).not.toBeNull();
  });

  it("identical patterns merge into one variant with sticky optionality", () => {
    const root = createNode();
    setTargets(root, "/n/:id(\\d+)");
    setTargets(root, "/n/:id(\\d+)?");
    const node = root.children.get("n");
    expect(node?.paramMore).toBeNull();
    expect(node?.param?.skipNode).not.toBeNull();
    expect(matchPattern(root, "/n")).not.toBeNull();
    expect(matchPattern(root, "/n/7")).not.toBeNull();
    expect(matchPattern(root, "/n/x")).toBeNull();
  });
});

describe("variant lookup", () => {
  it("a third distinct pattern walks past the head and existing variants", () => {
    const root = createNode();
    setTargets(root, "/n/:id(\\d+)");
    setTargets(root, "/n/:id([a-z]+)");
    setTargets(root, "/n/:id(\\w+-\\w+)");
    expect(matchPattern(root, "/n/7")).not.toBeNull();
    expect(matchPattern(root, "/n/abc")).not.toBeNull();
    expect(matchPattern(root, "/n/a-b")).not.toBeNull();
    expect(matchPattern(root, "/n/a.b")).toBeNull();
  });
});

describe("variant priority", () => {
  it("the FIRST-registered variant wins when several match", () => {
    const root = createNode();
    const [restrictive] = insertPattern(root, compilePattern("/files/:id(\\d+)").segments) as [
      TrieNode,
    ];
    restrictive.target = createTarget();
    const [plain] = insertPattern(root, compilePattern("/files/:id").segments) as [TrieNode];
    plain.target = createTarget();
    // "123" satisfies BOTH — the numeric (first-registered) route must own it.
    expect(matchPattern(root, "/files/123")?.target).toBe(restrictive.target);
    // Only the plain variant matches words.
    expect(matchPattern(root, "/files/readme")?.target).toBe(plain.target);
  });

  it("three variants keep registration order across the board", () => {
    const root = createNode();
    const [numeric] = insertPattern(root, compilePattern("/v/:x(\\d+)").segments) as [TrieNode];
    numeric.target = createTarget();
    const [alpha] = insertPattern(root, compilePattern("/v/:x([a-z]+)").segments) as [TrieNode];
    alpha.target = createTarget();
    const [plain] = insertPattern(root, compilePattern("/v/:x").segments) as [TrieNode];
    plain.target = createTarget();
    expect(matchPattern(root, "/v/42")?.target).toBe(numeric.target);
    expect(matchPattern(root, "/v/abc")?.target).toBe(alpha.target);
    expect(matchPattern(root, "/v/a.b")?.target).toBe(plain.target);
  });

  it("the first-registered OPTIONAL variant wins at end-of-path", () => {
    const root = createNode();
    setTargets(root, "/a/:x?");
    setTargets(root, "/a/:x(\\d+)?");
    const node = root.children.get("a");
    // The end-of-path skip lands in the HEAD variant's skip subtree; the
    // consume path lands in its consume node — both first-registered.
    expect(matchPattern(root, "/a")?.target).toBe(node?.param?.skipNode?.target);
    expect(matchPattern(root, "/a/7")?.target).toBe(node?.param?.node.target);
  });
});

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
  "/static/deep/dir/file.css",
  "/static",
  "/static/",
  "/static//dbl",
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

    // Wildcards now RIDE the fast layer as the bucket's fallback group:
    // exact-count alternatives win first, the wildcard answers the rest.
    for (const order of [
      ["/w/*", "/w/:x"],
      ["/w/:x", "/w/*"],
    ]) {
      const wild = createRouterState();
      for (const p of order) registerDef(wild, "GET", p, [handler]);
      expect(wild.regexIndex.has("/w/*")).toBe(true);
      expect(matchRoute(wild, "/w/one")?.params).toEqual({ x: "one" });
      expect(matchRoute(wild, "/w/one/two")?.params).toEqual({ wildcard: "one/two" });
      // Trailing-slash normalization: "/w/two/" segments as [w, two], so
      // the param still outranks the wildcard (trie agrees).
      expect(matchRoute(wild, "/w/two/")?.params).toEqual({ x: "two" });
      expect(matchRoute(wild, "/w/a/b/")?.params).toEqual({ wildcard: "a/b" });
      expect(matchRoute(wild, "/w")).toBeNull(); // bare prefix is a different resource
    }

    // Deeper static prefix outranks a shallower wildcard (trie pop order).
    for (const order of [
      ["/w2/b/*", "/w2/*"],
      ["/w2/*", "/w2/b/*"],
    ]) {
      const deep = createRouterState();
      for (const p of order) registerDef(deep, "GET", p, [handler]);
      expect(matchRoute(deep, "/w2/b/x")?.params).toEqual({ wildcard: "x" });
      expect(matchRoute(deep, "/w2/c/x")?.params).toEqual({ wildcard: "c/x" });
    }

    // A count-group pattern beats the wildcard for its own shape.
    const mixed = createRouterState();
    registerDef(mixed, "GET", "/w4/:x/y", [handler]);
    registerDef(mixed, "GET", "/w4/*", [handler]);
    expect(matchRoute(mixed, "/w4/a/y")?.params).toEqual({ x: "a" });
    expect(matchRoute(mixed, "/w4/a/z")?.params).toEqual({ wildcard: "a/z" });
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
