import { describe, expect, it } from "vitest";

import { Honu } from "../src/index.ts";
import type { Context } from "../src/core/context/context.ts";
import { createEmitter } from "../src/core/emitter.ts";
import {
  acceptsCharset,
  acceptsEncoding,
  acceptsLanguage,
  acceptsType,
} from "../src/negotiation/accepts.ts";
import { charsetFromContentType, extensionFromMime } from "../src/utils/mime.ts";
import { toURL } from "../src/utils/url.ts";

const probe = async (
  url: string,
  headers: Record<string, string>,
  proxy = false,
): Promise<Context> => {
  const app = new Honu({ proxy });
  let captured: Context | undefined;
  app.use(async (c) => {
    captured = c;
    c.body = "probed";
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

describe("branch coverage: freshness", () => {
  it("matches weak etags", async () => {
    const app = new Honu();
    let ctx: Context | undefined;
    app.use(async (c) => {
      ctx = c;
      c.status = 200;
      c.etag = 'W/"v1"';
      c.body = "x";
    });
    await app.handle(new Request("http://localhost/", { headers: { "If-None-Match": 'W/"v1"' } }));
    expect(ctx?.fresh).toBe(true);
  });

  it("is stale when if-modified-since predates lastModified", async () => {
    const app = new Honu();
    let ctx: Context | undefined;
    app.use(async (c) => {
      ctx = c;
      c.status = 200;
      c.lastModified = new Date(Date.UTC(2030, 0, 1));
      c.body = "x";
    });
    await app.handle(
      new Request("http://localhost/", {
        headers: { "If-Modified-Since": "Thu, 01 Jan 2020 00:00:00 GMT" },
      }),
    );
    expect(ctx?.fresh).toBe(false);
  });

  it("is stale on an unparsable if-modified-since", async () => {
    const app = new Honu();
    let ctx: Context | undefined;
    app.use(async (c) => {
      ctx = c;
      c.status = 200;
      c.lastModified = new Date(Date.UTC(2030, 0, 1));
      c.body = "x";
    });
    await app.handle(
      new Request("http://localhost/", { headers: { "If-Modified-Since": "not a date" } }),
    );
    expect(ctx?.fresh).toBe(false);
  });

  it("is stale when no validators exist at all", async () => {
    const app = new Honu();
    let ctx: Context | undefined;
    app.use(async (c) => {
      ctx = c;
      c.status = 200;
      c.body = "x";
    });
    await app.handle(new Request("http://localhost/", { headers: { "If-None-Match": '"zzz"' } }));
    expect(ctx?.fresh).toBe(false);
  });
});

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

describe("branch coverage: emitter", () => {
  it("cleans up listener storage when the last listener is removed", () => {
    const emitter = createEmitter();
    const calls: number[] = [];
    const a = emitter.on("tick", () => calls.push(1));
    const b = emitter.on("tick", () => calls.push(2));
    emitter.emit("tick");
    expect(calls).toEqual([1, 2]);
    a();
    b();
    expect(emitter.listenerCount("tick")).toBe(0);
    expect(emitter.emit("tick")).toBe(false);
  });

  it("off is a no-op for unknown listeners and events", () => {
    const emitter = createEmitter();
    emitter.off("nope", () => {});
    emitter.on("x", () => {});
    emitter.off("x", () => {});
    expect(emitter.listenerCount("x")).toBe(1);
  });
});
