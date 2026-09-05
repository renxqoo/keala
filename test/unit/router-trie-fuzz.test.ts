import { describe, expect, it } from "vitest";

import { compilePattern } from "../../src/router/pattern.ts";
import {
  createNode,
  createTarget,
  insertPattern,
  matchPattern,
  type RouteTarget,
} from "../../src/router/trie.ts";
import { Keala, Router, createError } from "../../src/index.ts";
import { acceptsEncoding } from "../../src/negotiation/accepts.ts";
import { typeIs } from "../../src/negotiation/typeis.ts";
import { paramsRecord } from "../../src/router/router.ts";
import {
  charsetFromContentType,
  extensionFromMime,
  mimeFromExtension,
  normalizeType,
} from "../../src/utils/mime.ts";
/**
 * Red-team green assets: the randomized matchRoute-vs-trie equivalence fuzz.
 * matchRoute's static Map and bucket fast matchers are accelerators over the
 * trie — every path they answer must agree with the pure trie (source of
 * truth) on target AND captured params. These stay green; any divergence is a
 * P0 regression.
 */

const quiet = { env: "test" } as const;
const req = (url: string, init?: RequestInit): Request => new Request(url, init);
const text = async (res: Response): Promise<string> => res.text();
const readBody = (res: Response): Promise<string> => res.text();

const normParams = (p: Record<string, string> | null): string => {
  if (p === null) return "null";
  return JSON.stringify(
    Object.keys(p)
      .toSorted()
      .map((k) => [k, p[k] as string]),
  );
};

describe("redteam — GA-1 matchRoute equals the pure trie (trailing-param shapes)", () => {
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
        // insertPattern returns every terminal (optionals yield several);
        // they all share one target.
        const terminals = insertPattern(root, compilePattern(p).segments);
        const shared = (terminals[0] as { target: RouteTarget | null }).target ?? createTarget();
        for (const terminal of terminals) {
          if (terminal.target === null) terminal.target = shared;
        }
        const set = hosts.get(shared) ?? new Set<string>();
        set.add(p);
        hosts.set(shared, set);
      }
    } catch {
      return []; // conflicting names at one position — registration throws by design
    }

    const app = new Keala(quiet);
    try {
      for (const p of patterns)
        app.get(p, (c) =>
          c.text(`${p}|${normParams(paramsRecord(c.paramNames, c.paramValues, c.paramOffset))}`),
        );
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
      if (realParams !== normParams(paramsRecord(ref.names, ref.values, ref.offset))) {
        problems.push(
          `${normPath}: params real=${realParams} trie=${normParams(paramsRecord(ref.names, ref.values, ref.offset))}`,
        );
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

describe("redteam — RT-9 encoded static segments bypass staticMap", () => {
  it("CONFIRMED-BUG(now fixed) (RT-9a): GET /%61dmin must hit the static /admin route", async () => {
    const app = new Keala(quiet);
    app.get("/admin", (c) => c.text("static-admin"));
    const res = await app.handle(req("http://localhost/%61dmin"));
    expect([res.status, await text(res)]).toEqual([200, "static-admin"]);
  });

  it("CONFIRMED-BUG(now fixed) (RT-9b): static must beat the wildcard for /%61dmin", async () => {
    const app = new Keala(quiet);
    app.get("/admin", (c) => c.text("static-admin"));
    app.get("/*", (c) => c.text(`wild:${c.params("wildcard")}`));
    expect(await text(await app.handle(req("http://localhost/%61dmin")))).toBe("static-admin");
  });

  it("CONFIRMED-BUG(now fixed) (RT-9c): an encoded non-first static segment must match", async () => {
    const app = new Keala(quiet);
    app.get("/admin/items", (c) => c.text("items"));
    expect((await app.handle(req("http://localhost/admin/%69tems"))).status).toBe(200);
  });

  it("CONFIRMED-BUG(now fixed) (RT-9d): all-static tables match escaped paths (public surface)", async () => {
    // The pure-trie cross-check lives in the GA-1 fuzz asset; here the same
    // guarantee is asserted through the app: a table with ONLY static routes
    // (no trie fallback exists) must still decode-match escaped requests.
    const app = new Keala(quiet);
    app.get("/admin", (c) => c.text("static-admin"));
    app.get("/admin/panel", (c) => c.text("panel"));
    expect((await app.handle(req("http://localhost/%61dmin"))).status).toBe(200);
    expect((await app.handle(req("http://localhost/%61dmin/p%61nel"))).status).toBe(200);
    expect((await app.handle(req("http://localhost/%61dmin/other"))).status).toBe(404);
  });

  it("green witness: a dynamic route answers its encoded static prefix", async () => {
    const app = new Keala(quiet);
    app.get("/admin/:id", (c) => c.text(`dyn:${c.params("id")}`));
    expect(await text(await app.handle(req("http://localhost/%61dmin/1")))).toBe("dyn:1");
  });
});

// globalThis.Bun is non-writable AND non-configurable on the real Bun
// runtime — these suites stub it, so they run on the Node gate only (the
// real-runtime equivalents live in scripts/smoke.ts).
const REAL_BUN = typeof Bun !== "undefined";

describe("branch coverage: round 3", () => {
  it("identity is refused when explicitly disabled", () => {
    expect(acceptsEncoding("identity;q=0", ["identity", "gzip"])).toBe(false);
    expect(acceptsEncoding("*;q=0.0", ["identity", "gzip"])).toBe(false);
    expect(acceptsEncoding("gzip;q=0.00, identity", ["identity", "gzip"])).toBe("identity");
  });

  it("set() accepts multi-value headers", async () => {
    const app = new Keala();
    app.use(async (c) => {
      c.setHeader("X-Multi", ["a", "b"]);
      return c.text("ok");
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.headers.get("x-multi")).toBe("a, b");
  });

  it("mime helpers handle edges", () => {
    expect(normalizeType("; junk")).toBe("");
    expect(mimeFromExtension("archive.tar.gz")).toBe("application/gzip");
    expect(extensionFromMime("image/png")).toBe("png");
    expect(charsetFromContentType("")).toBe("");
  });

  it("prefers x-forwarded-host when proxying", async () => {
    const app = new Keala({ proxy: true });
    let host = "";
    app.use(async (c) => {
      host = c.host;
      return c.text("ok");
    });
    await app.handle(
      new Request("http://localhost:3000/", {
        headers: { "X-Forwarded-Host": "proxy.example.com" },
      }),
    );
    expect(host).toBe("proxy.example.com");
  });

  it.skipIf(REAL_BUN)("forwards listen options through app.listen", () => {
    const originalBun = (globalThis as { Bun?: unknown }).Bun;
    let captured: Record<string, unknown> = {};
    (globalThis as { Bun?: unknown }).Bun = {
      serve: (options: Record<string, unknown>) => {
        captured = options;
        return {
          port: options["port"],
          hostname: "localhost",
          stop() {},
          fetch: async () => new Response(),
          reload() {},
        };
      },
    };
    try {
      new Keala().listen({
        port: 3999,
        reusePort: true,
        idleTimeout: 5,
        maxRequestBodySize: 777,
        development: true,
      });
      expect(captured["port"]).toBe(3999);
      expect(captured["reusePort"]).toBe(true);
      expect(captured["idleTimeout"]).toBe(5);
      expect(captured["maxRequestBodySize"]).toBe(777);
      expect(captured["development"]).toBe(true);
    } finally {
      if (originalBun === undefined) delete (globalThis as { Bun?: unknown }).Bun;
      else (globalThis as { Bun?: unknown }).Bun = originalBun;
    }
  });

  it("typeIs tolerates garbage content types and matches xml suffixes", () => {
    expect(typeIs(";weird", [])).toBe(null);
    expect(typeIs("application/rss+xml", ["xml"])).toBe("xml");
  });

  it("keeps undecodable static segments as-is", () => {
    expect(compilePattern("/files/%E0%A4%A").segments[1]?.value).toBe("%E0%A4%A");
  });

  it("rejects conflicting param names; distinct patterns become variants", () => {
    const root = createNode();
    insertPattern(root, compilePattern("/users/:id").segments);
    expect(() => insertPattern(root, compilePattern("/users/:name").segments)).toThrow(TypeError);
    insertPattern(root, compilePattern("/users/:id(\\d+)").segments);
    // The plain head keeps its identity; the custom pattern is a variant.
    expect(root.children.get("users")?.param?.pattern).toBeNull();
    expect(root.children.get("users")?.paramMore?.[0]?.pattern?.test("7")).toBe(true);
  });

  it("url() throws when a required param is missing", () => {
    const router = new Router();
    router.get("user", "/users/:id", (c) => void c);
    expect(() => router.url("user", {})).toThrow(/Missing required parameter/);
  });

  it("createError copies headers from a wrapped error", () => {
    const inner = createError(403, "denied", { headers: { "x-inner": "1" } });
    const outer = createError(500, inner);
    expect(outer.status).toBe(403);
    expect(outer.headers).toEqual({ "x-inner": "1" });
    expect(outer.cause).toBe(inner);
  });
});
