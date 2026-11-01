/**
 * Regression locks for sink registration lifecycle — the review round that
 * found them ran as red tests under test/red-review/ (registration
 * reviewer). The fixes:
 *
 *   - registerSink (src/core/sink.ts): registration FIRST, key claim LAST —
 *     the same transactional contract as registerWsRoute/mergeMountedWs. A
 *     throwing mirror registerDef used to strand the nativeSinks entry: a
 *     phantom route with no JS mirror would enter Bun's native table, and
 *     the empty sunkPaths set silently defeated the app.use() ordering
 *     guard. After the fix a failed sink leaves NO entry — and since no
 *     sunk route exists, app.use() stays allowed (the guard fires only
 *     after a sink that actually registered; that half is locked by
 *     test/integration/native-sink.test.ts).
 *   - {dir} sink mirror: the serveStatic prefix is derived from
 *     c.routePath at request time (mount() re-keys the mirror defs), so a
 *     mounted app serves "/m/assets/…" instead of stripping the stale
 *     sub-app-local "/assets" and 404ing everything.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Keala } from "../../src/core/app.ts";
import { buildNativeRoutes } from "../../src/core/sink.ts";

const quiet = { env: "test" } as const;
const req = (path: string) => new Request(`http://localhost:3000${path}`);

let dirRoot = "";
beforeAll(async () => {
  dirRoot = await mkdtemp(join(tmpdir(), "bk-sink-reg-"));
  await writeFile(join(dirRoot, "app.js"), "console.log(1)");
  await writeFile(join(dirRoot, "index.html"), "<h1>i</h1>");
});
afterAll(async () => {
  await rm(dirRoot, { recursive: true, force: true });
});

describe("locks correct: a throwing mirror registration strands nothing", () => {
  it("nativeSinks stays empty when the mirror registerDef throws (transactional key claim)", () => {
    const app = new Keala(quiet);
    // "/a//b" passes every sink pre-check — the failure comes from the
    // mirror registerDef's compilePattern ("Route path has an empty
    // segment"), which runs BEFORE the key claim.
    expect(() => app.sink("/a//b", new Response("x"))).toThrow(/empty segment/);
    expect(app.nativeSinks.size).toBe(0);
  });

  it("the would-be entry must not reach the native routes table", () => {
    const app = new Keala(quiet);
    expect(() => app.sink("/a//b", new Response("x"))).toThrow(/empty segment/);
    const routes = buildNativeRoutes(app.nativeSinks);
    expect(Object.prototype.hasOwnProperty.call(routes, "/a//b")).toBe(false);
  });

  it("same stranding shape for a { dir } sink whose mirror path has an empty segment", () => {
    const app = new Keala(quiet);
    expect(() => app.sink("/d//e/*", { dir: dirRoot })).toThrow(/empty segment/);
    expect(app.nativeSinks.size).toBe(0);
  });

  it("a sink that never registered must not answer on the JS leg", async () => {
    const app = new Keala(quiet);
    expect(() => app.sink("/a//b", new Response("x"))).toThrow(/empty segment/);
    expect((await app.handle(req("/a//b"))).status).toBe(404);
    expect(app.nativeSinks.size).toBe(0);
  });

  it("a FAILED sink leaves no sunk route — app.use() stays allowed", () => {
    const app = new Keala(quiet);
    expect(() => app.sink("/a//b", new Response("x"))).toThrow(/empty segment/);
    // Nothing entered the native table, so there is no sunk route that
    // global middleware could bypass: the ordering guard must NOT fire.
    expect(() => app.use((_c, next) => next())).not.toThrow();
  });

  it("control: a SUCCESSFUL sink still arms the ordering guard", () => {
    const app = new Keala(quiet);
    app.sink("/ok", new Response("x"));
    expect(app.nativeSinks.size).toBe(1);
    expect(() => app.use((_c, next) => next())).toThrow(/alongside sunk routes/);
  });
});

describe("locks correct: {dir} sinks keep serving under app.mount()", () => {
  it("control: standalone, the dir sink mirror serves files and the index twin", async () => {
    const sub = new Keala(quiet);
    sub.sink("/assets/*", { dir: dirRoot });
    expect((await sub.handle(req("/assets/app.js"))).status).toBe(200);
    expect((await sub.handle(req("/assets"))).status).toBe(200);
  });

  it("the same sink serves under the mount prefix (mirror defs are re-keyed)", async () => {
    const sub = new Keala(quiet);
    sub.sink("/assets/*", { dir: dirRoot });
    const app = new Keala(quiet);
    app.mount("/m", sub);
    expect((await app.handle(req("/m/assets/app.js"))).status).toBe(200);
    expect((await app.handle(req("/m/assets"))).status).toBe(200);
  });

  it("control: Response and function sinks keep working across the same mount", async () => {
    const sub = new Keala(quiet);
    sub.sink("/plain", new Response("p"));
    sub.sink("/items/:id", (_request, params) => new Response(`i:${params["id"]}`));
    const app = new Keala(quiet);
    app.mount("/m", sub);
    expect(await (await app.handle(req("/m/plain"))).text()).toBe("p");
    expect(await (await app.handle(req("/m/items/7"))).text()).toBe("i:7");
  });
});
