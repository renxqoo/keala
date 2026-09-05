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
  it("tags state bodies weakly and answers 304 on If-None-Match", async () => {
    const app = new Keala(quiet);
    app.use(etag());
    app.get("/x", (c) => {
      c.body = "stable-body";
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
      c.body = "tiny";
    });
    const res = await app.handle(
      new Request("http://localhost:3000/x", { headers: { "accept-encoding": "gzip" } }),
    );
    expect(res.headers.get("vary")).toContain("Accept-Encoding");
    expect(res.headers.get("content-encoding")).toBeNull();
  });
});
