/**
 * serveStatic tests: serving, mime, 304s, and the security matrix
 * (traversal, null bytes, symlinks, root containment).
 */

import { mkdtemp, mkdir, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/core/app.ts";
import { serveStatic } from "../src/components/serve-static.ts";

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
