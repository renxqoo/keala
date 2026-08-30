import { describe, expect, it } from "vitest";

import {
  compilePattern,
  createNode,
  createTarget,
  insertPattern,
  isStaticPattern,
  matchPattern,
} from "../src/router/trie.ts";

const build = (pattern: string) => {
  const root = createNode();
  const segments = compilePattern(pattern);
  const node = insertPattern(root, segments);
  node.target = createTarget();
  return root;
};

describe("compilePattern", () => {
  it("compiles static segments", () => {
    const segments = compilePattern("/users/all");
    expect(segments).toEqual([
      { kind: "static", value: "users", pattern: null, optional: false },
      { kind: "static", value: "all", pattern: null, optional: false },
    ]);
    expect(isStaticPattern(segments)).toBe(true);
  });

  it("compiles params, custom patterns and optionals", () => {
    const segments = compilePattern("/users/:id(\\d+)/files/:name?");
    const id = segments[1];
    expect(id?.kind).toBe("param");
    expect(id?.value).toBe("id");
    expect(id?.optional).toBe(false);
    expect(id?.pattern?.test("123")).toBe(true);
    expect(id?.pattern?.test("abc")).toBe(false);
    expect(segments[3]).toEqual({ kind: "param", value: "name", pattern: null, optional: true });
    expect(isStaticPattern(segments)).toBe(false);
  });

  it("compiles wildcards", () => {
    const segments = compilePattern("/static/*");
    expect(segments[1]?.kind).toBe("wildcard");
  });

  it("decodes static segments", () => {
    const segments = compilePattern("/spa%20ce");
    expect(segments[0]?.value).toBe("spa ce");
  });

  it("rejects malformed patterns", () => {
    expect(() => compilePattern("users")).toThrow(TypeError);
    expect(() => compilePattern("/a//b")).toThrow(TypeError);
    expect(() => compilePattern("/a/*/b")).toThrow(TypeError);
    expect(() => compilePattern("/:x(unbalanced/b")).toThrow(TypeError);
    expect(() => compilePattern("/:?(x)")).toThrow(TypeError);
  });
});

describe("matchPattern", () => {
  it("matches static paths exactly", () => {
    const root = build("/users/all");
    expect(matchPattern(root, "/users/all")?.target).toBe(
      root.children.get("users")?.children.get("all")?.target ?? null,
    );
    expect(matchPattern(root, "/users/none")).toBe(null);
    expect(matchPattern(root, "/users")).toBe(null);
  });

  it("ignores trailing slashes on both sides", () => {
    const root = build("/users/all");
    expect(matchPattern(root, "/users/all/")).not.toBe(null);
    expect(build("/users/all/")).toBeDefined();
  });

  it("extracts params", () => {
    const root = build("/users/:id/posts/:pid");
    const match = matchPattern(root, "/users/42/posts/7");
    expect(match?.params).toEqual({ id: "42", pid: "7" });
  });

  it("enforces custom patterns", () => {
    const root = build("/users/:id(\\d+)");
    expect(matchPattern(root, "/users/42")?.params).toEqual({ id: "42" });
    expect(matchPattern(root, "/users/abc")).toBe(null);
  });

  it("prefers static children over params", () => {
    const root = createNode();
    const paramRoute = insertPattern(root, compilePattern("/shop/:name"));
    paramRoute.target = createTarget();
    const staticRoute = insertPattern(root, compilePattern("/shop/new"));
    staticRoute.target = createTarget();
    const match = matchPattern(root, "/shop/new");
    expect(match?.target).toBe(staticRoute.target);
    expect(matchPattern(root, "/shop/other")?.target).toBe(paramRoute.target);
  });

  it("supports optional params", () => {
    const root = build("/files/:name?");
    expect(matchPattern(root, "/files/a.txt")?.params).toEqual({ name: "a.txt" });
    const without = matchPattern(root, "/files");
    expect(without?.params).toEqual(Object.create(null));
    expect(without).not.toBe(null);
  });

  it("supports optional params before static segments", () => {
    const root = build("/repos/:owner?/settings");
    expect(matchPattern(root, "/repos/acme/settings")?.params).toEqual({ owner: "acme" });
    expect(matchPattern(root, "/repos/settings")?.params).toEqual(Object.create(null));
  });

  it("captures wildcards", () => {
    const root = build("/assets/*");
    const match = matchPattern(root, "/assets/css/app.css");
    expect(match?.params).toEqual({ wildcard: "css/app.css" });
    expect(matchPattern(root, "/assets")).toBe(null);
  });

  it("decodes percent-encoded params", () => {
    const root = build("/users/:name");
    expect(matchPattern(root, "/users/%E4%B8%AD")?.params).toEqual({ name: "中" });
  });

  it("matches the root path", () => {
    const root = build("/");
    expect(matchPattern(root, "/")).not.toBe(null);
  });

  it("backtracks through multiple optional layers", () => {
    const root = build("/a/:x?/b/:y?");
    expect(matchPattern(root, "/a/1/b/2")?.params).toEqual({ x: "1", y: "2" });
    expect(matchPattern(root, "/a/1/b")?.params).toEqual({ x: "1" });
    expect(matchPattern(root, "/a/b")?.params).toEqual(Object.create(null));
    expect(matchPattern(root, "/a/b/c")?.params).toEqual({ y: "c" });
  });
});
