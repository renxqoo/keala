/**
 * {dir} sink safety-scan tests (SEC-1): the native routes table serves a
 * directory with NO per-request checks, so every tree is scanned before it
 * goes native — dotfiles and symlinks the JS mirror declines/403s would be
 * plain 200s one layer down. Registration stays sync and fs-free; the scan
 * lives in buildNativeRoutes (listen / sink-after-listen / reload all run
 * it) so a refusal fails the build before any byte is served natively.
 */

import { mkdtemp, mkdir, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// globalThis.Bun is non-writable AND non-configurable on the real Bun
// runtime — the reload test stubs it, so it runs on the Node gate only.
const REAL_BUN = typeof Bun !== "undefined";

import { Keala, startBunServer, type ServeImplementation } from "../src/index.ts";
import { assertSunkDirSafe, buildNativeRoutes } from "../src/core/sink.ts";

const quiet = { env: "test" } as const;
const req = (path: string) => new Request(`http://localhost:3000${path}`);
const unreachableServe: ServeImplementation = () => {
  throw new Error("serve must never be reached");
};

let clean = "";
let dirty = "";

beforeAll(async () => {
  clean = await mkdtemp(join(tmpdir(), "bk-scan-clean-"));
  await writeFile(join(clean, "app.js"), "console.log(1)");
  await writeFile(join(clean, "index.html"), "<h1>i</h1>");
  await mkdir(join(clean, ".well-known"));
  await writeFile(join(clean, ".well-known", "acme.txt"), "challenge");
  await mkdir(join(clean, "sub"));
  await writeFile(join(clean, "sub", "deep.css"), "body{}");

  dirty = await mkdtemp(join(tmpdir(), "bk-scan-dirty-"));
  await writeFile(join(dirty, "ok.txt"), "fine");
  await writeFile(join(dirty, ".env"), "SECRET_DOTFILE");
  // The link's target must EXIST: the mirror stats before walking, and a
  // dangling link 404s at the stat — 403 is the walk's verdict for live links.
  await symlink(join(dirty, "ok.txt"), join(dirty, "link.txt"));
  await mkdir(join(dirty, "sub"));
  await symlink("/tmp", join(dirty, "sub", "linkdir"));
});

afterAll(async () => {
  await rm(clean, { recursive: true, force: true });
  await rm(dirty, { recursive: true, force: true });
});

describe("sink dir scan: registration is fs-free, the native build scans", () => {
  it("registerSink alone does not scan (a dirty tree registers; the JS mirror guards per request)", async () => {
    const app = new Keala(quiet);
    expect(() => app.sink("/assets/*", { dir: dirty })).not.toThrow();
    // The mirror keeps serveStatic semantics: dotfile declines, symlink 403s.
    expect((await app.handle(req("/assets/ok.txt"))).status).toBe(200);
    expect((await app.handle(req("/assets/.env"))).status).toBe(404);
    expect((await app.handle(req("/assets/link.txt"))).status).toBe(403);
  });

  it("buildNativeRoutes refuses a dirty tree, listing every violation kind and both remedies", () => {
    const app = new Keala(quiet);
    app.sink("/assets/*", { dir: dirty });
    expect(() => buildNativeRoutes(app.nativeSinks)).toThrow(TypeError);
    expect(() => buildNativeRoutes(app.nativeSinks)).toThrow(/\.env \(dotfile\)/);
    expect(() => buildNativeRoutes(app.nativeSinks)).toThrow(/link\.txt \(symlink\)/);
    expect(() => buildNativeRoutes(app.nativeSinks)).toThrow(/linkdir \(symlink\)/);
    expect(() => buildNativeRoutes(app.nativeSinks)).toThrow(/Remove the offending entries/);
    expect(() => buildNativeRoutes(app.nativeSinks)).toThrow(/Response\/handler sink instead/);
  });

  it("a clean tree (with .well-known and subdirectories) builds normally", () => {
    const app = new Keala(quiet);
    app.sink("/assets/*", { dir: clean });
    const routes = buildNativeRoutes(app.nativeSinks);
    expect(routes["/assets/*"]).toEqual({ GET: { dir: clean } });
  });

  it("Response and function sinks never touch the filesystem", () => {
    const app = new Keala(quiet);
    app.sink("/health", new Response("ok"));
    app.sink("/fn/:id", (_request, params) => new Response(params["id"] ?? ""));
    expect(() => buildNativeRoutes(app.nativeSinks)).not.toThrow();
  });

  it("startBunServer fails loudly when the scan refuses (listen never serves)", () => {
    const app = new Keala(quiet);
    app.sink("/assets/*", { dir: dirty });
    expect(() => startBunServer(app, { port: 0 }, undefined, unreachableServe)).toThrow(/dotfile/);
  });

  it("a dotfile under .well-known refuses (the RFC 8615 exemption is per-segment)", async () => {
    const root = await mkdtemp(join(tmpdir(), "bk-scan-wk-"));
    try {
      await mkdir(join(root, ".well-known"));
      await writeFile(join(root, ".well-known", "acme.txt"), "ok");
      await writeFile(join(root, ".well-known", ".hidden"), "no");
      expect(() => assertSunkDirSafe("/w/*", root)).toThrow(/\.hidden \(dotfile\)/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("a root that cannot be scanned refuses (it cannot be verified)", () => {
    expect(() => assertSunkDirSafe("/g/*", join(tmpdir(), "bk-scan-ghost"))).toThrow(/cannot scan/);
  });
});

describe("sink dir scan: budgets bound the walk itself", () => {
  it("more than 10000 entries refuses with the budget message", async () => {
    const root = await mkdtemp(join(tmpdir(), "bk-scan-budget-"));
    try {
      // 10001 entries in one directory: readdir itself is one call, the
      // counter is what refuses.
      const { writeFileSync } = await import("node:fs");
      for (let i = 0; i <= 10_000; i++) writeFileSync(join(root, `f${i}`), "x");
      expect(() => assertSunkDirSafe("/big/*", root)).toThrow(/scan budget/);
      // Exactly 10000 passes (the 10001st entry is what trips).
      const other = await mkdtemp(join(tmpdir(), "bk-scan-budget2-"));
      try {
        for (let i = 0; i < 9_999; i++) writeFileSync(join(other, `f${i}`), "x");
        expect(() => assertSunkDirSafe("/ok/*", other)).not.toThrow();
      } finally {
        await rm(other, { recursive: true, force: true });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("trees deeper than 64 refuse", async () => {
    const root = await mkdtemp(join(tmpdir(), "bk-scan-depth-"));
    try {
      const { mkdirSync } = await import("node:fs");
      let current = root;
      for (let i = 0; i < 70; i++) {
        current = join(current, `d${i}`);
        mkdirSync(current);
      }
      expect(() => assertSunkDirSafe("/deep/*", root)).toThrow(/deeper than 64/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(REAL_BUN)("sink dir scan: the reload paths rescan", () => {
  it("sink() after listen() refuses the reload when the tree is dirty", async () => {
    const originalBun = (globalThis as { Bun?: unknown }).Bun;
    const reloads: unknown[] = [];
    const impl: ServeImplementation = () => ({
      port: 0,
      hostname: "localhost",
      stop: () => undefined,
      fetch: async () => new Response("fake"),
      reload: (next) => reloads.push(next),
    });
    (globalThis as { Bun?: unknown }).Bun = { serve: impl };
    try {
      const app = new Keala(quiet);
      const server = app.listen(0);
      // Clean tree reloads fine.
      app.sink("/ok/*", { dir: clean });
      expect(reloads.length).toBe(1);
      // Dirty tree: the mirror registers, the reload refuses loudly.
      expect(() => app.sink("/bad/*", { dir: dirty })).toThrow(/dotfile/);
      expect(reloads.length).toBe(1); // the dirty reload never landed
      expect(() => app.reloadNativeRoutes()).toThrow(/dotfile/);
      server.stop();
    } finally {
      if (originalBun === undefined) delete (globalThis as { Bun?: unknown }).Bun;
      else (globalThis as { Bun?: unknown }).Bun = originalBun;
    }
  });
});
