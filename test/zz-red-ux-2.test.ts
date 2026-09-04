/**
 * UX review round 2 — footgun probes (read-only investigation).
 */
import { describe, expect, test } from "vitest";
import { Keala } from "../src/index.ts";

describe("error-creation footguns", () => {
  test("c.throw with a 1xx/2xx/3xx status throws TypeError (not a silent 500)", async () => {
    const app = new Keala({ env: "test" });
    let caught: unknown = null;
    app.get("/r", (c) => {
      try {
        c.throw(302, "see /new");
      } catch (err) {
        caught = err;
        throw err; // rethrow so the funnel path is exercised too
      }
    });
    const res = await app.handle(new Request("http://localhost/r"));
    // Expected behavior (UX-7): a 3xx is not an error status — c.throw must
    // fail loud at the call site and point at c.redirect / returning a
    // Response. Previously this silently answered a plain 500.
    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as TypeError).message).toContain("c.redirect");
    expect(res.status).toBe(500); // the TypeError itself rides the funnel
  });

  test("createError(204) name/message shape", async () => {
    const { createError } = await import("../src/index.ts");
    const e = createError(200, "teapotish");
    expect([e.status, e.name, e.message]).toMatchObject({ 0: 500 });
    expect(e.name).toBe("InternalServerError");
    expect(e.message).toBe("teapotish");
  });
});
