/**
 * serveStatic tests: serving, mime, 304s, and the security matrix
 * (traversal, null bytes, symlinks, root containment).
 */

import { mkdtemp, mkdir, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/core/app.ts";
import {
  isWithinRoot,
  resolveRelativeSegments,
  serveStatic,
} from "../src/middleware/serve-static.ts";

const quiet = { env: "test" } as const;
let root = "";
let outsideRoot = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "bk-static-"));
  await writeFile(join(root, "index.html"), "<h1>index</h1>");
  await writeFile(join(root, "app.js"), "console.log(1)");
  await writeFile(join(root, "data.json"), '{"ok":true}');
  await writeFile(join(root, "report.txt"), "year-end report");
  await mkdir(join(root, "sub"));
  await writeFile(join(root, "sub", "deep.css"), "body{}");
  await symlink(join(root, "app.js"), join(root, "link.js"));
  // The secret lives OUTSIDE root (a true sibling directory).
  outsideRoot = join(dirname(root), OUTSIDE_NAME);
  await mkdir(outsideRoot, { recursive: true });
  await writeFile(join(outsideRoot, "secret.txt"), "secret");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outsideRoot, { recursive: true, force: true });
});

const OUTSIDE_NAME = "bk-outside-secret";

const req = (path: string, init?: RequestInit) => new Request(`http://localhost:3000${path}`, init);

const appWith = () => {
  const app = createApp(quiet);
  app.use(serveStatic({ root }));
  return app;
};

describe("serveStatic: serving", () => {
  it("serves files with mime type and nosniff", async () => {
    const res = await appWith().handle(req("/app.js"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("console.log(1)");
  });

  it("directory requests resolve index.html", async () => {
    const res = await appWith().handle(req("/"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<h1>index</h1>");
  });

  it("nested paths and index:false behave", async () => {
    const app = createApp(quiet);
    app.use(serveStatic({ root, index: false }));
    expect((await app.handle(req("/"))).status).toBe(404);
    expect((await app.handle(req("/sub/deep.css"))).status).toBe(200);
  });

  it("etag and if-modified-since negotiate 304", async () => {
    const app = appWith();
    const first = await app.handle(req("/data.json"));
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^W\//);
    const byEtag = await app.handle(
      new Request("http://localhost:3000/data.json", { headers: { "if-none-match": etag ?? "" } }),
    );
    expect(byEtag.status).toBe(304);
    const byDate = await app.handle(
      new Request("http://localhost:3000/data.json", {
        headers: { "if-modified-since": new Date(Date.now() + 60000).toUTCString() },
      }),
    );
    expect(byDate.status).toBe(304);
  });
});

describe("serveStatic: security matrix", () => {
  it("missing files answer 404 (never 500)", async () => {
    expect((await appWith().handle(req("/nope.js"))).status).toBe(404);
  });

  it("encoded traversal escapes are contained or rejected", async () => {
    const app = appWith();
    // %2e%2e decodes to .. and collapses; resolution must stay inside root.
    const escapes = [
      `/%2e%2e/${OUTSIDE_NAME}/secret.txt`,
      `/../${OUTSIDE_NAME}/secret.txt`,
      `/sub/../../${OUTSIDE_NAME}/secret.txt`,
    ];
    for (const path of escapes) {
      const res = await app.handle(req(path));
      expect([200, 403, 404]).toContain(res.status);
      if (res.status === 200) {
        // URL normalization may have collapsed the dots BEFORE the framework
        // — serving would only happen for a path still inside root.
        expect(await res.text()).not.toBe("secret");
      }
    }
  });

  it("%2F / double-slash path confusion never resolves into a subdirectory (hono parity)", async () => {
    // The router saw ONE segment ("guarded%2Fsecret.txt") — the static layer
    // must refuse to decode that into guarded/secret.txt and serve it.
    await mkdir(join(root, "guarded"));
    await writeFile(join(root, "guarded", "secret.txt"), "TOP SECRET");
    const app = createApp(quiet);
    app.use(serveStatic({ root }));
    for (const path of [
      "/guarded%2Fsecret.txt",
      "/guarded%2fsecret.txt",
      "//guarded/secret.txt",
      "/guarded//secret.txt",
    ]) {
      const res = await app.handle(req(path));
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).not.toBe("TOP SECRET");
    }
    // The plainly-routed path still serves normally.
    const ok = await app.handle(req("/guarded/secret.txt"));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("TOP SECRET");
  });

  it("only GET/HEAD are served; other methods fall through", async () => {
    const app = createApp(quiet);
    app.use(serveStatic({ root }));
    for (const method of ["POST", "DELETE", "PUT"]) {
      const res = await app.handle(new Request(`http://localhost:3000/app.js`, { method }));
      expect(res.status, method).toBe(404); // fell through to not-found
    }
    const head = await app.handle(new Request("http://localhost:3000/app.js", { method: "HEAD" }));
    expect(head.status).toBe(200);
  });

  it("null bytes answer 400", async () => {
    const res = await appWith().handle(req("/%00a.js"));
    expect(res.status).toBe(400);
  });

  it("symlinks are denied by default and served when opted in", async () => {
    expect((await appWith().handle(req("/link.js"))).status).toBe(403);
    const app = createApp(quiet);
    app.use(serveStatic({ root, followSymlinks: true }));
    const res = await app.handle(req("/link.js"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("console.log(1)");
  });

  it("prefix stripping serves mounted assets", async () => {
    const app = createApp(quiet);
    app.use(serveStatic({ root, prefix: "/assets" }));
    const res = await app.handle(req("/assets/report.txt"));
    expect(await res.text()).toBe("year-end report");
  });

  it("root is required", () => {
    expect(() => serveStatic({} as { root: string })).toThrow(TypeError);
  });
});

describe("serveStatic: platform separators", () => {
  it("segments split BEFORE decoding; decoded separators are refused", () => {
    // The router saw ONE segment — a decoded separator inside it can never
    // be a real filename, and carrying it would re-introduce a separator
    // the router never saw (the %2F path-confusion bypass). Refused, always.
    expect(resolveRelativeSegments("/guarded%2Fsecret", false)).toBeNull();
    expect(resolveRelativeSegments("/a%2fb/c", false)).toBeNull();
    expect(resolveRelativeSegments("/..%2F..%2Fx", false)).toBeNull();
    // On Windows a decoded backslash is refused the same way; on POSIX it is
    // an ordinary filename character.
    expect(resolveRelativeSegments("/a%5Cb", true)).toBeNull();
    expect(resolveRelativeSegments("/a%5Cb", false)).toEqual(["a\\b"]);
    // Plain traversal collapses; trailing slash tolerated.
    expect(resolveRelativeSegments("/a/../../secret", false)).toEqual(["secret"]);
    expect(resolveRelativeSegments("/a/../b/./c/d", false)).toEqual(["b", "c", "d"]);
    expect(resolveRelativeSegments("/sub/", false)).toEqual(["sub"]);
    expect(resolveRelativeSegments("/", false)).toEqual([]);
  });

  it("empty interior segments are refused (null), never collapsed", () => {
    expect(resolveRelativeSegments("//guarded/secret", false)).toBeNull();
    expect(resolveRelativeSegments("/a//b", false)).toBeNull();
    expect(resolveRelativeSegments("/a/b//", false)).toBeNull();
  });

  it("isWithinRoot compares with the platform separator", () => {
    expect(isWithinRoot("C:\\www\\file", "C:\\www", "\\")).toBe(true);
    expect(isWithinRoot("C:\\www\\sub\\file", "C:\\www", "\\")).toBe(true);
    // Forward-slash containment must NOT hold for backslash paths — the
    // old check silently rejected every legitimate Windows path (and any
    // mixed-separator bypass relied on the same mismatch).
    expect(isWithinRoot("C:\\www\\file", "C:\\www", "/")).toBe(false);
    expect(isWithinRoot("C:\\other\\file", "C:\\www", "\\")).toBe(false);
    expect(isWithinRoot("C:\\www", "C:\\www", "\\")).toBe(true);
    expect(isWithinRoot("/www/file", "/www", "/")).toBe(true);
    expect(isWithinRoot("/wwwfile", "/www", "/")).toBe(false);
  });
});

describe("serveStatic: coverage top-up", () => {
  it("a directory whose index is missing answers 404", async () => {
    const app = createApp(quiet);
    app.use(serveStatic({ root }));
    const res = await app.handle(req("/sub"));
    expect(res.status).toBe(404);
  });

  it("a configured index escaping the root is refused", async () => {
    const app = createApp(quiet);
    app.use(serveStatic({ root, index: `../../${OUTSIDE_NAME}/secret.txt` }));
    const res = await app.handle(req("/sub"));
    expect(res.status).toBe(403);
  });

  it("malformed percent escapes pass through verbatim and miss", async () => {
    const app = createApp(quiet);
    app.use(serveStatic({ root }));
    const res = await app.handle(req("/%FF%FE%zz"));
    expect(res.status).toBe(404);
  });
});

describe("resolveRelativeSegments: boundary inputs", () => {
  it("empty and dot-only paths collapse to nothing on either platform", () => {
    for (const windows of [false, true]) {
      expect(resolveRelativeSegments("/", windows)).toEqual([]);
      expect(resolveRelativeSegments("/.", windows)).toEqual([]);
      expect(resolveRelativeSegments("/./.", windows)).toEqual([]);
      expect(resolveRelativeSegments("/..", windows)).toEqual([]);
      expect(resolveRelativeSegments("/a/..", windows)).toEqual([]);
    }
  });
});
