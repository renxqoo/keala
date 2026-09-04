/**
 * agent-r8 — full-project review round (four parallel reviewers, red-test
 * confirmation, fixes in the same commit). Each lock names the defect it
 * guards against; see the review report in the commit message.
 */

import { describe, expect, it } from "vitest";

import { Keala } from "../src/core/app.ts";
import { Router } from "../src/index.ts";

const quiet = { env: "test" } as const;

describe("r8 (0.7): a post-commit body rewrite throws — the committed body ships verbatim", () => {
  it("a string body write after a commit is a TypeError, wire stays in sync", async () => {
    const app = new Keala(quiet);
    const thrown: unknown[] = [];
    app.use(async (c, next) => {
      await next();
      try {
        c.body = "a much longer body";
      } catch (error) {
        thrown.push(error);
      }
    });
    // A committed Response carrying its own Content-Length (e.g. an upstream
    // fetch() response).
    app.get("/a", () => new Response("hi", { headers: { "content-length": "2" } }));
    const res = await app.handle(new Request("http://localhost:3000/a"));
    expect(thrown[0]).toBeInstanceOf(TypeError);
    // The invariant from the r8 review (never a stale length) now holds by
    // construction: the body is never replaced, so length and payload cannot
    // desync.
    expect(await res.text()).toBe("hi");
    expect(res.headers.get("content-length")).toBe("2");
  });

  it("a stream body write after a commit is a TypeError too", async () => {
    const app = new Keala(quiet);
    const thrown: unknown[] = [];
    app.use(async (c, next) => {
      await next();
      try {
        c.body = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("a much longer streamed body"));
            controller.close();
          },
        });
      } catch (error) {
        thrown.push(error);
      }
    });
    app.get("/a", () => new Response("hi", { headers: { "content-length": "2" } }));
    const res = await app.handle(new Request("http://localhost:3000/a"));
    expect(thrown[0]).toBeInstanceOf(TypeError);
    expect(await res.text()).toBe("hi");
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
