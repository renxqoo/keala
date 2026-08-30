import { describe, expect, it } from "vitest";

import { typeIs } from "../src/negotiation/typeis.ts";

describe("typeIs", () => {
  it("returns null without a content type", () => {
    expect(typeIs(null, ["json"])).toBe(null);
    expect(typeIs(null, [])).toBe(null);
    expect(typeIs("", [])).toBe(null);
  });

  it("returns the normalized incoming type with no arguments", () => {
    expect(typeIs("application/json; charset=utf-8", [])).toBe("application/json");
  });

  it("matches exact types", () => {
    expect(typeIs("application/json", ["json", "html"])).toBe("json");
    expect(typeIs("text/html", ["application/json", "text/html"])).toBe("text/html");
  });

  it("expands shorthands", () => {
    expect(typeIs("application/x-www-form-urlencoded", ["urlencoded"])).toBe("urlencoded");
    expect(typeIs("multipart/form-data; boundary=x", ["multipart"])).toBe("multipart");
    expect(typeIs("text/html", ["html"])).toBe("html");
  });

  it("matches json suffix types", () => {
    expect(typeIs("application/vnd.api+json", ["json"])).toBe("json");
    expect(typeIs("application/hal+json", ["application/json"])).toBe("application/json");
  });

  it("matches xml suffix types", () => {
    expect(typeIs("application/atom+xml", ["xml"])).toBe("xml");
    expect(typeIs("text/xml", ["xml"])).toBe("xml");
  });

  it("matches wildcard providers", () => {
    expect(typeIs("image/png", ["image/*"])).toBe("image/*");
    expect(typeIs("image/png", ["*"])).toBe("image/png");
    expect(typeIs("image/png", ["any"])).toBe("image/png");
  });

  it("returns false on mismatch", () => {
    expect(typeIs("text/plain", ["json", "html"])).toBe(false);
    expect(typeIs("image/png", ["image/*", "text/*"]) === "text/*").toBe(false);
  });

  it("checks body presence style", () => {
    expect(typeIs("text/plain", ["text/*"])).toBe("text/*");
    expect(typeIs("text/plain", ["application/*"])).toBe(false);
  });
});
