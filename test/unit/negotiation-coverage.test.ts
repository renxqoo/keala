import { describe, expect, it } from "vitest";

import { acceptsEncoding, acceptsType } from "../../src/negotiation/accepts.ts";
import { toURL } from "../../src/utils/url.ts";

// 0.7: the "branch coverage: freshness" suite is gone — c.fresh (the
// request.ts private copy) was deleted; conditional.ts owns the single
// freshness implementation now.

describe("branch coverage: negotiation corners", () => {
  it("skips non-matching subtype wildcards", () => {
    expect(acceptsType("audio/*", ["application/json", "text/html"])).toBe(false);
    expect(acceptsType("application/*, text/*;q=0.5", ["text/plain", "application/json"])).toBe(
      "application/json",
    );
  });

  it("respects identity and wildcard encodings/charsets", () => {
    expect(acceptsEncoding("gzip;q=0", ["gzip", "identity"])).toBe("identity");
  });
});

describe("branch coverage: mime and url helpers", () => {
  it("toURL handles invalid input", () => {
    expect(toURL("http://localhost:3000/a")?.pathname).toBe("/a");
    expect(toURL("::definitely not a url::")).toBe(null);
  });
});
