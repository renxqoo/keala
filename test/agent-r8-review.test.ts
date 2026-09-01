/**
 * agent-r8 — full-project review round (four parallel reviewers, red-test
 * confirmation, fixes in the same commit). Each lock names the defect it
 * guards against; see the review report in the commit message.
 */

import { describe, expect, it } from "vitest";

import { Keala } from "../src/core/app.ts";
import { Router } from "../src/index.ts";

const quiet = { env: "test" } as const;

describe("r8: post-commit body rewrite never ships the stale committed length", () => {
  it("a replaced string body drops the committed content-length (wire desync)", async () => {
    const app = new Keala(quiet);
    app.use(async (c, next) => {
      await next();
      c.body = "a much longer body";
    });
    // A committed Response carrying its own Content-Length (e.g. an upstream
    // fetch() response).
    app.get("/a", () => new Response("hi", { headers: { "content-length": "2" } }));
    const res = await app.handle(new Request("http://localhost:3000/a"));
    const text = await res.text();
    expect(text).toBe("a much longer body");
    // The invariant: NEVER the stale committed length. Runtimes do not
    // backfill content-length on constructed Responses — the wire length is
    // computed at send time, which is exactly what a replaced body needs.
    expect(res.headers.get("content-length")).not.toBe("2");
  });

  it("a replaced stream body keeps no content-length either", async () => {
    const app = new Keala(quiet);
    app.use(async (c, next) => {
      await next();
      c.body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("a much longer streamed body"));
          controller.close();
        },
      });
    });
    app.get("/a", () => new Response("hi", { headers: { "content-length": "2" } }));
    const res = await app.handle(new Request("http://localhost:3000/a"));
    expect(res.headers.get("content-length")).not.toBe("2");
    expect(await res.text()).toBe("a much longer streamed body");
  });
});

describe("r8: failed ws registration leaves no stranded wsRoutes key", () => {
  it("a throwing app.ws() (sunk overlap) does not occupy the key", () => {
    const app = new Keala(quiet);
    app.sink("/static/*", { dir: "/tmp" });
    expect(() => app.ws("/static/x", { open() {} })).toThrow();
    expect(app.wsRoutes.has("/static/x")).toBe(false);
  });

  it("a throwing ws mount does not occupy the key either", () => {
    const app = new Keala(quiet);
    app.sink("/static/*", { dir: "/tmp" });
    const sub = new Keala(quiet);
    sub.ws("/", { open() {} });
    expect(() => app.mount("/static", sub)).toThrow();
    expect(app.wsRoutes.has("/static")).toBe(false);
  });
});

describe("r8: Router identity prefix", () => {
  it('prefix: "/" is the identity mount, not a broken "//path" factory', async () => {
    const app = new Keala(quiet);
    const r = new Router({ prefix: "/" });
    r.get("/x", (c) => {
      c.body = "ok";
    });
    app.mount("/", r);
    const res = await app.handle(new Request("http://localhost:3000/x"));
    expect([res.status, await res.text()]).toEqual([200, "ok"]);
  });
});
