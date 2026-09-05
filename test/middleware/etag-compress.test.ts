/**
 * Middleware kit tests: secureHeaders, requestId, timing, logger, cors, csrf,
 * etag, compress, bodyLimit, timeout and the html escape protocol.
 */

import { describe, expect, it } from "vitest";

import { Keala } from "../../src/core/app.ts";
import { etag, compress } from "../../src/middleware/etag.ts";

const quiet = { env: "test" } as const;
const req = (path: string, init?: RequestInit) => new Request(`http://localhost:3000${path}`, init);

describe("etag + compress", () => {
  it("tags sugar bodies weakly and answers 304 on If-None-Match", async () => {
    const app = new Keala(quiet);
    app.use(etag());
    app.get("/x", (c) => {
      // U3c: etag transforms sugar products post-next (§2.3-5); hand-built
      // Responses pass through — see compress.test.ts for that gate.
      return c.text("stable-body");
    });
    const first = await app.handle(req("/x"));
    const tag = first.headers.get("etag");
    expect(tag).toMatch(/^W\//);
    const second = await app.handle(
      new Request("http://localhost:3000/x", { headers: { "if-none-match": tag ?? "" } }),
    );
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
  });

  it("compress skips tiny bodies but still varies", async () => {
    const app = new Keala(quiet);
    app.use(compress());
    app.get("/x", (c) => {
      return c.text("tiny");
    });
    const res = await app.handle(
      new Request("http://localhost:3000/x", { headers: { "accept-encoding": "gzip" } }),
    );
    expect(res.headers.get("vary")).toContain("Accept-Encoding");
    expect(res.headers.get("content-encoding")).toBeNull();
  });

  // U3c adversarial review: the middleware ORDER must not decide whether the
  // validator exists — in BOTH orders the tag is the PRE-COMPRESSION
  // representation's (what clients compare If-None-Match against) and a
  // gzip'd answer still negotiates to 304.
  it.each([
    [
      "etag outer",
      (a: Keala) => {
        a.use(etag());
        a.use(compress());
      },
    ],
    [
      "compress outer",
      (a: Keala) => {
        a.use(compress());
        a.use(etag());
      },
    ],
  ])(
    "%s: the tag covers the original representation and gzip'd answers 304",
    async (_label, wire) => {
      const payload = "hello world ".repeat(50);
      const identity = new Keala(quiet);
      identity.use(etag());
      identity.get("/x", (c) => c.text(payload));
      const plain = await identity.handle(new Request("http://localhost:3000/x"));

      const app = new Keala(quiet);
      wire(app);
      app.get("/x", (c) => c.text(payload));
      const gz = await app.handle(
        new Request("http://localhost:3000/x", { headers: { "accept-encoding": "gzip" } }),
      );
      expect(gz.headers.get("content-encoding")).toBe("gzip");
      expect(gz.headers.get("etag")).toBe(plain.headers.get("etag"));

      const notModified = await app.handle(
        new Request("http://localhost:3000/x", {
          headers: { "accept-encoding": "gzip", "if-none-match": plain.headers.get("etag") ?? "" },
        }),
      );
      expect(notModified.status).toBe(304);
      expect(notModified.headers.get("content-encoding")).toBeNull();
    },
  );

  it("HEAD answers carry the same validator and negotiate to 304", async () => {
    // U3c adversarial review: the sugar HEAD view is branded + payload
    // memoized, so etag() works on HEAD exactly like GET.
    const app = new Keala(quiet);
    app.use(etag());
    app.get("/x", (c) => c.text("stable payload"));
    const get = await app.handle(new Request("http://localhost:3000/x"));
    const head = await app.handle(new Request("http://localhost:3000/x", { method: "HEAD" }));
    expect(head.headers.get("etag")).toBe(get.headers.get("etag"));
    expect(await head.text()).toBe("");
    const notModified = await app.handle(
      new Request("http://localhost:3000/x", {
        method: "HEAD",
        headers: { "if-none-match": get.headers.get("etag") ?? "" },
      }),
    );
    expect(notModified.status).toBe(304);
  });

  it("HEAD json answers negotiate too", async () => {
    const app = new Keala(quiet);
    app.use(etag());
    app.get("/j", (c) => c.json({ a: 1 }));
    const get = await app.handle(new Request("http://localhost:3000/j"));
    const head = await app.handle(
      new Request("http://localhost:3000/j", {
        method: "HEAD",
        headers: { "if-none-match": get.headers.get("etag") ?? "" },
      }),
    );
    expect(head.status).toBe(304);
  });
});
