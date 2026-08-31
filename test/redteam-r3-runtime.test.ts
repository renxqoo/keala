/**
 * Red-team audit R3 — runtime layer (adapters, websocket bridge, native sink,
 * streaming, status/error surfaces).
 *
 * Every `it` below asserts the CORRECT behavior and FAILS against the current
 * implementation (assertion-style red — nothing is skipped). File:line and
 * root cause per finding:
 *
 *   RT3-01 HIGH  src/middleware/serve-static.ts:151-165 (reached through
 *        src/core/sink.ts:121-133 dir-sink mirror). The symlink-denial lstat
 *        walk iterates `absolute`'s components, but the directory-index branch
 *        re-resolves `filePath = resolve(absolute, indexName)` — the index
 *        file itself is never lstat'd. A REAL directory whose index.html is a
 *        symlink pointing outside root is served with 200 when the DIRECTORY
 *        path is requested (the direct file path is correctly 403).
 *
 *   RT3-02 HIGH  src/core/app.ts:281-288 guards `app.ws()` against
 *        `pooling: true`, but src/core/dispatch.ts:77-105 (mergeMountedWs)
 *        never re-checks the PARENT app's pooling when a ws-bearing sub-app
 *        is mounted. The socket then holds a context that the pool recycles
 *        for the next request — ws handlers read another request's
 *        path/url/headers (cross-request disclosure).
 *
 *   RT3-03 MED   src/adapters/bun.ts:101-107. The ws dispatch wrapper routes
 *        handler rejections to `app.onerror(...)` inside a `.catch()` — but an
 *        error LISTENER that throws (or onAppError's non-Error TypeError) makes
 *        that catch-callback itself reject: an unhandledRejection, the exact
 *        process-killer the wrapper exists to prevent (defaultServeError at
 *        bun.ts:35-45 guards the same call — dispatch does not).
 *
 *   RT3-04 MED   src/adapters/bun.ts:85-134 + src/core/app.ts:281-309.
 *        `websocket` handlers are embedded in the serve options only when
 *        wsRoutes is non-empty AT LISTEN TIME; `app.ws()` after `listen()`
 *        neither throws nor reloads — under Bun the route answers 400 forever
 *        (server.upgrade fails without websocket handlers). A silently dead
 *        route violates the framework's loud-refusal contract.
 *
 *   RT3-05 MED   src/adapters/node.ts:71-79. `OPTIONS * HTTP/1.1` (legal
 *        request-target per RFC 7231 §4.3.7) is bridged to the URL
 *        `http://<host>*`, `new Request` throws, and the client gets a 500.
 *
 *   RT3-06 LOW   src/http/errors.ts:113-118. The message fallback chain ends
 *        with `statusMessage(resolvedStatus) ?? String(resolvedStatus)` —
 *        statusMessage() returns "" (never nullish) for valid-but-unnamed
 *        statuses (419/420/427/430/432-450/452-498/509…), so `??` is dead:
 *        createError(420).message is "" and the error response carries an
 *        empty body (http-errors parity: `String(status)`).
 *
 *   RT3-07 LOW   src/core/sink.ts:84-92 accepts any Response instance. The
 *        native routing table REUSES the instance across requests, so a
 *        one-shot body (ReadableStream) or an already-disturbed body cannot
 *        be replayed: the mirror 500s on every request (disturbed) and the
 *        native table diverges after the first hit (stream). The module's own
 *        contract ("anything that needs per-request JS refuses to sink
 *        instead of silently diverging") demands a loud registration refusal.
 */

import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp, type Application } from "../src/core/app.ts";
import { startBunServer, type ServeImplementation } from "../src/adapters/bun.ts";
import { listen, type NodeServerHandle } from "../src/adapters/node.ts";
import { createError } from "../src/http/errors.ts";

const quiet = { env: "test", silent: true } as const;
const req = (path: string, init: RequestInit = {}): Request =>
  new Request(`http://localhost:3000${path}`, init);

// ---------------------------------------------------------------------------
// RT3-01 fixtures: a real directory whose index.html escapes the root
// ---------------------------------------------------------------------------

let root = "";
let outside = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "bk-rt-r3-"));
  outside = await mkdtemp(join(tmpdir(), "bk-rt-r3-out-"));
  await writeFile(join(outside, "secret.txt"), "TOP SECRET OUTSIDE ROOT");
  await mkdir(join(root, "subdir"));
  await symlink(join(outside, "secret.txt"), join(root, "subdir", "index.html"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// RT3-01 — symlink denial bypass via the directory-index resolution path
// ---------------------------------------------------------------------------

describe("RT3-01: serveStatic directory-index path skips the symlink walk", () => {
  it("a symlinked index.html reached through its DIRECTORY path must be denied like the direct file path", async () => {
    const app = createApp(quiet);
    app.sink("/assets/*", { dir: root });

    // Control: the direct file path is (correctly) refused today.
    const direct = await app.handle(req("/assets/subdir/index.html"));
    expect(direct.status).toBe(403);

    // Bug: requesting the directory (no trailing filename) resolves
    // subdir/index.html, and the lstat walk only covers `absolute`
    // (the directory), never the resolved index file.
    const viaDir = await app.handle(req("/assets/subdir"));
    expect(viaDir.status).toBe(403);
    const viaDirSlash = await app.handle(req("/assets/subdir/"));
    expect(viaDirSlash.status).toBe(403);
    expect(await viaDir.text()).not.toContain("TOP SECRET");
  });
});

// ---------------------------------------------------------------------------
// RT3-02 — mount() bypasses the ws × pooling guard (context recycling leak)
// ---------------------------------------------------------------------------

describe("RT3-02: mount() must refuse ws registrations under a pooling parent", () => {
  it("mounting a ws-bearing sub-app into pooling:true must fail loudly (same guard as app.ws)", () => {
    const parent = createApp({ ...quiet, pooling: true });
    const sub = createApp(quiet);
    sub.ws("/ws", { open: () => undefined });
    expect(() => parent.mount("/sub", sub)).toThrow(/pooling/);
  });

  it("a socket-retained context must never be recycled under another request", async () => {
    // Contract chosen for the fix: the mount is REFUSED (see the previous
    // it), so no ws route exists — the upgrade can never run, no context is
    // ever retained by a socket, and the next request answers normally.
    const parent = createApp({ ...quiet, pooling: true });
    parent.get("/second", (c) => {
      c.body = "second";
    });
    const sub = createApp(quiet);
    sub.ws("/ws", { open: () => undefined });
    expect(() => parent.mount("/sub", sub)).toThrow(/pooling/);

    const upgrades: { data: { ctx: { path: string; url: string } } }[] = [];
    const fakeServer = {
      upgrade(_request: Request, opts: { data: unknown }): boolean {
        upgrades.push(opts as { data: { ctx: { path: string; url: string } } });
        return true;
      },
    };
    const viaWs = await parent.handle(req("/sub/ws"), { server: fakeServer });
    expect(viaWs.status).toBe(404); // the refused mount registered nothing
    expect(upgrades).toEqual([]); // no upgrade was ever attempted

    // And the next request through the pool is untouched by the attempt.
    const second = await parent.handle(req("/second"));
    expect(second.status).toBe(200);
    expect(await second.text()).toBe("second");
  });
});

// ---------------------------------------------------------------------------
// RT3-03 — throwing error listener escapes the ws dispatch containment
// ---------------------------------------------------------------------------

describe("RT3-03: ws dispatch containment must survive a throwing error listener", () => {
  it("a failing ws handler + a throwing app.onError listener must not fire unhandledRejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    (process.on as (event: string, fn: (reason: unknown) => void) => void)(
      "unhandledRejection",
      onUnhandled,
    );
    try {
      const app = createApp(quiet);
      app.onError(() => {
        throw new Error("listener-exploded");
      });
      app.ws("/ws", {
        open: () => {
          throw new Error("ws-open-boom");
        },
      });
      let captured: Record<string, unknown> = {};
      const impl: ServeImplementation = (options) => {
        captured = options;
        return {
          port: 0,
          hostname: "localhost",
          stop: () => undefined,
          fetch: () => new Response("fake"),
          reload: () => undefined,
        };
      };
      startBunServer(app as Application, { port: 0 }, undefined, impl);
      const handlers = captured["websocket"] as Record<
        string,
        (ws: unknown, ...rest: unknown[]) => void
      >;
      handlers["open"]?.({ data: { wsKey: "/ws", ctx: { path: "/ws" } } });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(unhandled).toEqual([]);
    } finally {
      (process.off as (event: string, fn: (reason: unknown) => void) => void)(
        "unhandledRejection",
        onUnhandled,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// RT3-04 — app.ws() after listen() is silently dead
// ---------------------------------------------------------------------------

describe("RT3-04: registering a ws route after listen() must be loud or wired", () => {
  it("late app.ws() must either throw or reach the running server's websocket handlers", () => {
    const app = createApp(quiet);
    const reloads: Record<string, unknown>[] = [];
    let captured: Record<string, unknown> = {};
    const impl: ServeImplementation = () => ({
      port: 0,
      hostname: "localhost",
      stop: () => undefined,
      fetch: () => new Response("fake"),
      reload: (options) => reloads.push(options),
    });
    startBunServer(app as Application, { port: 0 }, undefined, (options) => {
      captured = options;
      return impl(options);
    });

    let refused = false;
    try {
      app.ws("/late", { open: () => undefined });
    } catch {
      refused = true;
    }
    const wired =
      captured["websocket"] !== undefined ||
      reloads.some((options) => options["websocket"] !== undefined);
    // Today: no refusal, no wiring — the route answers 400 forever under Bun.
    expect(refused || wired).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// RT3-05 — OPTIONS * under the Node adapter answers 500
// ---------------------------------------------------------------------------

describe("RT3-05: the Node adapter must not 500 a legal OPTIONS * request", () => {
  const servers: NodeServerHandle[] = [];
  afterAll(() => {
    for (const server of servers) server.stop(true);
  });

  it("OPTIONS * answers a non-5xx status (RFC 7231 §4.3.7 request-target)", async () => {
    const app = createApp(quiet);
    app.get("/x", (c) => {
      c.body = "ok";
    });
    const server = await listen(app, 0, "127.0.0.1").ready();
    servers.push(server);
    const statusLine = await new Promise<string>((resolve, reject) => {
      let data = "";
      const socket = connect({ host: "127.0.0.1", port: server.port }, () => {
        socket.write(
          `OPTIONS * HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nConnection: close\r\n\r\n`,
        );
      });
      socket.on("data", (chunk: Buffer) => {
        data += chunk.toString();
      });
      socket.on("close", () => resolve(data.split("\r\n")[0] ?? ""));
      socket.on("error", reject);
    });
    const status = Number.parseInt(statusLine.split(" ")[1] ?? "0", 10);
    expect(Number.isFinite(status)).toBe(true);
    expect(status).toBeLessThan(500);
  });
});

// ---------------------------------------------------------------------------
// RT3-06 — createError falls back to an EMPTY message for unnamed statuses
// ---------------------------------------------------------------------------

describe("RT3-06: createError must not produce an empty message for unnamed statuses", () => {
  it('createError(420).message falls back to String(status), not ""', () => {
    const error = createError(420);
    expect(error.status).toBe(420);
    expect(error.message.length).toBeGreaterThan(0);
    expect(error.message).toContain("420");
  });

  it("an error response for an unnamed status carries a non-empty body", async () => {
    const app = createApp(quiet);
    app.get("/t", () => {
      throw createError(420);
    });
    const res = await app.handle(req("/t"));
    expect(res.status).toBe(420);
    expect((await res.text()).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// RT3-07 — sink accepts unreplayable Response bodies
// ---------------------------------------------------------------------------

describe("RT3-07: sink must refuse bodies the native table cannot replay", () => {
  it("an unconsumed stream-bodied Response sinks and serves REPEATEDLY (mirror replay)", async () => {
    // Every fetch body — string or stream — surfaces as a ReadableStream, so
    // the body's TYPE proves nothing. The provable contract: unconsumed
    // bodies sink (the mirror snapshots through a clone and rebuilds per
    // hit — no per-request 500, no divergence between hits).
    const app = createApp(quiet);
    const oneShot = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("once upon every hit"));
          controller.close();
        },
      }),
    );
    app.sink("/one-shot", oneShot);
    for (let i = 0; i < 3; i++) {
      const res = await app.handle(req("/one-shot"));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("once upon every hit");
    }
    // The original instance stays untouched for the native table.
    expect(oneShot.bodyUsed).toBe(false);
  });

  it("an already-consumed Response is refused at registration (not a per-request 500)", async () => {
    const app = createApp(quiet);
    const consumed = new Response("x");
    await consumed.text();
    expect(() => app.sink("/dead", consumed)).toThrow();
  });
});
