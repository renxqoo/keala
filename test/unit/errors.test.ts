import { describe, expect, it, test } from "vitest";

import { createError, isHttpError, normalizeError } from "../../src/http/errors.ts";
import { Keala } from "../../src/index.ts";

describe("createError", () => {
  it("creates an error with status, name and default expose", () => {
    const err = createError(404, "user not found");
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(404);
    expect(err.name).toBe("NotFoundError");
    expect(err.message).toBe("user not found");
    expect(err.expose).toBe(true);
  });

  it("hides 5xx messages by default", () => {
    const err = createError(500, "db exploded");
    expect(err.expose).toBe(false);
    expect(err.name).toBe("InternalServerError");
  });

  it("uses the standard reason phrase when no message given", () => {
    expect(createError(400).message).toBe("Bad Request");
    expect(createError(404).message).toBe("Not Found");
  });

  it("falls back to 500 for invalid statuses", () => {
    expect(createError(200).status).toBe(500);
    expect(createError(undefined).status).toBe(500);
    expect(createError("404").status).toBe(500);
  });

  it("accepts an existing Error as source", () => {
    const source = new Error("disk full");
    const err = createError(507, source);
    expect(err.message).toBe("disk full");
    expect(err.cause).toBe(source);
    expect(err.status).toBe(507);
  });

  it("keeps the status of a wrapped HttpError", () => {
    const source = createError(403, "denied");
    const err = createError(500, source);
    expect(err.status).toBe(403);
  });

  it("merges props and headers", () => {
    const err = createError(429, "slow down", {
      headers: { "retry-after": "30" },
      code: "RATE_LIMITED",
    });
    expect(err.headers).toEqual({ "retry-after": "30" });
    expect((err as { code?: string }).code).toBe("RATE_LIMITED");
  });

  it("supports expose override via props object", () => {
    const err = createError(500, { expose: true, message: "visible" });
    expect(err.expose).toBe(true);
    expect(err.message).toBe("visible");
  });

  it("names unusual statuses HttpError", () => {
    expect(createError(599).name).toBe("HttpError");
  });
});

describe("isHttpError", () => {
  it("recognizes only errors with a valid status", () => {
    expect(isHttpError(createError(404))).toBe(true);
    expect(isHttpError(new Error("plain"))).toBe(false);
    expect(isHttpError(null)).toBe(false);
    const fake = new Error("fake") as Error & { status: number };
    fake.status = 42;
    expect(isHttpError(fake)).toBe(false);
  });
});

describe("normalizeError", () => {
  it("wraps non-error throwables", () => {
    const wrapped = normalizeError("kaboom");
    expect(wrapped).toBeInstanceOf(Error);
    expect(wrapped.message).toBe("kaboom");
    expect(normalizeError({ deep: true }).message).toBe('{"deep":true}');
  });

  it("passes errors through", () => {
    const original = new Error("same");
    expect(normalizeError(original)).toBe(original);
  });
});

/**
 * UX review round 2 — footgun probes (read-only investigation).
 */
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
    const { createError } = await import("../../src/index.ts");
    const e = createError(200, "teapotish");
    expect([e.status, e.name, e.message]).toMatchObject({ 0: 500 });
    expect(e.name).toBe("InternalServerError");
    expect(e.message).toBe("teapotish");
  });
});
