/**
 * serveStatic tests: serving, mime, 304s, and the security matrix
 * (traversal, null bytes, symlinks, root containment).
 */

import { statSync } from "node:fs";
import { mkdtemp, mkdir, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Keala } from "../../src/core/app.ts";
import { serveStatic } from "../../src/middleware/serve-static.ts";
import { isWithinRoot, resolveRelativeSegments } from "../../src/utils/path-safety.ts";

const quiet = { env: "test" } as const;
let root = "";
let outsideRoot = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "bk-static-"));
  await writeFile(join(root, "index.html"), "<h1>index</h1>");
  await writeFile(join(root, "app.js"), "console.log(1)");
  await writeFile(join(root, "app.js.br"), "pretend-brotli(app.js)");
  await writeFile(join(root, "app.js.gz"), "pretend-gzip(app.js)");
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

const getFrom = (
  app: { handle(r: Request): Promise<Response> },
  path: string,
  headers?: Record<string, string>,
) => app.handle(new Request(`http://localhost:3000${path}`, { headers }));

const appWith = () => {
  const app = new Keala(quiet);
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
    const app = new Keala(quiet);
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
    const app = new Keala(quiet);
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
    const app = new Keala(quiet);
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
    const app = new Keala(quiet);
    app.use(serveStatic({ root, followSymlinks: true }));
    const res = await app.handle(req("/link.js"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("console.log(1)");
  });

  it("prefix stripping serves mounted assets", async () => {
    const app = new Keala(quiet);
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
    const app = new Keala(quiet);
    app.use(serveStatic({ root }));
    const res = await app.handle(req("/sub"));
    expect(res.status).toBe(404);
  });

  it("a configured index escaping the root is refused", async () => {
    const app = new Keala(quiet);
    app.use(serveStatic({ root, index: `../../${OUTSIDE_NAME}/secret.txt` }));
    const res = await app.handle(req("/sub"));
    expect(res.status).toBe(403);
  });

  it("malformed percent escapes pass through verbatim and miss", async () => {
    const app = new Keala(quiet);
    app.use(serveStatic({ root }));
    const res = await app.handle(req("/%FF%FE%zz"));
    expect(res.status).toBe(404);
  });
});

describe("serveStatic: precompressed variants", () => {
  const preApp = (options: { precompressed?: boolean } = {}) => {
    const app = new Keala(quiet);
    app.use(serveStatic({ root, ...options }));
    return app;
  };

  it("serves the .br sibling for Accept-Encoding: br, typed by the ORIGINAL extension", async () => {
    const res = await getFrom(preApp({ precompressed: true }), "/app.js", {
      "accept-encoding": "br",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("pretend-brotli(app.js)");
    expect(res.headers.get("content-encoding")).toBe("br");
    expect(res.headers.get("vary")).toBe("Accept-Encoding");
    expect(res.headers.get("content-type")).toBe("text/javascript");
  });

  it("serves the .gz sibling for gzip acceptance", async () => {
    const res = await getFrom(preApp({ precompressed: true }), "/app.js", {
      "accept-encoding": "gzip, deflate",
    });
    expect(await res.text()).toBe("pretend-gzip(app.js)");
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("vary")).toBe("Accept-Encoding");
  });

  it("prefers brotli when the client accepts both encodings", async () => {
    const res = await getFrom(preApp({ precompressed: true }), "/app.js", {
      "accept-encoding": "gzip, deflate, br",
    });
    expect(await res.text()).toBe("pretend-brotli(app.js)");
    expect(res.headers.get("content-encoding")).toBe("br");
  });

  it("accepts x-gzip and the * wildcard as gzip/any acceptance", async () => {
    const app = preApp({ precompressed: true });
    const xgzip = await getFrom(app, "/app.js", { "accept-encoding": "x-gzip" });
    expect([xgzip.headers.get("content-encoding"), await xgzip.text()]).toEqual([
      "gzip",
      "pretend-gzip(app.js)",
    ]);
    // q-parameters are stripped before the token match.
    const weighted = await getFrom(app, "/app.js", { "accept-encoding": "gzip;q=0.8, br;q=1.0" });
    expect(weighted.headers.get("content-encoding")).toBe("br");
    const wildcard = await getFrom(app, "/app.js", { "accept-encoding": "*" });
    expect(wildcard.headers.get("content-encoding")).toBe("br");
  });

  it("falls back to the original when the file has no matching sibling", async () => {
    const res = await getFrom(preApp({ precompressed: true }), "/data.json", {
      "accept-encoding": "br, gzip",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":true}');
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("vary")).toBeNull();
  });

  it("no encoding acceptance serves the original bytes untouched", async () => {
    const app = preApp({ precompressed: true });
    const bare = await getFrom(app, "/app.js");
    expect(await bare.text()).toBe("console.log(1)");
    const identity = await getFrom(app, "/app.js", { "accept-encoding": "identity" });
    expect(await identity.text()).toBe("console.log(1)");
    expect(identity.headers.get("content-encoding")).toBeNull();
  });

  it("is opt-in: without the flag the siblings are ignored", async () => {
    const res = await getFrom(preApp(), "/app.js", { "accept-encoding": "br" });
    expect(await res.text()).toBe("console.log(1)");
    expect(res.headers.get("content-encoding")).toBeNull();
  });

  it("variant responses carry representation-specific validators", async () => {
    const app = preApp({ precompressed: true });
    const plain = await getFrom(app, "/app.js");
    const encoded = await getFrom(app, "/app.js", { "accept-encoding": "br" });
    expect(plain.headers.get("etag")).not.toBe(encoded.headers.get("etag"));
  });

  it("a lone .br sibling whose original is missing still answers 404 (hono parity)", async () => {
    await writeFile(join(root, "ghost.css.br"), "orphan");
    const res = await getFrom(preApp({ precompressed: true }), "/ghost.css", {
      "accept-encoding": "br",
    });
    expect(res.status).toBe(404);
  });
});

describe("serveStatic: onFound / onNotFound hooks", () => {
  it("onFound receives the request path and the served file's size", async () => {
    const seen: Array<[string, number]> = [];
    const app = new Keala(quiet);
    app.use(serveStatic({ root, onFound: (path, size) => void seen.push([path, size]) }));
    const res = await app.handle(req("/report.txt"));
    expect(res.status).toBe(200);
    expect(seen).toEqual([["/report.txt", statSync(join(root, "report.txt")).size]]);
  });

  it("onFound reports the precompressed sibling's size when it is served", async () => {
    const seen: Array<[string, number]> = [];
    const app = new Keala(quiet);
    app.use(
      serveStatic({
        root,
        precompressed: true,
        onFound: (path, size) => void seen.push([path, size]),
      }),
    );
    await app.handle(
      new Request("http://localhost:3000/app.js", { headers: { "accept-encoding": "br" } }),
    );
    expect(seen).toEqual([["/app.js", statSync(join(root, "app.js.br")).size]]);
  });

  it("onNotFound fires with the request path on a missing file", async () => {
    const seen: string[] = [];
    const app = new Keala(quiet);
    app.use(serveStatic({ root, onNotFound: (path) => void seen.push(path) }));
    const res = await app.handle(req("/missing.js"));
    expect(res.status).toBe(404);
    expect(seen).toEqual(["/missing.js"]);
  });

  it("a dotfile decline and a traversal refusal are NOT disk misses — no onNotFound", async () => {
    await writeFile(join(root, ".env"), "SECRET");
    const seen: string[] = [];
    const app = new Keala(quiet);
    app.use(serveStatic({ root, onNotFound: (path) => void seen.push(path) }));
    // Dotfile policy declines via next() — a policy refusal, not a disk miss.
    const dot = await app.handle(req("/.env"));
    expect(dot.status).toBe(404);
    const traversal = await app.handle(req("/..%2f..%2fetc/passwd"));
    expect(traversal.status).toBeGreaterThanOrEqual(400);
    expect(seen).toEqual([]);
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
