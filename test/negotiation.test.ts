import { describe, expect, it } from "vitest";

import {
  acceptableValues,
  acceptsCharset,
  acceptsEncoding,
  acceptsLanguage,
  acceptsType,
  parsePreferences,
  pickPreference,
} from "../src/negotiation/accepts.ts";

describe("parsePreferences", () => {
  it("orders by q-value and original order", () => {
    const prefs = parsePreferences("text/html;q=0.5, application/json, text/plain;q=0.9");
    expect(prefs.map((p) => p.value)).toEqual(["application/json", "text/plain", "text/html"]);
  });

  it("drops q=0 entries and clamps q to [0,1]", () => {
    const prefs = parsePreferences("gzip;q=0, br;q=9, deflate;q=-1, identity");
    expect(prefs.map((p) => p.value)).toEqual(["br", "identity"]);
    expect(prefs.map((p) => p.q)).toEqual([1, 1]);
  });

  it("handles quoted strings with commas", () => {
    const prefs = parsePreferences('a;q=1, "b,c";q=0.5, d');
    expect(prefs.map((p) => p.value)).toEqual(["a", "d", '"b,c"']);
  });

  it("returns empty for missing headers", () => {
    expect(parsePreferences(null)).toEqual([]);
    expect(parsePreferences("")).toEqual([]);
  });
});

describe("acceptsType", () => {
  it("picks exact match", () => {
    expect(acceptsType("text/html,application/xhtml+xml", ["application/json", "text/html"])).toBe(
      "text/html",
    );
  });

  it("falls back through subtype wildcards", () => {
    expect(acceptsType("text/*,application/json", ["application/xml", "application/json"])).toBe(
      "application/json",
    );
    expect(acceptsType("text/*", ["application/json", "text/html"])).toBe("text/html");
  });

  it("global wildcard matches anything", () => {
    expect(acceptsType("*/*", ["application/json"])).toBe("application/json");
    expect(acceptsType("*", ["application/json"])).toBe("application/json");
  });

  it("respects q-values", () => {
    expect(
      acceptsType("application/json;q=0.8, text/html;q=0.9", ["text/html", "application/json"]),
    ).toBe("text/html");
    expect(
      acceptsType("application/json;q=0.9, text/html;q=0.8", ["text/html", "application/json"]),
    ).toBe("application/json");
  });

  it("returns false when nothing matches", () => {
    expect(acceptsType("application/json", ["text/html"])).toBe(false);
  });

  it("returns first provided when header missing", () => {
    expect(acceptsType(null, ["text/html", "application/json"])).toBe("text/html");
  });
});

describe("acceptsEncoding / acceptsCharset / acceptsLanguage", () => {
  it("encoding negotiation", () => {
    expect(acceptsEncoding("gzip, compress;q=0.5, br;q=0", ["gzip", "br", "identity"])).toBe(
      "gzip",
    );
    expect(acceptsEncoding("br;q=0, gzip", ["gzip", "br"])).toBe("gzip");
    expect(acceptsEncoding(null, ["gzip", "br"])).toBe("gzip");
  });

  it("charset negotiation", () => {
    expect(acceptsCharset("utf-8, iso-8859-1;q=0.5", ["utf-8", "iso-8859-1"])).toBe("utf-8");
  });

  it("language prefix matching", () => {
    // negotiator: "en"'s quality is 0.8 (its exact range beats the en-GB
    // prefix), "zh" carries zh-CN's 0.9 — zh wins.
    expect(acceptsLanguage("en-GB,en;q=0.8,zh-CN;q=0.9", ["zh", "en", "fr"])).toBe("zh");
    expect(acceptsLanguage("zh-CN;q=1, en-GB;q=0.5", ["zh", "en"])).toBe("zh");
    expect(acceptsLanguage("en;q=0.5, zh", ["en", "zh"])).toBe("zh");
  });
});

describe("acceptableValues", () => {
  it("lists client preferences best-first", () => {
    expect(acceptableValues("text/html;q=0.4, application/json")).toEqual([
      "application/json",
      "text/html",
    ]);
  });
});

describe("pickPreference", () => {
  it("returns false when provided list empty", () => {
    expect(
      pickPreference({ header: "text/html", provided: [], normalize: (v) => v, score: () => 0 }),
    ).toBe(false);
  });
});
