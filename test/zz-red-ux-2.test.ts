/**
 * UX review round 2 — footgun probes (read-only investigation).
 */
import { describe, expect, test } from "vitest";
import { Keala } from "../src/index.ts";

describe("error-creation footguns", () => {
  test("c.throw with a non-error status silently becomes 500", async () => {
    const app = new Keala({ env: "test" });
    app.get("/r", (c) => {
      c.throw(302, "see /new");
    });
    const res = await app.handle(new Request("http://localhost/r"));
    // Expected by the user: a redirect. Actual?
    expect([res.status, res.headers.get("location")]).toEqual([500, null]);
  });

  test("createError(204) name/message shape", async () => {
    const { createError } = await import("../src/index.ts");
    const e = createError(200, "teapotish");
    expect([e.status, e.name, e.message]).toMatchObject({ 0: 500 });
    expect(e.name).toBe("InternalServerError");
    expect(e.message).toBe("teapotish");
  });
});
