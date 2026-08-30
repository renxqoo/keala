/**
 * Red-team green assets: the randomized matchRoute-vs-trie equivalence fuzz.
 * matchRoute's static Map and bucket fast matchers are accelerators over the
 * trie — every path they answer must agree with the pure trie (source of
 * truth) on target AND captured params. These stay green; any divergence is a
 * P0 regression.
 */

import { describe, expect, it } from "vitest";

import { createApp } from "../src/core/app.ts";

const quiet = { env: "test" } as const;
const readBody = (res: Response): Promise<string> => res.text();

const normParams = (p: Record<string, string> | null): string => {
  if (p === null) return "null";
  return JSON.stringify(
    Object.keys(p)
      .toSorted()
      .map((k) => [k, p[k] as string]),
  );
};
import { compilePattern } from "../src/router/pattern.ts";
import { createNode, createTarget, insertPattern, matchPattern } from "../src/router/trie.ts";

describe("redteam v2 — GA-1 matchRoute equals the pure trie (trailing-param shapes)", () => {
  let seed = 1;
  const rand = (): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;

  const STATICS = ["a", "ab", "users", "admin", "v1", "x-y", "foo%20bar", "items"] as const;
  const NAMES = ["id", "name", "x"] as const;
  const REQ_WORDS = [
    "a",
    "ab",
    "users",
    "admin",
    "v1",
    "x-y",
    "foo%20bar",
    "foo bar",
    "items",
    "%61dmin",
    "1",
    "42",
    "zz",
    "..",
    "a%2Fb",
  ] as const;

  /** Leading statics, then dynamics only (plain / regex / optional / wildcard-at-end). */
  const genPattern = (): string => {
    const segs: string[] = [];
    const statics = Math.floor(rand() * 3);
    for (let i = 0; i < statics; i++) segs.push(pick(STATICS));
    const dynamics = Math.floor(rand() * 3);
    for (let i = 0; i < dynamics; i++) {
      const kind = pick(["param", "param", "paramRe", "paramOpt"] as const);
      if (kind === "param") segs.push(`:${pick(NAMES)}`);
      else if (kind === "paramRe") segs.push(`:${pick(NAMES)}(\\d+)`);
      else segs.push(`:${pick(NAMES)}?`);
    }
    // Only a wildcard may follow the dynamics: a static here would create the
    // "static tail after param" shape that is broken today (locked as RT-1).
    if (segs.length === 0 || rand() < 0.2) segs.push("*");
    return `/${segs.join("/")}`;
  };

  const genPath = (): string => {
    const segs: string[] = [];
    const n = 1 + Math.floor(rand() * 4);
    for (let i = 0; i < n; i++) segs.push(pick(REQ_WORDS));
    const p = `/${segs.join("/")}`;
    return rand() < 0.15 ? `${p}/` : p;
  };

  const runTrial = async (trial: number): Promise<string[]> => {
    seed = (0x9e3779b9 ^ (trial * 2654435761)) >>> 0;
    const patterns: string[] = [];
    const seen = new Set<string>();
    const count = 1 + Math.floor(rand() * 6);
    for (let i = 0; i < count; i++) {
      for (let attempt = 0; attempt < 25; attempt++) {
        const p = genPattern();
        if (seen.has(p)) continue;
        const names = p.split("/").filter((s) => s.startsWith(":"));
        if (new Set(names).size !== names.length) continue; // duplicate names: degenerate
        try {
          compilePattern(p);
        } catch {
          continue;
        }
        seen.add(p);
        patterns.push(p);
        break;
      }
    }
    if (patterns.length === 0) return [];

    const root = createNode();
    const hosts = new Map<object, Set<string>>();
    try {
      for (const p of patterns) {
        const node = insertPattern(root, compilePattern(p).segments);
        if (node.target === null) node.target = createTarget();
        const set = hosts.get(node.target) ?? new Set<string>();
        set.add(p);
        hosts.set(node.target, set);
      }
    } catch {
      return []; // conflicting names at one position — registration throws by design
    }

    const app = createApp(quiet);
    try {
      for (const p of patterns) app.get(p, (c) => c.text(`${p}|${normParams(c.params)}`));
    } catch {
      return [];
    }

    const problems: string[] = [];
    const dump = (): string => `trial ${trial} patterns: ${patterns.join(" ")}`;
    for (let i = 0; i < 120; i++) {
      const path = genPath();
      // The runtime normalizes dot-segments before the framework sees the URL;
      // feed the same normalized path to the reference trie.
      const absolute = new Request(`http://localhost${encodeURI(path)}`).url;
      const normPath = absolute.slice(absolute.indexOf("/", absolute.indexOf("://") + 3));
      const ref = matchPattern(root, normPath);
      const res = await app.handle(new Request(absolute));
      const body = res.status === 200 ? await readBody(res) : null;
      if (body === null && res.status !== 404) {
        problems.push(`${normPath}: status=${res.status} body=${await readBody(res)} | ${dump()}`);
        continue;
      }

      if (ref === null) {
        if (body !== null) problems.push(`${normPath}: trie=no-match real=${body}`);
        continue;
      }
      if (body === null) {
        problems.push(
          `${normPath}: real=no-match trie=${[...(hosts.get(ref.target) ?? [])].join("+")} | ${dump()}`,
        );
        continue;
      }
      const [realPattern, realParams] = body.split("|") as [string, string];
      if (!(hosts.get(ref.target) ?? new Set<string>()).has(realPattern)) {
        problems.push(`${normPath}: target divergence real=${realPattern}`);
        continue;
      }
      if (realParams !== normParams(ref.params)) {
        problems.push(`${normPath}: params real=${realParams} trie=${normParams(ref.params)}`);
      }
    }
    return problems;
  };

  it("holds over 100 randomized pattern tables x 120 paths each", async () => {
    const problems: string[] = [];
    for (let t = 0; t < 100; t++) problems.push(...(await runTrial(t)));
    expect(problems).toEqual([]);
  }, 30_000);
});
