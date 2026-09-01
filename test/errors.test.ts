import { describe, expect, it } from "vitest";

import { createError, isHttpError, normalizeError } from "../src/http/errors.ts";

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
