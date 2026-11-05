/**
 * Regression locks for the fast layers' equivalence with the trie — the
 * review round that found them ran as red tests under test/red-review/
 * (trie + regex reviewers, independently); the fixes landed as:
 *
 *   - fastComparable (pattern.ts): a %2F registered static decodes to a
 *     value containing "/" and can never be compared in the raw path
 *     space — such patterns stay on the trie (bucket-regex eligibility
 *     and the slice fast matcher both gate on it).
 *   - impureFirst (router.ts + bucket-regex.ts): a bucket holding ANY
 *     ineligible static-first dynamic pattern keeps its WHOLE vocabulary
 *     on the trie — an ineligible sibling can be the trie's preferred
 *     answer (static-over-param rank, first-registered variant), so an
 *     eligible exact must not preempt it.
 *   - ONE positionally triePrecedence-sorted alternation (bucket-regex.ts):
 *     the old "all exacts before all wildcards" split inverted the trie's
 *     positional DFS choice; the same-node rule puts `X` before `X/*`
 *     (a terminal returns before that node's wildcard empty-capture edge).
 *   - matchTableRegex (bucket-regex.ts): no pre-strip — exact alternatives
 *     carry `/?` (the trie segments the once-stripped path), a trailing
 *     wildcard capture never includes a single final "/" (normalized),
 *     and "//"-terminated paths fall back to the trie (locked: they match
 *     with the empty-rest wildcard link DROPPED).
 *
 * Every case pins matchRoute (or matchTableRegex) to matchPattern — "the
 * trie … remains the semantic reference" (bucket-regex.ts).
 */
import { describe, expect, it } from "vitest";

import { Keala } from "../../src/core/app.ts";
import { compileTableRegex, matchTableRegex } from "../../src/router/bucket-regex.ts";
import { matchRoute } from "../../src/router/match.ts";
import {
  createRouterState,
  paramsRecord,
  registerDef,
  type RouteMatch,
  type RouterState,
} from "../../src/router/router.ts";
import { matchPattern, type TrieMatch } from "../../src/router/trie.ts";

const quiet = { env: "test" } as const;
const handler = () => new Response("x");

const paramsOf = (m: RouteMatch | TrieMatch | null): Record<string, string> | null =>
  m === null ? null : paramsRecord(m.names, m.values, m.offset);

const build = (patterns: readonly string[]): RouterState => {
  const state = createRouterState();
  for (const p of patterns) registerDef(state, "GET", p, [handler]);
  return state;
};

/** matchRoute must agree with the bare trie walk (target + params) on `path`. */
const expectAgreement = (state: RouterState, path: string): void => {
  const fast = matchRoute(state, path);
  const slow = matchPattern(state.trieRoot, path);
  if (slow === null) {
    expect(fast, `${path}: fast layer matched, trie did not`).toBeNull();
    return;
  }
  expect(fast, `${path}: trie matched, fast layer did not`).not.toBeNull();
  expect(fast?.target, `${path}: target divergence`).toBe(slow.target);
  expect(fast === null ? null : paramsOf(fast), `${path}: params divergence`).toEqual(
    paramsOf(slow),
  );
};

describe("locks correct: %2F statics stay on the trie (raw comparison cannot conflate the boundary)", () => {
  it("the slice fast matcher must not answer the unencoded '/a/b/7' for '/a%2Fb/:id'", () => {
    const state = build(["/a%2Fb/:id"]);
    // compilePattern decodes the static to "a/b" as ONE segment; the trie
    // keys its child "a/b", so a request "/a/b/7" segments as [a,b,7] and
    // can never satisfy it ("%2F stays one segment" — the locked static
    // contract applies to the dynamic side identically).
    expect(matchPattern(state.trieRoot, "/a/b/7")).toBeNull();
    expect(matchRoute(state, "/a/b/7")).toBeNull();
  });

  it("the table regex must not answer it either (slice matcher disabled by a sibling)", () => {
    const state = build(["/a%2Fb/:id", "/a%2Fb/:id/e"]);
    expect(matchPattern(state.trieRoot, "/a/b/7")).toBeNull();
    expect(matchRoute(state, "/a/b/7")).toBeNull();
  });

  it("no wrong-target steal: '/a/b/t' serves the real sibling /a/:y/t", () => {
    const state = build(["/a%2Fb/:id", "/a/:y/t"]);
    expectAgreement(state, "/a/b/t");
  });

  it("decoded metachar + slash combo: '/a%2Bb%2Fc/:x' never serves raw '/a+b/c/1'", () => {
    const state = build(["/a%2Bb%2Fc/:x"]);
    expect(matchPattern(state.trieRoot, "/a+b/c/1")).toBeNull();
    expect(matchRoute(state, "/a+b/c/1")).toBeNull();
  });

  it("the escaped twin itself keeps matching on both layers", () => {
    const state = build(["/a%2Fb/:id"]);
    expectAgreement(state, "/a%2Fb/7");
  });

  it("end-to-end: GET /a/b/1 404s for app.get('/a%2Fb/:id') exactly as the static twin does", async () => {
    const app = new Keala(quiet);
    app.get("/a%2Fb/:id", (c) => c.text(`id=${c.params("id")}`));
    expect((await app.handle(new Request("http://x/a/b/1"))).status).toBe(404);
    expect((await app.handle(new Request("http://x/a%2Fb/1"))).status).toBe(200);
  });
});

describe("locks correct: impure buckets keep their whole vocabulary on the trie", () => {
  it("first-registered constrained variant owns '/u/5/x' — the plain twin must not preempt", () => {
    const state = build(["/u/:id(\\d+)/x", "/u/:id/x"]);
    expect(matchPattern(state.trieRoot, "/u/5/x")?.target.pattern).toBe("/u/:id(\\d+)/x");
    expectAgreement(state, "/u/5/x");
  });

  it("minimal shape: the locked '/files/:id(\\d+) then /files/:id' pair through matchRoute", () => {
    const state = build(["/files/:id(\\d+)", "/files/:id"]);
    const slow = matchPattern(state.trieRoot, "/files/123");
    expect(slow?.target.pattern).toBe("/files/:id(\\d+)");
    expect(matchRoute(state, "/files/123")?.target).toBe(slow?.target);
  });

  it("same class with an optional custom-pattern sibling first: '/u/:x(\\d+)?/y' then '/u/:x/y'", () => {
    const state = build(["/u/:x(\\d+)?/y", "/u/:x/y"]);
    expectAgreement(state, "/u/5/y");
  });

  it("mid-pattern shape: '/a/7/t' serves /a/:x(\\d+)/t", () => {
    const state = build(["/a/:x(\\d+)/t", "/a/:x/t"]);
    expectAgreement(state, "/a/7/t");
  });

  it("an optional param anywhere marks the bucket impure too: '/a/b/:x?' alongside '/a/:y'", () => {
    const state = build(["/a/b/:x?", "/a/:y"]);
    expectAgreement(state, "/a/7");
    expectAgreement(state, "/a/b/8");
    expectAgreement(state, "/a/b");
  });

  it("control: plain-first registration agrees (the head is then the plain variant)", () => {
    const state = build(["/a/:x", "/a/:x(\\d+)"]);
    expectAgreement(state, "/a/7");
    expectAgreement(state, "/a/zz");
  });

  it("end-to-end: the first-registered handler runs for GET /a/7", async () => {
    const app = new Keala(quiet);
    let constrained = false;
    app.get("/a/:x(\\d+)", (c) => {
      constrained = true;
      return c.text(`num:${c.params("x")}`);
    });
    app.get("/a/:x", (c) => c.text(`any:${c.params("x")}`));
    const res = await app.handle(new Request("http://x/a/7"));
    expect([await res.text(), constrained]).toEqual(["num:7", true]);
  });
});

describe("locks correct: positional alternation order (trie DFS, not exacts-vs-wildcards)", () => {
  it("'/a/b/c' serves /a/b/* (static at pos 1 outranks the param)", () => {
    expectAgreement(build(["/a/b/*", "/a/:x/:y"]), "/a/b/c");
    expectAgreement(build(["/a/:x/:y", "/a/b/*"]), "/a/b/c");
  });

  it("unit-level: the compiled table regex returns the wildcard pattern's target (same as the trie)", () => {
    const state = build(["/a/b/*", "/a/:x/:y"]);
    const table = compileTableRegex(state.regexIndex, state.impureFirst);
    expect(table).not.toBeNull();
    const matched = table === null ? null : matchTableRegex(table, "/a/b/c");
    const trie = matchPattern(state.trieRoot, "/a/b/c");
    expect(matched?.target).toBe(trie?.target);
    // The wildcard pattern's target is what the table regex hands back for
    // the deep path (behavioral identity, not regex layout).
    expect(matched?.target?.pattern).toBe("/a/b/*");
  });

  it("realistic shape: /files/static/* wins over /files/:area/:name on /files/static/x", () => {
    expectAgreement(build(["/files/static/*", "/files/:area/:name"]), "/files/static/x");
  });

  it("same-node rule: X answers its wildcard extension's empty-capture path", () => {
    // The exact terminal at the node returns before that node's wildcard
    // edge: "/u/1/" serves /u/:x (x=1), "/u/1/x" serves /u/:x/*.
    expectAgreement(build(["/u/:x", "/u/:x/*"]), "/u/1/");
    expectAgreement(build(["/u/:x/*", "/u/:x"]), "/u/1/");
    expectAgreement(build(["/u/:x", "/u/:x/*"]), "/u/1/x");
  });

  it("control: two co-matchable EXACTS stay ordered correctly (static beats param)", () => {
    expectAgreement(build(["/a/b/:z", "/a/:x/:y"]), "/a/b/c");
  });

  it("end-to-end: the wildcard handler runs for GET /a/b/c", async () => {
    const app = new Keala(quiet);
    app.get("/a/b/*", (c) => c.text(`WILD w=${c.params("wildcard")}`));
    app.get("/a/:x/:y", (c) => c.text(`EXACT x=${c.params("x")} y=${c.params("y")}`));
    const res = await app.handle(new Request("http://x/a/b/c"));
    expect([res.status, await res.text()]).toEqual([200, "WILD w=c"]);
  });
});

describe("locks correct: trailing-slash semantics (no pre-strip; empty-capture boundary)", () => {
  it("'/a/1/' serves the deeper /a/:x/*, not the shallow /a/* with wildcard='1'", () => {
    expectAgreement(build(["/a/*", "/a/:x/*"]), "/a/1/");
  });

  it("'/a/b/' serves the deeper /a/b/*, not the shallow /a/*", () => {
    expectAgreement(build(["/a/*", "/a/b/*"]), "/a/b/");
  });

  it("exact steal: '/a/b/' serves /a/b/* (empty capture), not /a/:x", () => {
    expectAgreement(build(["/a/b/*", "/a/:x"]), "/a/b/");
  });

  it("three-deep table: '/a/b/c/' serves /a/b/c/*", () => {
    expectAgreement(build(["/a/*", "/a/:x/*", "/a/b/c/*"]), "/a/b/c/");
  });

  it("'/w//' matches with NO wildcard param on both layers (locked trie rule)", () => {
    const state = build(["/w/*"]);
    const fast = matchRoute(state, "/w//");
    const slow = matchPattern(state.trieRoot, "/w//");
    expect(fast).not.toBeNull();
    expect(slow).not.toBeNull();
    expect(fast?.target).toBe(slow?.target);
    expect(paramsOf(fast)).toEqual({});
  });

  it("'/a/1//' on /a/:x/* yields {x:'1'} — the empty-rest wildcard link is dropped", () => {
    const state = build(["/a/:x/*"]);
    const fast = matchRoute(state, "/a/1//");
    const slow = matchPattern(state.trieRoot, "/a/1//");
    expect(fast?.target).toBe(slow?.target);
    expect(paramsOf(fast)).toEqual({ x: "1" });
  });

  it("a single trailing '/' keeps both layers identical (empty capture preserved)", () => {
    expectAgreement(build(["/w/*"]), "/w/");
    expectAgreement(build(["/w/*"]), "/w/a");
    expectAgreement(build(["/a/:x/*"]), "/w/a/");
    expectAgreement(build(["/w/:x/*"]), "/w/a/");
    expectAgreement(build(["/a/*", "/a/:x"]), "/a/");
  });

  it("a trailing wildcard capture never includes the single final '/' (trie joins stripped segments)", () => {
    expectAgreement(build(["/a/*"]), "/a/1/");
    expectAgreement(build(["/a/*"]), "/a/b/c/");
  });

  it("end-to-end: GET /a/1/ runs the deep handler", async () => {
    const app = new Keala(quiet);
    app.get("/a/:x/*", (c) => c.text(`deep x=${c.params("x")} w=${c.params("wildcard") ?? "-"}`));
    app.get("/a/*", (c) => c.text(`shallow w=${c.params("wildcard")}`));
    const res = await app.handle(new Request("http://x/a/1/"));
    expect([res.status, await res.text()]).toEqual([200, "deep x=1 w="]);
  });
});
