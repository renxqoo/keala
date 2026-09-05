import { describe, expect, it } from "vitest";

import {
  isEmptyStatus,
  isRedirectStatus,
  isValidErrorStatus,
  statusMessage,
} from "../../src/http/status.ts";

describe("status helpers", () => {
  it("maps known codes to reason phrases", () => {
    expect(statusMessage(200)).toBe("OK");
    expect(statusMessage(404)).toBe("Not Found");
    expect(statusMessage(418)).toBe("I'm a teapot");
    expect(statusMessage(503)).toBe("Service Unavailable");
  });

  it("returns empty string for unknown codes", () => {
    expect(statusMessage(599)).toBe("");
    expect(statusMessage(0)).toBe("");
  });

  it("classifies empty-body statuses", () => {
    expect(isEmptyStatus(204)).toBe(true);
    expect(isEmptyStatus(205)).toBe(true);
    expect(isEmptyStatus(304)).toBe(true);
    expect(isEmptyStatus(200)).toBe(false);
    expect(isEmptyStatus(404)).toBe(false);
  });

  it("classifies redirect statuses", () => {
    expect(isRedirectStatus(301)).toBe(true);
    expect(isRedirectStatus(302)).toBe(true);
    expect(isRedirectStatus(308)).toBe(true);
    expect(isRedirectStatus(200)).toBe(false);
    expect(isRedirectStatus(400)).toBe(false);
  });

  it("validates error statuses", () => {
    expect(isValidErrorStatus(400)).toBe(true);
    expect(isValidErrorStatus(599)).toBe(true);
    expect(isValidErrorStatus(399)).toBe(false);
    expect(isValidErrorStatus(600)).toBe(false);
    expect(isValidErrorStatus(404.5)).toBe(false);
  });
});
