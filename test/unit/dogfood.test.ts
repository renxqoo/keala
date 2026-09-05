/**
 * DOGFOOD-R1 — contract locks for the first real consumer's feedback round
 * (docs/DOGFOOD-R1.md). Six verified findings, three API fixes and three
 * doc gaps; these tests pin the API halves (C1–C4). Doc halves live in the
 * READMEs.
 */

import { mkdtemp, mkdir, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";

import { Keala } from "../../src/core/app.ts";
import {
  findSymlink,
  isNotModified,
  isWithinRoot,
  resolveRelativeSegments,
  weakEtag,
  type FreshnessInput,
  type QueryMap,
  type QueryValue,
} from "../../src/index.ts";

const quiet = { env: "test" } as const;
const req = (path: string, init?: RequestInit) => new Request(`http://localhost:3000${path}`, init);

// ---------------------------------------------------------------------------
// C1 — app.handle() always settles through a Promise (the union type is gone;
// consumers chain .then() directly — the top dogfood friction).
// ---------------------------------------------------------------------------

describe("C1: app.handle() returns Promise<Response>", () => {
  it("returns a Promise for a fully-sync handler", async () => {
    const app = new Keala(quiet);
    app.get("/sync", () => new Response("ok"));
    const pending = app.handle(req("/sync"));
    expect(pending).toBeInstanceOf(Promise);
    const res = await pending;
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe("ok");
  });

  it("supports direct .then() chains — the reported friction", async () => {
    const app = new Keala(quiet);
    app.get("/json", (c) => c.json({ a: 1 }));
    const body = await app.handle(req("/json")).then((r) => r.json());
    expect(body).toEqual({ a: 1 });
  });

  it("returns a Promise for async handlers, 404s, 405s and error responses", async () => {
    const app = new Keala(quiet);
    app.get("/slow", async (c) => {
      await Promise.resolve();
      return c.text("slow");
    });
    app.get("/boom", () => {
      throw new Error("boom");
    });
    const pendingSync404 = app.handle(req("/nowhere"));
    const pending405 = app.handle(req("/slow", { method: "POST" }));
    const pendingErr = app.handle(req("/boom"));
    const pendingAsync = app.handle(req("/slow"));
    for (const pending of [pendingSync404, pending405, pendingErr, pendingAsync]) {
      expect(pending).toBeInstanceOf(Promise);
    }
    expect((await pendingSync404).status).toBe(404);
    expect((await pending405).status).toBe(405);
    expect((await pendingErr).status).toBe(500);
    await expect((await pendingAsync).text()).resolves.toBe("slow");
  });

  it("keeps the never-reject contract under pooling (locked reader → 500)", async () => {
    const app = new Keala({ ...quiet, pooling: true });
    app.get("/locked", () => {
      const res = new Response(new ReadableStream());
      res.body?.getReader(); // handler bug: lock the body, never release
      return res;
    });
    const pending = app.handle(req("/locked"));
    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).resolves.toHaveProperty("status", 500);
  });

  it("callback() hands out the same Promise-returning shape", async () => {
    const app = new Keala(quiet);
    app.get("/cb", (c) => c.text("cb"));
    const handler = app.callback();
    const res = await handler(req("/cb"));
    expect(await res.text()).toBe("cb");
  });
});

// ---------------------------------------------------------------------------
// C2 — conditional-request + path-safety primitives on the ROOT entry
// (previously locked inside serveStatic's inline logic; consumers had to
// re-implement ~50 lines — keala-markdown paths.ts is the witness).
// ---------------------------------------------------------------------------

describe("C2: weakEtag", () => {
  it("formats size/mtime as hex under a weak validator", () => {
    expect(weakEtag(255, 0xabc)).toBe('W/"ff-abc"');
    expect(weakEtag(0, 0)).toBe('W/"0-0"');
  });
});

describe("C2: isNotModified (RFC 9110 freshness judge)", () => {
  const etag = 'W/"ff-abc"';
  const mtimeMs = 1_000_000;
  const cases: ReadonlyArray<{ name: string; input: FreshnessInput; expected: boolean }> = [
    {
      name: "exact If-None-Match match",
      input: { etag, mtimeMs, ifNoneMatch: etag, ifModifiedSince: "" },
      expected: true,
    },
    {
      name: "If-None-Match mismatch",
      input: { etag, mtimeMs, ifNoneMatch: 'W/"ff-abd"', ifModifiedSince: "" },
      expected: false,
    },
    {
      name: "If-None-Match: * matches any representation",
      input: { etag, mtimeMs, ifNoneMatch: "*", ifModifiedSince: "" },
      expected: true,
    },
    {
      name: "W/ prefix ignored on both sides",
      input: { etag, mtimeMs, ifNoneMatch: '"ff-abc"', ifModifiedSince: "" },
      expected: true,
    },
    {
      name: "candidate list matches one entry",
      input: { etag, mtimeMs, ifNoneMatch: '"x-1", W/"ff-abc"', ifModifiedSince: "" },
      expected: true,
    },
    {
      name: "If-None-Match decides when present — a stale If-Modified-Since cannot resurrect it",
      input: {
        etag,
        mtimeMs,
        ifNoneMatch: 'W/"other"',
        ifModifiedSince: new Date(mtimeMs).toUTCString(),
      },
      expected: false,
    },
    // HTTP dates carry whole seconds only — the 999ms tolerance exists so a
    // file restatted within the same second stays fresh (mtime 00:16:40.5 vs
    // a client cache timestamped 00:16:40 → fresh; 00:16:38 → stale).
    {
      name: "999ms tolerance: same-second mtime is fresh",
      input: {
        etag,
        mtimeMs: 1_000_500,
        ifNoneMatch: "",
        ifModifiedSince: "Thu, 01 Jan 1970 00:16:40 GMT",
      },
      expected: true,
    },
    {
      name: "two seconds off is stale",
      input: {
        etag,
        mtimeMs: 1_000_500,
        ifNoneMatch: "",
        ifModifiedSince: "Thu, 01 Jan 1970 00:16:38 GMT",
      },
      expected: false,
    },
    {
      name: "invalid If-Modified-Since date is not fresh",
      input: { etag, mtimeMs, ifNoneMatch: "", ifModifiedSince: "not-a-date" },
      expected: false,
    },
    {
      name: "no validators at all",
      input: { etag, mtimeMs, ifNoneMatch: "", ifModifiedSince: "" },
      expected: false,
    },
  ];
  for (const { name, input, expected } of cases) {
    it(name, () => {
      expect(isNotModified(input)).toBe(expected);
    });
  }
});

describe("C2: findSymlink", () => {
  let root = "";
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "bk-dogfood-"));
    await writeFile(join(root, "plain.txt"), "x");
    await symlink(join(root, "plain.txt"), join(root, "link.txt"));
    await mkdir(join(root, "dir"));
    await writeFile(join(root, "dir", "file.txt"), "x");
    await symlink(join(root, "dir"), join(root, "linkdir"));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns null when no component under root is a symlink", async () => {
    await expect(findSymlink(root, join(root, "dir", "file.txt"))).resolves.toBeNull();
  });
  it("returns the symlinked FILE component", async () => {
    await expect(findSymlink(root, join(root, "link.txt"))).resolves.toBe(join(root, "link.txt"));
  });
  it("returns a symlinked DIRECTORY component on the way to a real file", async () => {
    await expect(findSymlink(root, join(root, "linkdir", "file.txt"))).resolves.toBe(
      join(root, "linkdir"),
    );
  });
  it("returns null when a component vanished mid-walk (the read fails on its own)", async () => {
    await expect(findSymlink(root, join(root, "gone", "file.txt"))).resolves.toBeNull();
  });
  it("never flags root itself, even when root is a symlink", async () => {
    const linkedRoot = join(root, "linkdir"); // linkdir → root/dir
    await expect(findSymlink(linkedRoot, join(linkedRoot, "file.txt"))).resolves.toBeNull();
  });
});

describe("C2: path-safety primitives re-exported from the root entry", () => {
  it("resolveRelativeSegments keeps its security semantics (regression after move)", () => {
    expect(resolveRelativeSegments("/a/../b/./c", false)).toEqual(["b", "c"]);
    expect(resolveRelativeSegments("/guarded%2Fsecret", false)).toBeNull();
    expect(resolveRelativeSegments("/", false)).toEqual([]);
  });
  it("isWithinRoot compares with the platform separator", () => {
    expect(isWithinRoot("/www/file", "/www", "/")).toBe(true);
    expect(isWithinRoot("/wwwfile", "/www", "/")).toBe(false);
  });
  it("the primitives are the ones serveStatic itself uses (same import path)", async () => {
    // serveStatic behavior is covered by middleware-serve-static.test.ts; here
    // we lock that the ROOT exports exist as callable values.
    expect(typeof resolveRelativeSegments).toBe("function");
    expect(typeof isWithinRoot).toBe("function");
    expect(typeof findSymlink).toBe("function");
    expect(typeof weakEtag).toBe("function");
    expect(typeof isNotModified).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// C3 — c.query shape is part of the public vocabulary.
// ---------------------------------------------------------------------------

describe("C3: c.query shape types are exported", () => {
  it("QueryMap is a Record of string | string[]", async () => {
    const app = new Keala(quiet);
    app.get("/q", (c) => c.json({ single: c.query("single"), multi: c.queries("multi") }));
    const res = await app.handle(req("/q?single=1&multi=a&multi=b"));
    expect(await res.json()).toEqual({ single: "1", multi: ["a", "b"] });

    const map: QueryMap = { single: "1", multi: ["a", "b"] };
    const single: QueryValue = map["single"] as QueryValue;
    expect(single).toBe("1");
  });
});

// ---------------------------------------------------------------------------
// C4 — development-mode warning when global middleware swallows a matched
// route (the "hono mental model" trap from the dogfood round).
// ---------------------------------------------------------------------------

describe("C4: dev warning for routes swallowed by global middleware", () => {
  const warns = () => vi.spyOn(console, "warn").mockImplementation(() => {});
  afterEach(() => vi.restoreAllMocks());

  it("warns once (deduped) when global middleware returns without next()", async () => {
    const warn = warns();
    const app = new Keala({ env: "development" });
    app.use(() => new Response("from middleware"));
    app.get("/health", (c) => c.text("ok"));

    const first = await app.handle(req("/health"));
    expect(await first.text()).toBe("from middleware"); // the swallow itself
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain("GET");
    expect(message).toContain("/health");
    expect(message).toContain("next");

    await app.handle(req("/health"));
    expect(warn).toHaveBeenCalledTimes(1); // deduped per method+path
  });

  it("does not warn when the middleware calls next()", async () => {
    const warn = warns();
    const app = new Keala({ env: "development" });
    app.use(async (_c, next) => {
      await next();
    });
    app.get("/health", (c) => c.text("ok"));
    const res = await app.handle(req("/health"));
    expect(await res.text()).toBe("ok");
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not warn when the middleware rejects by throwing (intentional)", async () => {
    const warn = warns();
    const app = new Keala({ env: "development" });
    app.use((c) => {
      c.throw(401, "auth required");
    });
    app.get("/private", (c) => c.text("secret"));
    const res = await app.handle(req("/private"));
    expect(res.status).toBe(401);
    expect(warn).not.toHaveBeenCalled();
  });

  it("is silent outside development env", async () => {
    const warn = warns();
    const app = new Keala({ env: "production" });
    app.use(() => new Response("from middleware"));
    app.get("/health", (c) => c.text("ok"));
    await app.handle(req("/health"));
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not warn for unmatched paths (koa's global-middleware contract)", async () => {
    const warn = warns();
    const app = new Keala({ env: "development" });
    app.use(() => new Response(null, { status: 404 }));
    await app.handle(req("/nowhere"));
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not warn without global middleware (direct chain, nothing to swallow)", async () => {
    const warn = warns();
    const app = new Keala({ env: "development" });
    app.get("/health", (c) => c.text("ok"));
    const res = await app.handle(req("/health"));
    expect(await res.text()).toBe("ok");
    expect(warn).not.toHaveBeenCalled();
  });

  it("stays silent for the wildcard-route recipe (explicit route wins)", async () => {
    const warn = warns();
    const app = new Keala({ env: "development" });
    app.get("/health", (c) => c.text("ok"));
    app.get("/*", (c) => c.text(`fallback: ${c.path}`));
    const health = await app.handle(req("/health"));
    expect(await health.text()).toBe("ok");
    const fallback = await app.handle(req("/other"));
    expect(await fallback.text()).toBe("fallback: /other");
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns for async middleware that returns without next()", async () => {
    const warn = warns();
    const app = new Keala({ env: "development" });
    app.use(async () => {
      await Promise.resolve();
      return new Response("async swallow");
    });
    app.get("/health", (c) => c.text("ok"));
    await app.handle(req("/health"));
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("dedupes per app: a second app warns for its own requests", async () => {
    const warn = warns();
    const first = new Keala({ env: "development" });
    first.use(() => new Response("x"));
    first.get("/health", (c) => c.text("ok"));
    await first.handle(req("/health"));

    const second = new Keala({ env: "development" });
    second.use(() => new Response("x"));
    second.get("/health", (c) => c.text("ok"));
    await second.handle(req("/health"));
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
