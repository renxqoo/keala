/**
 * Trie unit semantics: pattern IR compilation and the dynamic-match source of
 * truth (priority, optionals, custom patterns, wildcards, encoding).
 */

import { describe, expect, it } from "vitest";

import { compilePattern, decodeSegment, paramNamesOf } from "../src/router/pattern.ts";
import { createNode, insertPattern, matchPattern, createTarget } from "../src/router/trie.ts";

const withTarget = (pattern: string) => {
  const root = createNode();
  const ir = compilePattern(pattern);
  const node = insertPattern(root, ir.segments);
  node.target = createTarget();
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
      insertPattern(root, compilePattern(pattern).segments).target = createTarget();
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
    insertPattern(root, compilePattern("/n/:id").segments).target = createTarget();
    insertPattern(root, compilePattern("/n/:id(\\d+)?").segments).target = createTarget();
    const node = root.children.get("n");
    // The plain head keeps its identity — the custom pattern is a variant.
    expect(node?.param?.pattern).toBeNull();
    expect(node?.paramMore?.length).toBe(1);
    expect(node?.paramMore?.[0]?.optional).toBe(true);
    // Every variant's subtree stays reachable.
    expect(matchPattern(root, "/n/word")).not.toBeNull();
    expect(matchPattern(root, "/n/7")).not.toBeNull();
    expect(matchPattern(root, "/n")).not.toBeNull();
  });

  it("identical patterns merge into one variant with sticky optionality", () => {
    const root = createNode();
    insertPattern(root, compilePattern("/n/:id(\\d+)").segments).target = createTarget();
    insertPattern(root, compilePattern("/n/:id(\\d+)?").segments).target = createTarget();
    const node = root.children.get("n");
    expect(node?.paramMore).toBeNull();
    expect(node?.param?.optional).toBe(true);
    expect(matchPattern(root, "/n")).not.toBeNull();
    expect(matchPattern(root, "/n/7")).not.toBeNull();
    expect(matchPattern(root, "/n/x")).toBeNull();
  });
});

describe("variant lookup", () => {
  it("a third distinct pattern walks past the head and existing variants", () => {
    const root = createNode();
    insertPattern(root, compilePattern("/n/:id(\\d+)").segments).target = createTarget();
    insertPattern(root, compilePattern("/n/:id([a-z]+)").segments).target = createTarget();
    insertPattern(root, compilePattern("/n/:id(\\w+-\\w+)").segments).target = createTarget();
    expect(matchPattern(root, "/n/7")).not.toBeNull();
    expect(matchPattern(root, "/n/abc")).not.toBeNull();
    expect(matchPattern(root, "/n/a-b")).not.toBeNull();
    expect(matchPattern(root, "/n/a.b")).toBeNull();
  });
});

describe("variant priority", () => {
  it("the FIRST-registered variant wins when several match", () => {
    const root = createNode();
    const restrictive = insertPattern(root, compilePattern("/files/:id(\\d+)").segments);
    restrictive.target = createTarget();
    const plain = insertPattern(root, compilePattern("/files/:id").segments);
    plain.target = createTarget();
    // "123" satisfies BOTH — the numeric (first-registered) route must own it.
    expect(matchPattern(root, "/files/123")?.target).toBe(restrictive.target);
    // Only the plain variant matches words.
    expect(matchPattern(root, "/files/readme")?.target).toBe(plain.target);
  });

  it("three variants keep registration order across the board", () => {
    const root = createNode();
    const numeric = insertPattern(root, compilePattern("/v/:x(\\d+)").segments);
    numeric.target = createTarget();
    const alpha = insertPattern(root, compilePattern("/v/:x([a-z]+)").segments);
    alpha.target = createTarget();
    const plain = insertPattern(root, compilePattern("/v/:x").segments);
    plain.target = createTarget();
    expect(matchPattern(root, "/v/42")?.target).toBe(numeric.target);
    expect(matchPattern(root, "/v/abc")?.target).toBe(alpha.target);
    expect(matchPattern(root, "/v/a.b")?.target).toBe(plain.target);
  });

  it("the first-registered OPTIONAL variant wins at end-of-path", () => {
    const root = createNode();
    const first = insertPattern(root, compilePattern("/a/:x?").segments);
    first.target = createTarget();
    const second = insertPattern(root, compilePattern("/a/:x(\\d+)?").segments);
    second.target = createTarget();
    expect(matchPattern(root, "/a")?.target).toBe(first.target);
    expect(matchPattern(root, "/a/7")?.target).toBe(first.target);
  });
});
