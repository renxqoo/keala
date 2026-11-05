import { describe, expect, it } from "vitest";

import { Keala } from "../../src/index.ts";

describe("branch coverage: final round", () => {
  it("catches synchronous middleware throws without a promise", async () => {
    const app = new Keala({ env: "test" });
    app.use(() => {
      throw new Error("sync boom");
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(500);
  });

  // U3c deletion: "CONFIRMED-BUG: keeps Content-Length for HEAD with binary
  // bodies" locked the state-mode HEAD backfill for a staged binary body.
  // Return-style Responses intentionally do NOT backfill Content-Length for
  // HEAD (§2.3-3 of the native-API migration — only the sugar path computes
  // it at construction, locked in response.test.ts and app-runtime-locks).

  it("combines a 201 status with multi-value Set-Cookie headers", async () => {
    // 0.7: the c.message statusText half of the old lock is gone with the API.
    const app = new Keala();
    app.use(async (c) => {
      c.append("Set-Cookie", ["a=1; Path=/", "b=2; Path=/"]);
      return c.text("created", 201);
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(201);
    expect([...res.headers.getSetCookie()]).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });

  // U3c deletion: "exposes computed length for binary and empty bodies"
  // locked the deleted c.length computed read over a staged body.

  // 0.7 deletions: the argless acceptsCharsets/acceptsLanguages context
  // methods and the c.fresh freshness locks are gone with the APIs (parse
  // the Accept-* headers yourself; conditional.ts owns freshness).
});
