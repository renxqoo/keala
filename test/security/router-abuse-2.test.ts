/**
 * RED-TEAM ALGORITHM-CORRECTNESS TESTS — BUG LEDGER, re-verified.
 *
 * Originally authored 2026-08-30 against koa 3.2.1 / @koa/router 15.7 (every
 * `it()` encodes the CORRECT behavior and failed against the prototype core).
 * Re-verified against the core (src/core/*, src/router/*) during the
 * security-test migration. Current status:
 *
 * FIXED (now green regression locks):
 *  [T1] optional flag merges when /:id and /:id? share a position —
 *       src/router/trie.ts insertPattern() now ORs `optional` in.
 *  [T2] an earlier `:id(\d+)` route no longer constrains later `:id` routes —
 *       trie positions carry multiple param variants (same name, different
 *       custom patterns), each with its own subtree (2026-08-31).
 *  [T3] trailing "?" after a custom pattern — src/router/pattern.ts
 *       compilePattern() strips the "?" before extracting the pattern.
 *  [T4] consecutive optional params assign left-to-right — matchPattern()
 *       pushes the skip frame deepest (LIFO consumes first).
 *  [R1] param() registered after the route applies — mount() copies param
 *       middleware into the app router BEFORE registering defs.
 *  [R2] duplicate path+method registrations chain — router.ts bindDef()
 *       composes previous + new chain.
 *  [R4] 405/Allow and OPTIONS/Allow work across mounted routers — routing
 *       is centralized in app.handle + the finalizer.
 *  [Q1] querystring/search setters keep the fragment intact.
 *  [P1][P2][P3] explicit-status flags survive later body assignments.
 *  [P4] a manually set Content-Length is repaired for string bodies.
 *  [P5] HEAD preserves an explicit user Content-Length.
 *  [P6] an unexpandable ctx.type never emits an invalid Content-Type (D1
 *       drops the header; the runtime supplies the default — see D1).
 *
 * structural divergences (old shape removed, semantic preserved):
 *  [R3] the core has no runtime prefix()/path-scoped use(). The lock below keeps
 *       the security intent: a router-scope guard still runs when the group
 *       is prefixed and mounted.
 *
 * NEW core bugs found during this migration (locked as CONFIRMED-BUG):
 *  - app.mount("/", router) throws "Route path has an empty segment".
 *  - router.use() after route registration is silently ignored.
 *  - null-body finalization emits the literal text "null" (locked in
 *    test/security.test.ts; breaks every 204/explicit-null response).
 */

import { describe, expect, it } from "vitest";

import { Keala, type Application } from "../../src/core/app.ts";
import type { Context } from "../../src/core/context/context.ts";
import { Router } from "../../src/router/group.ts";
import { compilePattern } from "../../src/router/pattern.ts";
import {
  createNode,
  createTarget,
  insertPattern,
  matchPattern,
  type TrieMatch,
} from "../../src/router/trie.ts";
import { paramsRecord } from "../../src/router/router.ts";

const paramsOf = (m: TrieMatch | null): Record<string, string> | null =>
  m === null ? null : paramsRecord(m.names, m.values, m.offset);

const buildTrie = (patterns: readonly string[]) => {
  const root = createNode();
  for (const pattern of patterns) {
    // insertPattern returns every terminal (optionals yield several); they
    // all share one target.
    const target = createTarget();
    for (const terminal of insertPattern(root, compilePattern(pattern).segments)) {
      if (terminal.target === null) terminal.target = target;
    }
  }
  return root;
};

const handle = async (
  setup: (app: Application) => void,
  url: string,
  init?: RequestInit,
): Promise<Response> => {
  const app = new Keala({ env: "test" });
  setup(app);
  return app.handle(new Request(`http://localhost:3000${url}`, init));
};

/** Shared per-request scratch array so handlers can record execution order. */
const ORDER_KEY = "redteam:order";
const ctxState = (c: Context): string[] => {
  const state = c.state as Record<string, unknown>;
  const existing = state[ORDER_KEY];
  if (Array.isArray(existing)) return existing as string[];
  const created: string[] = [];
  state[ORDER_KEY] = created;
  return created;
};

describe("red team: trie matching", () => {
  it("[T1] merges the optional flag when /:id and /:id? share a position (order-independent)", () => {
    const optionalFirst = buildTrie(["/users/:id?", "/users/:id"]);
    const optionalLast = buildTrie(["/users/:id", "/users/:id?"]);
    expect(matchPattern(optionalFirst, "/users")).not.toBeNull();
    expect(matchPattern(optionalLast, "/users")).not.toBeNull();
    expect(paramsOf(matchPattern(optionalLast, "/users/5"))).toEqual({ id: "5" });
  });

  // Fixed (2026-08-31): a trie position now carries multiple param VARIANTS
  // (same name, different custom patterns). insertPattern() used to keep the
  // first `param.pattern` and drop later ones, making the plain `:id` route
  // unreachable; each variant keeps its own subtree now.
  it("[T2] does not let an earlier :id(\\d+) route constrain a later plain :id route", () => {
    const root = buildTrie(["/users/:id(\\d+)/a", "/users/:id/b"]);
    expect(matchPattern(root, "/users/xyz/b")).not.toBeNull();
    expect(matchPattern(root, "/users/123/a")).not.toBeNull();

    const clashing = buildTrie(["/v/:x(\\d+)/num", "/v/:x([a-z]+)/word"]);
    expect(matchPattern(clashing, "/v/abc/word")).not.toBeNull();
    expect(matchPattern(clashing, "/v/7/num")).not.toBeNull();
  });

  it("[T2b] param variants backtrack into each other's subtrees", () => {
    const root = buildTrie(["/users/:id(\\d+)/a", "/users/:id/b"]);
    // "5" satisfies BOTH variants — the numeric subtree has no /b child, so
    // matching must backtrack into the plain variant's subtree.
    expect(matchPattern(root, "/users/5/b")).not.toBeNull();
    // "xyz" only satisfies the plain variant; its subtree has no /a child.
    expect(matchPattern(root, "/users/xyz/a")).toBeNull();
  });

  it("[T2c] an identical pattern variant shares one node (no duplicate variants)", () => {
    const root = buildTrie(["/users/:id(\\d+)", "/users/:id(\\d+)"]);
    expect(matchPattern(root, "/users/7")).not.toBeNull();
    expect(matchPattern(root, "/users/x")).toBeNull();
    // The second registration must not have created a second variant that
    // could match "/users/x" through the plain-looking path.
    expect(root.children.get("users")?.param?.pattern).not.toBeNull();
  });

  it("[T2d] conflicting parameter NAMES at one position still throw", () => {
    expect(() => buildTrie(["/users/:id", "/users/:name"])).toThrow(TypeError);
  });

  it("[T3] treats a trailing ? after a custom pattern as optional", () => {
    const segments = compilePattern("/users/:id(\\d+)?").segments;
    expect(segments[1]?.optional).toBe(true);
    const root = buildTrie(["/users/:id(\\d+)?"]);
    expect(matchPattern(root, "/users")).not.toBeNull();
    expect(paramsOf(matchPattern(root, "/users/7"))).toEqual({ id: "7" });
  });

  it("[T4] assigns consecutive optional params left-to-right", () => {
    const root = buildTrie(["/a/:x?/:y?"]);
    expect(paramsOf(matchPattern(root, "/a/1"))).toEqual({ x: "1" });
    expect(paramsOf(matchPattern(root, "/a/1/2"))).toEqual({ x: "1", y: "2" });

    const withTail = buildTrie(["/a/:x?/:y?/z"]);
    expect(paramsOf(matchPattern(withTail, "/a/1/z"))).toEqual({ x: "1" });
  });
});

describe("red team: router", () => {
  it("[R1] applies param middleware registered after the route (order-independent)", async () => {
    const res = await handle((app) => {
      const router = new Router();
      router.get("/users/:id", (c) => {
        return c.text("route");
      });
      router.param("id", (c, next) => {
        c.setHeader("X-Param", "ran");
        return next();
      });
      app.mount("/r1", router);
    }, "/r1/users/7");
    expect(res.headers.get("x-param")).toBe("ran");
    expect(await res.text()).toBe("route");
  });

  it("[R2] chains handlers from duplicate path+method registrations", async () => {
    const res = await handle((app) => {
      app.get("/x", async (c, next) => {
        ctxState(c).push("first");
        await next();
      });
      app.get("/x", (c) => {
        return c.text(`${ctxState(c).join(",")},second`);
      });
    }, "/x");
    expect(await res.text()).toBe("first,second");
  });

  it("[R3] router-scope use() guards keep guarding a prefixed group (current shape)", async () => {
    // The core removed runtime prefix()/path-scoped use(); the security intent — a
    // router-level guard must never be silently skipped for its routes — is
    // preserved with a prefixed group mounted into the app.
    let guardRan = false;
    const res = await handle((app) => {
      const router = new Router({ prefix: "/api" });
      router.use(async (_c, next) => {
        guardRan = true;
        await next();
      });
      router.get("/admin/panel", (c) => {
        return c.text("panel");
      });
      app.mount("/v2", router);
    }, "/v2/api/admin/panel");
    expect(guardRan).toBe(true);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("panel");
  });

  it("[R4] allowedMethods sees mounted router matches (405/Allow, OPTIONS/Allow)", async () => {
    const del = await handle(
      (app) => {
        const child = new Router();
        child.get("/items/:sku", (c) => {
          return c.json({ sku: c.params("sku") });
        });
        app.mount("/shop", child);
      },
      "/shop/items/x",
      { method: "DELETE" },
    );
    expect(del.status).toBe(405);
    expect(del.headers.get("allow")).toBe("HEAD, GET");

    const options = await handle(
      (app) => {
        const child = new Router();
        child.get("/items/:sku", (c) => {
          return c.json({ sku: c.params("sku") });
        });
        app.mount("/shop", child);
      },
      "/shop/items/x",
      { method: "OPTIONS" },
    );
    expect(options.status).toBe(200);
    expect(options.headers.get("allow")).toBe("HEAD, GET");
  });
});

// 0.7: the "red team: request lazy cache" suite is gone — request
// url/querystring setters were deleted (requests are read-only).

// ---------------------------------------------------------------------------
// U3c deletion: the "red team: respond state machine" suite ([P1]/[P3]/
// [P4]/[P5]/[P6]) went with the response setters it exercised — double body
// assignment, null/undefined body adoption, the c.length read, staged-CL
// repair and c.type MIME inference no longer exist ([P2] was already gone
// with the 0.7 Response-as-body quirk). Surviving analogues: empty-status
// cleansing (test/security/baseline.test.ts CONFIRMED-BUG block, §2.3-2),
// staged-header overwrite (§2.3-1), sugar HEAD Content-Length
// (test/middleware/cache.test.ts), stream CL (upstream-hardening koa#1939).
// ---------------------------------------------------------------------------

describe("CONFIRMED-BUG: router core (found during this migration)", () => {
  it("CONFIRMED-BUG(now fixed): app.mount('/', router) must mount at root, not throw (TODO-BUG: core/app.ts mount base keeps '/' and produces '//path')", async () => {
    const app = new Keala({ env: "test" });
    const router = new Router();
    router.get("/users/:id", (c) => {
      return c.text("u");
    });
    expect(() => app.mount("/", router)).not.toThrow(); // actual: TypeError "Route path has an empty segment: //users/:id"
    const res = await app.handle(new Request("http://localhost:3000/users/7"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("u");
  });

  it("CONFIRMED-BUG(now fixed): router.use() registered after a route must still apply (TODO-BUG: router/group.ts add() snapshots middleware per def)", async () => {
    let guardRan = false;
    const app = new Keala({ env: "test" });
    const router = new Router();
    router.get("/admin/panel", (c) => {
      return c.text("panel");
    });
    router.use(async (_c, next) => {
      guardRan = true;
      await next();
    });
    app.mount("/api", router);
    const res = await app.handle(new Request("http://localhost:3000/api/admin/panel"));
    expect(guardRan).toBe(true); // actual: false — the guard is silently skipped
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("panel");
  });
});
