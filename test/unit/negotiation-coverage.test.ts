import { describe, expect, it } from "vitest";

import { Keala } from "../../src/index.ts";
import type { Context } from "../../src/core/context/context.ts";
import {
  acceptsCharset,
  acceptsEncoding,
  acceptsLanguage,
  acceptsType,
} from "../../src/negotiation/accepts.ts";
import { charsetFromContentType, extensionFromMime } from "../../src/utils/mime.ts";
import { toURL } from "../../src/utils/url.ts";

const probe = async (
  url: string,
  headers: Record<string, string>,
  proxy = false,
): Promise<Context> => {
  const app = new Keala({ proxy });
  let captured: Context | undefined;
  app.use(async (c) => {
    captured = c;
    return c.text("probed");
  });
  await app.handle(new Request(url, { headers }));
  if (captured === undefined) throw new Error("probe did not run");
  return captured;
};

describe("branch coverage: protocol and proxy", () => {
  it("takes the first x-forwarded-proto token", async () => {
    const ctx = await probe("http://localhost/", { "X-Forwarded-Proto": "https, http" }, true);
    expect(ctx.protocol).toBe("https");
  });

  it("falls back to the URL scheme when the forwarded proto is empty", async () => {
    const ctx = await probe("http://localhost/", { "X-Forwarded-Proto": "" }, true);
    expect(ctx.protocol).toBe("http");
    const secure = await probe("https://localhost/", {});
    expect(secure.protocol).toBe("https");
    expect(secure.secure).toBe(true);
  });

  it("treats protocol-relative URLs as http", async () => {
    const ctx = await probe("http://localhost/", {});
    expect(ctx.protocol).toBe("http");
  });
});

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

  it("matches language ranges in both prefix directions", () => {
    expect(acceptsLanguage("zh-CN", ["zh", "en"])).toBe("zh");
    expect(acceptsLanguage("zh", ["zh-CN", "en"])).toBe("zh-CN");
    expect(acceptsLanguage("fr", ["zh", "en"])).toBe(false);
  });

  it("respects identity and wildcard encodings/charsets", () => {
    expect(acceptsEncoding("gzip;q=0", ["gzip", "identity"])).toBe("identity");
    expect(acceptsCharset("*", ["utf-8", "ascii"])).toBe("utf-8");
    expect(acceptsCharset("utf-16", ["utf-8"])).toBe(false);
  });
});

describe("branch coverage: mime and url helpers", () => {
  it("parses single-quoted charsets and misses gracefully", () => {
    expect(charsetFromContentType("text/html; charset='iso-8859-5'")).toBe("iso-8859-5");
    expect(charsetFromContentType("text/html; charset=")).toBe("");
    expect(extensionFromMime("application/x-unknown")).toBe(null);
  });

  it("toURL handles invalid input", () => {
    expect(toURL("http://localhost:3000/a")?.pathname).toBe("/a");
    expect(toURL("::definitely not a url::")).toBe(null);
  });
});
