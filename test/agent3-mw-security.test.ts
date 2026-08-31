/**
 * Agent 3 — middleware-tier red-team suite (RED tests).
 *
 * Every `it` below asserts the CORRECT / hardened behavior and FAILS against
 * the current implementation; the failure IS the bug. Each block names the
 * defect, the root cause, and the expected-vs-actual contract.
 *
 *  MW-1 [validator] two validator() middlewares on one app: the second
 *        installation throws app.decorate()'s "already defined" TypeError at
 *        REQUEST time -> every route behind the second validator 500s.
 *  MW-2 [validator] Standard Schema validate() may return a Promise (spec);
 *        the middleware does not await it -> validation silently skipped and
 *        the unvalidated payload is handed to the handler.
 *  MW-3 [serveStatic] a present but non-matching If-None-Match answers
 *        200 with a NULL body — the representation itself is never served.
 *  MW-4 [serveStatic] options.prefix strips on a plain startsWith — "/assets"
 *        also strips on "/assetsnote.txt", so URLs OUTSIDE the mount serve
 *        the mounted root's files.
 *  MW-5 [responseCache] eligibility checks the request's Authorization header
 *        but not its Cookie header — a handler that personalizes on the raw
 *        Cookie header (never touching c.cookies) gets cached and REPLAYED
 *        cross-user.
 */

import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/core/app.ts";
import { validator, type StandardSchema } from "../src/middleware/validator.ts";
import { serveStatic } from "../src/middleware/serve-static.ts";
import { cache } from "../src/middleware/cache.ts";

const quiet = { env: "test", silent: true } as const;
const req = (path: string, init: RequestInit = {}): Request =>
  new Request(`http://localhost:3000${path}`, init);
const jsonBody = (path: string, body: unknown): Request =>
  req(path, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

const passthrough = (): StandardSchema => ({
  "~standard": { version: 1, validate: (value: unknown) => ({ value }) },
});
const rejectObjects = (): StandardSchema => ({
  "~standard": {
    version: 1,
    validate: (value: unknown) =>
      typeof value === "object" && value !== null
        ? { issues: [{ message: "objects are rejected", path: [] }] }
        : { value },
  },
});

// ---------------------------------------------------------------------------
// Filesystem fixtures (serveStatic attack lab)
// ---------------------------------------------------------------------------

let root = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "bk-agent3-mw-"));
  await mkdir(join(root, "sub"), { recursive: true });
  await writeFile(join(root, "note.txt"), "agent3 note");
  await writeFile(join(root, "sub", "deep.txt"), "deep note");
  // Pin mtime so the weak ETag is stable within a test run.
  const pinned = new Date(Date.UTC(2020, 0, 2, 3, 4, 5));
  await utimes(join(root, "note.txt"), pinned, pinned);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// MW-1: two validator() instances on one application
// ---------------------------------------------------------------------------

describe("MW-1 [RED]: a second validator() must not 500 — getter install must be idempotent", () => {
  it("two different schemas on two routes both validate (second route returns 400, not 500)", async () => {
    const app = createApp(quiet);
    app.post("/a", validator(passthrough()), (c) => c.json({ ok: true }));
    app.post("/b", validator(rejectObjects()), (c) => c.json({ ok: true }));

    // Warm the app through route A first — its validator installs c.valid.
    const first = await app.handle(jsonBody("/a", { a: 1 }));
    expect(first.status).toBe(200);

    // Route B's validator is a DIFFERENT middleware instance with its own
    // WeakSet, so it re-attempts app.decorate("valid") at request time.
    // Correct behavior: the installation is already present (identical
    // getter) — validation must run and the invalid body must answer 400.
    const second = await app.handle(jsonBody("/b", { b: 1 }));
    expect(second.status).toBe(400);
    expect(await second.text()).toContain("objects are rejected");
  });
});

// ---------------------------------------------------------------------------
// MW-2: async Standard Schema validation is silently skipped
// ---------------------------------------------------------------------------

describe("MW-2 [RED]: a Promise-returning validate() must be awaited", () => {
  it("an async schema's issues still reject the request with 400 (validation is not skipped)", async () => {
    // Standard Schema v1 explicitly allows validate() to return a Promise
    // (valibot async, zod .refine(async …) wrappers). The middleware must
    // treat a thenable as pending validation — never as "no issues".
    const asyncSchema = {
      "~standard": {
        version: 1,
        validate: async (value: unknown) =>
          typeof value === "object" && value !== null
            ? { issues: [{ message: "banned payload", path: [] }] }
            : { value },
      },
    } as unknown as StandardSchema;

    const app = createApp(quiet);
    app.post("/x", validator(asyncSchema), (c) =>
      c.json({ got: (c as unknown as { valid?: unknown }).valid ?? null }),
    );

    const res = await app.handle(jsonBody("/x", { evil: "<script>" }));
    // Correct behavior: the schema rejected the body — 400, and the
    // unvalidated payload never reaches the handler.
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("banned payload");
  });
});

// ---------------------------------------------------------------------------
// MW-3: If-None-Match mismatch serves an empty 200
// ---------------------------------------------------------------------------

describe("MW-3 [RED]: a non-matching If-None-Match must serve the full representation", () => {
  it("stale If-None-Match answers 200 WITH the file body (not an empty 200)", async () => {
    const app = createApp(quiet);
    app.use(serveStatic({ root }));

    const res = await app.handle(
      req("/note.txt", { headers: { "if-none-match": 'W/"0000-deadbeef"' } }),
    );
    expect(res.status).toBe(200);
    // Correct behavior: mismatched validator -> full 200 representation.
    expect(await res.text()).toBe("agent3 note");
  });

  it("a wildcard-or-multi If-None-Match that does not match also serves the body", async () => {
    const app = createApp(quiet);
    app.use(serveStatic({ root }));

    const res = await app.handle(
      req("/note.txt", { headers: { "if-none-match": 'W/"aaa", W/"bbb"' } }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("agent3 note");
  });
});

// ---------------------------------------------------------------------------
// MW-4: serveStatic prefix strips on a non-boundary match
// ---------------------------------------------------------------------------

describe("MW-4 [RED]: prefix must only strip at a path-segment boundary", () => {
  it("a path that merely STARTS WITH the prefix is not under the mount", async () => {
    const app = createApp(quiet);
    app.use(serveStatic({ root, prefix: "/assets" }));

    // Control: the mounted URL space works.
    const mounted = await app.handle(req("/assets/sub/deep.txt"));
    expect(mounted.status).toBe(200);
    expect(await mounted.text()).toBe("deep note");

    // "/assetsfoo/sub/deep.txt" is NOT under /assets/ — the middleware must
    // fall through (404), never resolve root-relative and serve the file.
    // (The startsWith strip leaves a slash-less relative, so the FIRST
    // segment is silently eaten by the segmenter: root/sub/deep.txt serves.)
    const adjacent = await app.handle(req("/assetsfoo/sub/deep.txt"));
    expect(adjacent.status).toBe(404);
  });

  it("a sibling route name is not shadowed by the static mount", async () => {
    // The mount must not hijack URL space that belongs to other routes:
    // "/assets-internal" only differs from the prefix by a suffix.
    const app = createApp(quiet);
    app.use(serveStatic({ root, prefix: "/assets" }));
    app.get("/assets-internal", (c) => c.text("route handler"));

    const res = await app.handle(req("/assets-internal"));
    expect(await res.text()).toBe("route handler");
  });
});

// ---------------------------------------------------------------------------
// MW-5: responseCache replays Cookie-personalized responses cross-user
// ---------------------------------------------------------------------------

describe("MW-5 [RED]: requests bearing a Cookie header must not seed/replay cache entries", () => {
  it("alice's cached response is not replayed to bob (request Cookie is identity)", async () => {
    const app = createApp(quiet);
    // A handler that personalizes on the request's Cookie header without
    // touching the c.cookies facade and without setting any cookie —
    // every other eligibility rule is satisfied.
    app.get("/me", cache({ ttl: 60_000 }), (c) => c.text(`user:${c.get("cookie") ?? "anon"}`));

    const alice = await app.handle(req("/me", { headers: { cookie: "session=alice" } }));
    expect(await alice.text()).toBe("user:session=alice");

    // Correct behavior: a Cookie-bearing request is identity-scoped exactly
    // like an Authorization-bearing one — it must bypass the cache entirely.
    const bob = await app.handle(req("/me", { headers: { cookie: "session=bob" } }));
    expect(bob.headers.get("x-cache")).toBeNull();
    expect(await bob.text()).toBe("user:session=bob");
  });

  it("an anonymous request is still cacheable after cookie-bearing ones were skipped", async () => {
    const app = createApp(quiet);
    let computed = 0;
    app.get("/pub", cache({ ttl: 60_000 }), (c) => {
      computed += 1;
      // c.get() returns "" (never null) for an absent header — the facade
      // contract — so the anonymous fallback keys on emptiness.
      const cookie = c.get("cookie");
      return c.text(`public:${cookie.length > 0 ? cookie : "anon"}`);
    });

    // Cookie-bearing request computes fresh and does NOT poison the entry…
    const bob = await app.handle(req("/pub", { headers: { cookie: "session=bob" } }));
    expect(await bob.text()).toBe("public:session=bob");
    // …so the next anonymous request may cache…
    const anon = await app.handle(req("/pub"));
    expect(await anon.text()).toBe("public:anon");
    // …and further anonymous requests hit it.
    const replay = await app.handle(req("/pub"));
    expect(replay.headers.get("x-cache")).toBe("hit");
    expect(computed).toBe(2);
  });
});
