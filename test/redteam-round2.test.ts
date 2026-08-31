/**
 * Red-team round-2 green assets (see test/redteam.test.ts for the ledger).
 *
 * GA-1b: full-shape INTERNAL equivalence fuzz — matchRoute (staticMap + bucket
 * fast matcher + trie) vs the pure trie on the exact same pattern table,
 * asserting identical targets (via target->pattern identity derived from the
 * router's own index structures) AND identical captured params. Unlike the
 * e2e fuzz in redteam-assets.test.ts this covers static tails, optionals
 * mid-pattern, regex params and multi-wildcard tables with no URL-normalizer
 * in between. Scope: escape-free ASCII tokens — the percent-encoded-static
 * domain diverges today (locked as RT-9 in test/redteam.test.ts).
 *
 * GA-2: 500-way concurrency isolation. GA-3: 100k-request retained-heap fence
 * (Bun.gc sampling). GA-4: security quick-scan (CRLF, cookie signatures,
 * prototype pollution, Allow/Location injection, traversal capture).
 */

import { describe, expect, it } from "vitest";

import { createApp } from "../src/index.ts";
import { sign } from "../src/context/cookies.ts";
import { compilePattern } from "../src/router/pattern.ts";
import { createRouterState, matchRoute, registerDef } from "../src/router/router.ts";
import { createNode, createTarget, insertPattern, matchPattern } from "../src/router/trie.ts";
import type { RouteTarget, TrieNode } from "../src/router/trie.ts";

/** handle() may settle synchronously — normalize to a Promise for .then chains. */
const handleFlat = (
  app: { handle(r: Request): Response | Promise<Response> },
  r: Request,
): Promise<Response> => Promise.resolve(app.handle(r));

const quiet = { env: "test", silent: true } as const;
const req = (url: string, init: RequestInit = {}): Request => new Request(url, init);
const text = async (res: Response): Promise<string> => res.text();

/** target -> pattern-set via the structures the router itself indexes into. */
const patternsOf = (
  root: TrieNode,
  patterns: readonly string[],
  stateStatics?: Map<string, RouteTarget>,
): Map<RouteTarget, string[]> => {
  const map = new Map<RouteTarget, string[]>();
  for (const p of patterns) {
    const ir = compilePattern(p);
    let target: RouteTarget | null;
    if (stateStatics !== undefined) {
      target = ir.isStatic
        ? (stateStatics.get(p) ?? null)
        : (insertPattern(root, ir.segments)[0] as { target: RouteTarget | null }).target;
    } else {
      const terminals = insertPattern(root, ir.segments);
      const shared = (terminals[0] as { target: RouteTarget | null }).target ?? createTarget();
      for (const terminal of terminals) {
        if (terminal.target === null) terminal.target = shared;
      }
      target = shared;
    }
    if (target === null) throw new Error(`no target for ${p}`);
    const list = map.get(target) ?? [];
    list.push(p);
    map.set(target, list);
  }
  return map;
};

describe("redteam round2 — GA-1b matchRoute equals the pure trie (internal, full shapes)", () => {
  let seed = 1;
  const rand = (): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;

  const STATICS = ["a", "ab", "users", "admin", "v1", "x-y", "items", "longseg"] as const;
  const NAMES = ["id", "name", "x"] as const;
  const WORDS = [
    "a",
    "ab",
    "users",
    "admin",
    "v1",
    "x-y",
    "items",
    "longseg",
    "1",
    "42",
    "zz",
    "..",
    ".",
    "-",
  ] as const;

  const genPattern = (): string => {
    const segs: string[] = [];
    const n = 1 + Math.floor(rand() * 4);
    for (let i = 0; i < n; i++) {
      const kind = pick([
        "static",
        "static",
        "static",
        "param",
        "param",
        "paramRe",
        "paramOpt",
        "wildcard",
      ] as const);
      if (kind === "wildcard") {
        segs.push("*");
        break;
      }
      if (kind === "static") segs.push(pick(STATICS));
      else if (kind === "param") segs.push(`:${pick(NAMES)}`);
      else if (kind === "paramRe") segs.push(`:${pick(NAMES)}(\\d+)`);
      else segs.push(`:${pick(NAMES)}?`);
    }
    if (segs.length === 0) segs.push("a");
    return `/${segs.join("/")}`;
  };

  const genPath = (): string => {
    const segs: string[] = [];
    const n = 1 + Math.floor(rand() * 5);
    for (let i = 0; i < n; i++) segs.push(pick(WORDS));
    return rand() < 0.15 ? `/${segs.join("/")}/` : `/${segs.join("/")}`;
  };

  const norm = (p: Record<string, string> | null): string =>
    p === null
      ? "[]"
      : JSON.stringify(
          Object.keys(p)
            .toSorted()
            .map((k) => [k, p[k] as string]),
        );

  it("holds over 300 randomized pattern tables x 200 paths each", { timeout: 30_000 }, () => {
    const problems: string[] = [];
    for (let t = 0; t < 300; t++) {
      seed = (0x9e3779b9 ^ (t * 2654435761)) >>> 0;
      const patterns: string[] = [];
      const seen = new Set<string>();
      const count = 1 + Math.floor(rand() * 8);
      for (let i = 0; i < count; i++) {
        for (let attempt = 0; attempt < 30; attempt++) {
          const p = genPattern();
          if (seen.has(p)) continue;
          const base = p
            .split("/")
            .filter((s) => s.startsWith(":"))
            .map((s) => s.replace(/\(.*$/, "").replace(/\?$/, ""));
          if (new Set(base).size !== base.length) continue; // duplicate names: degenerate
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
      if (patterns.length === 0) continue;

      const state = createRouterState();
      const root = createNode();
      try {
        for (const p of patterns) {
          registerDef(state, "GET", p, [() => {}]);
          // Mirror indexPattern's CURRENT model: one target per TERMINAL NODE
          // (patterns sharing a terminal append to it; an optional's skip
          // terminal keeps its own target — R6-9). The equivalence invariant
          // under test (matchRoute ≡ pure trie) is unchanged.
          const terminals = insertPattern(root, compilePattern(p).segments);
          for (const terminal of terminals) {
            terminal.target ??= createTarget();
          }
        }
      } catch {
        continue; // conflicting param names at one position throw by design
      }
      const statePats = patternsOf(state.trieRoot, patterns, state.staticMap);
      const refPats = patternsOf(root, patterns);

      for (let i = 0; i < 200; i++) {
        const path = genPath();
        const real = matchRoute(state, path);
        const ref = matchPattern(root, path);
        if (ref === null) {
          if (real !== null)
            problems.push(
              `${path}: real hit ${(statePats.get(real.target) ?? []).join("+")} trie miss`,
            );
        } else if (real === null) {
          problems.push(`${path}: trie hit ${(refPats.get(ref.target) ?? []).join("+")} real miss`);
        } else {
          const rs = (statePats.get(real.target) ?? []).toSorted().join("+");
          const ts = (refPats.get(ref.target) ?? []).toSorted().join("+");
          if (rs !== ts) problems.push(`${path}: target real=${rs} trie=${ts}`);
          else if (norm(real.params) !== norm(ref.params))
            problems.push(`${path}: params real=${norm(real.params)} trie=${norm(ref.params)}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

describe("redteam round2 — GA-2 concurrency isolation", () => {
  it("500 mixed concurrent requests answer without crosstalk", { timeout: 60_000 }, async () => {
    const app = createApp({ ...quiet, keys: ["k"] });
    app.use(async (c, next) => {
      c.state.step = "1";
      await next();
      c.set("x-done", "1");
    });
    app.get("/text", (c) => c.text("hello"));
    app.get("/users/:id", (c) => c.json({ id: c.params?.["id"], st: c.state.step }));
    app.get("/err", () => {
      throw new Error("boom");
    });
    app.post("/users/:id/posts", (c) => c.text(`p:${c.params?.["id"]}`));
    app.get("/wild/*", (c) => c.text(`w:${c.params?.["wildcard"]}`));
    app.get("/cookies", (c) => {
      c.cookies.set("s", "1", { signed: true });
      return c.text("ck");
    });

    const out = await Promise.all(
      Array.from({ length: 500 }, (_, i) => {
        const id = `u${i}`;
        switch (i % 7) {
          case 0:
            return handleFlat(app, req("http://localhost/text")).then(
              async (r) => [r.status, await r.text()] as const,
            );
          case 1:
            return handleFlat(app, req(`http://localhost/users/${id}`)).then(
              async (r) => [r.status, await r.text()] as const,
            );
          case 2:
            return handleFlat(app, req("http://localhost/err")).then(
              async (r) => [r.status, await r.text()] as const,
            );
          case 3:
            return handleFlat(
              app,
              req(`http://localhost/users/${id}/posts`, { method: "POST" }),
            ).then(async (r) => [r.status, await r.text()] as const);
          case 4:
            return handleFlat(app, req("http://localhost/wild/a/b/c")).then(
              async (r) => [r.status, await r.text()] as const,
            );
          case 5:
            return handleFlat(app, req(`http://localhost/users/${id}`, { method: "HEAD" })).then(
              async (r) => [r.status, await r.text()] as const,
            );
          default:
            return handleFlat(app, req(`http://localhost/missing-${i}`)).then(
              async (r) => [r.status, await r.text()] as const,
            );
        }
      }),
    );
    for (let i = 0; i < 500; i++) {
      const [status, body] = out[i] as readonly [number, string];
      switch (i % 7) {
        case 0:
          expect([status, body]).toEqual([200, "hello"]);
          break;
        case 1:
          expect([status, body]).toEqual([200, `{"id":"u${i}","st":"1"}`]);
          break;
        case 2:
          expect([status, body]).toEqual([500, "Internal Server Error"]); // documented header reset
          break;
        case 3:
          expect([status, body]).toEqual([200, `p:u${i}`]);
          break;
        case 4:
          expect([status, body]).toEqual([200, "w:a/b/c"]);
          break;
        case 5:
          expect([status, body]).toEqual([200, ""]);
          break;
        default:
          expect(status).toBe(404);
      }
    }
  });
});

describe("redteam round2 — GA-3 leak fence", () => {
  it.skipIf(typeof Bun === "undefined" || typeof Bun.gc !== "function")(
    "100k mixed requests retain under 32B/request",
    { timeout: 120_000 },
    async () => {
      const app = createApp({ ...quiet, keys: ["k"] });
      app.get("/text", (c) => c.text("hello"));
      app.get("/users/:id", (c) => c.json({ id: c.params?.["id"] }));
      app.get("/err", () => {
        throw new Error("boom");
      });
      app.get("/wild/*", (c) => c.text(`w:${c.params?.["wildcard"]}`));
      app.get("/cookies", (c) => {
        c.cookies.set("s", "1", { signed: true });
        return c.text("ck");
      });
      const requests = ["/text", "/users/7", "/err", "/wild/a/b", "/cookies", "/missing"].map(
        (p) => new Request(`http://localhost${p}`),
      );
      const run = async (n: number): Promise<void> => {
        for (let i = 0; i < n; i++) await handleFlat(app, requests[i % requests.length] as Request);
      };
      await run(20_000); // warm caches/pools
      Bun.gc(true);
      const before = process.memoryUsage().heapUsed;
      await run(100_000);
      Bun.gc(true);
      const delta = process.memoryUsage().heapUsed - before;
      expect(delta / 100_000).toBeLessThan(32);
    },
  );
});

describe("redteam round2 — GA-4 security quick-scan", () => {
  it("CRLF in header values is rejected and answers 500 without injecting", async () => {
    const app = createApp(quiet);
    app.get("/x", (c) => {
      c.set("x-inj", "a\r\nSet-Cookie: pwned=1");
      return c.text("ok");
    });
    const res = await handleFlat(app, req("http://localhost/x"));
    expect(res.status).toBe(500);
    expect(res.headers.get("x-inj")).toBeNull();
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("cookie signatures: valid accepted, forged value and forged digest rejected", async () => {
    const app = createApp({ ...quiet, keys: ["k1"] });
    app.get("/read", (c) => c.text(`v=${c.cookies.get("sess", { signed: true }) ?? "REJECT"}`));
    const good = sign("v1", "k1");
    const read = async (cookie: string): Promise<string> =>
      text(await handleFlat(app, new Request("http://localhost/read", { headers: { cookie } })));
    expect(await read(`sess=${good}`)).toBe("v=v1");
    expect(await read(`sess=admin.${good.slice(3)}`)).toBe("v=REJECT");
    expect(await read(`sess=${good.slice(0, -2)}xx`)).toBe("v=REJECT");
    expect(await read("sess=v1")).toBe("v=REJECT");
  });

  it("signed read without keys fails closed; query cannot pollute prototypes", async () => {
    const app = createApp(quiet);
    app.get("/read", (c) => {
      let out = "raw";
      try {
        out = String(c.cookies.get("sess", { signed: true }));
      } catch {
        out = "THROWS";
      }
      return c.text(out);
    });
    app.get("/q", (c) =>
      c.json({ polluted: ({} as Record<string, unknown>).polluted === undefined, a: c.query["a"] }),
    );
    const res1 = await handleFlat(
      app,
      new Request("http://localhost/read", { headers: { cookie: "sess=admin.FORGED" } }),
    );
    expect(await text(res1)).toBe("THROWS");
    const res2 = await handleFlat(
      app,
      req(
        "http://localhost/q?__proto__[polluted]=1&__proto__=2&constructor[polluted]=3&prototype=4&a=1",
      ),
    );
    expect(await text(res2)).toBe('{"polluted":true,"a":"1"}');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("unknown methods throw at registration; Allow never carries injected text", async () => {
    const app = createApp(quiet);
    expect(() => app.on("GET\r\nX: 1", "/x", () => {})).toThrow();
    app.post("/x", (c) => c.text("p"));
    const res = await handleFlat(app, req("http://localhost/x", { method: "PUT" }));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("Location header cannot carry CRLF (redirect target is URL-normalized + encoded)", async () => {
    const app = createApp(quiet);
    app.get("/r", (c) => c.redirect("http://evil.test/a\r\nSet-Cookie: pwned=1"));
    const res = await handleFlat(app, req("http://localhost/r"));
    expect(res.headers.get("location") ?? "").not.toMatch(/[\r\n]/);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("encoded traversal in a captured param stays a decoded string (no path semantics)", async () => {
    const app = createApp(quiet);
    app.get("/files/:name", (c) => c.text(`f=${c.params?.["name"]}`));
    const res = await handleFlat(app, req("http://localhost/files/..%2F..%2Fetc"));
    expect([res.status, await text(res)]).toEqual([200, "f=../../etc"]);
  });
});
