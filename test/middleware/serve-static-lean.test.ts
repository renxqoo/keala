/**
 * serveStatic lean-path equivalence tests (PERF-2). The lean path only
 * exists under Bun (module-load gate on the Bun global), so these stub
 * Bun.file BEFORE importing the middleware — they run on the Node gate
 * only, mirroring native-sink.test.ts's stub discipline. The REAL-runtime
 * leg (missing-file 404s, Bun auto-Range, actual sendfile) is verified
 * against a live Bun.serve in the R4.11 review report.
 *
 * What must NOT change on the lean path: the string-layer safety (decode /
 * containment / null bytes / dotfile policy), the 404 for missing files,
 * the 403 for symlinks (the stub below would happily serve anything — the
 * walk must refuse first), and full slow-path semantics whenever
 * conditional headers or index resolution are in play.
 */

import { mkdtemp, mkdir, symlink, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REAL_BUN = typeof Bun !== "undefined";

let root = "";
let outsideRoot = "";
// Stubs installed before the middleware import (the bunFile binding is
// decided at module load). Keala is imported lazily for the same reason.
let serveStaticMod: typeof import("../../src/middleware/serve-static.ts") | null = null;
let KealaMod: typeof import("../../src/core/app.ts") | null = null;
const OUTSIDE_NAME = "bk-lean-outside";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "bk-lean-"));
  await writeFile(join(root, "file.txt"), "plain\n");
  await writeFile(join(root, "app.js"), "console.log(1)");
  await writeFile(join(root, "index.html"), "<h1>idx</h1>");
  await mkdir(join(root, "sub"));
  await writeFile(join(root, "sub", "deep.css"), "body{}");
  await symlink(join(root, "file.txt"), join(root, "self.txt"));
  outsideRoot = join(dirname(root), OUTSIDE_NAME);
  await mkdir(outsideRoot, { recursive: true });
  await writeFile(join(outsideRoot, "secret.txt"), "TOP SECRET");

  // Install the stub only on the Node gate — on real Bun the global is
  // non-writable and the tests are skipped anyway.
  if (!REAL_BUN) {
    (globalThis as { Bun?: unknown }).Bun = {
      file: (path: string): Blob => new Blob([readFileSync(path)]),
    };
  }
  serveStaticMod = await import("../../src/middleware/serve-static.ts");
  KealaMod = await import("../../src/core/app.ts");
});

afterAll(async () => {
  if (!REAL_BUN) delete (globalThis as { Bun?: unknown }).Bun;
  await rm(root, { recursive: true, force: true });
  await rm(outsideRoot, { recursive: true, force: true });
});

const req = (path: string, init?: RequestInit) => new Request(`http://localhost:3000${path}`, init);

const appWith = () => {
  const app = new KealaMod!.Keala({ env: "test" });
  app.use(serveStaticMod!.serveStatic({ root }));
  return app;
};

describe.skipIf(REAL_BUN)("serveStatic lean path: fast when eligible, identical when not", () => {
  it("lean 200 serves the file with etag + nosniff + content-type, no last-modified", async () => {
    const res = await appWith().handle(req("/file.txt"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("plain\n");
    expect(res.headers.get("etag")).toMatch(/^W\//);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-type")).toBe("text/plain");
    // The lean path's one deliberate omission (validator layer skipped).
    expect(res.headers.get("last-modified")).toBeNull();
  });

  it("a missing file is 404 — the stat runs even though the stub would serve anything", async () => {
    const res = await appWith().handle(req("/missing.txt"));
    expect(res.status).toBe(404);
  });

  it("symlinks still 403 on the lean path (the walk is not skipped)", async () => {
    const res = await appWith().handle(req("/self.txt"));
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("plain");
  });

  it("followSymlinks:true serves the linked target on the lean path", async () => {
    const app = new KealaMod!.Keala({ env: "test" });
    app.use(serveStaticMod!.serveStatic({ root, followSymlinks: true }));
    const res = await app.handle(req("/self.txt"));
    expect([res.status, await res.text()]).toEqual([200, "plain\n"]);
  });

  it("dotfiles decline (404) exactly like the slow path", async () => {
    await writeFile(join(root, ".env"), "SECRET");
    const res = await appWith().handle(req("/.env"));
    expect(res.status).toBe(404);
  });

  it("if-none-match takes the slow path: 304 with both validators", async () => {
    const app = appWith();
    const first = await app.handle(req("/file.txt"));
    const etag = first.headers.get("etag") ?? "";
    const second = await app.handle(
      new Request("http://localhost:3000/file.txt", { headers: { "if-none-match": etag } }),
    );
    expect(second.status).toBe(304);
  });

  it("if-modified-since takes the slow path: fresh 304, stale 200 with last-modified", async () => {
    const app = appWith();
    const fresh = await app.handle(
      new Request("http://localhost:3000/file.txt", {
        headers: { "if-modified-since": new Date(Date.now() + 60000).toUTCString() },
      }),
    );
    expect(fresh.status).toBe(304);
    const stale = await app.handle(
      new Request("http://localhost:3000/file.txt", {
        headers: { "if-modified-since": new Date(0).toUTCString() },
      }),
    );
    expect(stale.status).toBe(200);
    expect(stale.headers.get("last-modified")).not.toBeNull();
  });

  it("a range header takes the slow path (validators present)", async () => {
    const res = await appWith().handle(
      new Request("http://localhost:3000/file.txt", { headers: { range: "bytes=0-3" } }),
    );
    expect(res.status).toBe(200); // stubbed Bun.file: the runtime's seek layer is absent
    expect(res.headers.get("last-modified")).not.toBeNull();
  });

  it("extensionless directory requests take the slow path (index resolution)", async () => {
    const res = await appWith().handle(req("/sub"));
    expect(res.status).toBe(404); // sub/ has no index.html
    expect(res.headers.get("last-modified")).toBeNull(); // 404 carries no validators
    const idx = await appWith().handle(req("/"));
    expect([idx.status, await idx.text()]).toEqual([200, "<h1>idx</h1>"]);
    expect(idx.headers.get("last-modified")).not.toBeNull();
  });

  it("the shared string safety layer still holds on the lean path", async () => {
    const app = appWith();
    // %2F confusion: the router saw ONE segment; the static layer refuses
    // the decoded separator outright.
    expect((await app.handle(req("/sub%2Fdeep.css"))).status).toBe(404);
    // Null bytes answer 400.
    expect((await app.handle(req("/%00a.txt"))).status).toBe(400);
    // Encoded dots (%2e%2e) collapse like plain ".." and stay contained.
    const inside = await app.handle(req("/sub/%2e%2e/file.txt"));
    expect([inside.status, await inside.text()]).toEqual([200, "plain\n"]);
    const escape = await app.handle(req(`/..%2f..%2f${OUTSIDE_NAME}/secret.txt`));
    expect([403, 404]).toContain(escape.status);
    if (escape.status === 200) expect(await escape.text()).not.toBe("TOP SECRET");
    // Non-GET methods fall through untouched.
    expect(
      (await app.handle(new Request("http://localhost:3000/file.txt", { method: "POST" }))).status,
    ).toBe(404);
  });

  it("prefix mounts work identically on the lean path", async () => {
    const app = new KealaMod!.Keala({ env: "test" });
    app.use(serveStaticMod!.serveStatic({ root, prefix: "/assets" }));
    const res = await app.handle(req("/assets/file.txt"));
    expect([res.status, await res.text()]).toEqual([200, "plain\n"]);
  });
});
