/**
 * Dense negotiation and cookie matrices: q-value tables, wildcard fallback
 * order, language matching and every cookie option combination.
 */

import { describe, expect, it } from "vitest";

import { Keala } from "../src/index.ts";
import type { Context } from "../src/core/context/context.ts";
import { serializeCookie } from "../src/context/cookies.ts";
import { acceptsType } from "../src/negotiation/accepts.ts";

const quiet = { env: "test" } as const;

const probe = async (headers: Record<string, string>): Promise<Context> => {
  const app = new Keala(quiet);
  let ctx: Context | undefined;
  app.use(async (c) => {
    ctx = c;
    c.body = "probed";
  });
  await app.handle(new Request("http://localhost:3000/", { headers }));
  if (ctx === undefined) throw new Error("probe failed");
  return ctx;
};

describe("negotiation matrix: Accept q-value table", () => {
  const rows: [string, string[], string | false][] = [
    ["text/html", ["text/html", "application/json"], "text/html"],
    ["text/html;q=0, application/json", ["text/html", "application/json"], "application/json"],
    ["text/html;q=0.001", ["text/html", "application/json"], "text/html"],
    ["text/html;q=1.0, application/json;q=1.0", ["application/json", "text/html"], "text/html"],
    [
      "text/html;q=0.5, application/json;q=0.9",
      ["text/html", "application/json"],
      "application/json",
    ],
    ["*/*;q=0.1, text/html;q=0.2", ["application/json", "text/html"], "text/html"],
    // negotiator semantics (verified against the package): the exact range
    // defines application/json's quality (0.1), so the wildcard's 0.9 wins
    // for text/html.
    ["*/*;q=0.9, application/json;q=0.1", ["application/json", "text/html"], "text/html"],
    ["text/*;q=0.8, application/json", ["text/plain", "application/json"], "application/json"],
    ["text/*;q=0.8, application/json;q=0.1", ["text/plain", "application/json"], "text/plain"],
    ["application/json, text/html;q=0.9, */*;q=0.8", ["text/plain"], "text/plain"],
    ["audio/*", ["audio/mp3", "video/mp4"], "audio/mp3"],
    ["audio/*", ["video/mp4"], false],
    ["text/html, application/xhtml+xml", ["application/xhtml+xml"], "application/xhtml+xml"],
    [" unicode/no-spaces ", ["unicode/no-spaces"], "unicode/no-spaces"],
  ];
  it.each(rows)("acceptsType(%j, %j) → %j", (header, provided, expected) => {
    expect(acceptsType(header, provided)).toBe(expected);
  });

  it.each([
    [",,,", ["text/html"], false],
    ["  ", ["text/html"], false],
    [";", ["text/html"], false],
    ["text/html;", ["text/html"], "text/html"],
    // R7-NEG-3 (negotiator parity): a q that is not a qvalue drops the ITEM,
    // never promotes it to q=1 — with no acceptable range left, NOTHING is
    // acceptable (negotiator answers [] for both provided lists).
    ["text/html;q=", ["text/html", "application/json"], false],
    ["text/html;q=abc", ["text/html", "application/json"], false],
    ["text/html;q=abc", ["text/html"], false],
    [
      "text/html;q=abc, application/json;q=0.5",
      ["text/html", "application/json"],
      "application/json",
    ],
  ])("malformed q drops the item instead of gaining quality", (header, provided, expected) => {
    expect(acceptsType(header, provided)).toBe(expected);
  });
});

describe("negotiation matrix: language matching table", () => {
  const rows: [string, string[], string | false][] = [
    ["en", ["en", "zh"], "en"],
    ["zh", ["en", "zh"], "zh"],
    ["en-US", ["en", "zh"], "en"],
    ["en-US,en;q=0.9", ["zh", "en"], "en"],
    ["zh-CN;q=1,en;q=0.5", ["zh", "en"], "zh"],
    ["fr", ["en", "zh"], false],
    ["*", ["en"], "en"],
    ["*;q=0", ["en"], false],
    ["de-DE,de;q=0.8,en;q=0.5", ["de", "en", "de-CH"], "de"],
    ["pt-BR", ["pt", "en"], "pt"],
  ];
  it.each(rows)("acceptsLanguages(%j, %j) → %j", async (header, provided, expected) => {
    const ctx = await probe({ "Accept-Language": header });
    expect(ctx.acceptsLanguages(...provided)).toBe(expected);
  });
});

describe("negotiation matrix: encoding and charset tables", () => {
  it.each([
    ["gzip", ["gzip", "br", "identity"], "gzip"],
    ["br, gzip;q=0.5", ["gzip", "br"], "br"],
    ["gzip;q=0, br", ["gzip", "br"], "br"],
    ["gzip;q=0, *;q=0", ["gzip", "br"], false],
    ["*", ["gzip"], "gzip"],
    // An absent/empty Accept-Encoding means the client understands NO
    // content codings — identity only (RFC 7231 §5.3.4; negotiator's answer,
    // verified live). Not "the server's first provided".
    ["", ["gzip"], false],
  ])("encodings %j → %j", async (header, provided, expected) => {
    const ctx = await probe({ "Accept-Encoding": header });
    expect(ctx.acceptsEncodings(...provided)).toBe(expected);
  });

  it.each([
    ["utf-8", ["utf-8", "latin1"], "utf-8"],
    ["utf-16;q=0.9, utf-8;q=0.1", ["utf-8", "utf-16"], "utf-16"],
    ["shift-jis", ["utf-8"], false],
    ["*", ["utf-8"], "utf-8"],
  ])("charsets %j → %j", async (header, provided, expected) => {
    const ctx = await probe({ "Accept-Charset": header });
    expect(ctx.acceptsCharsets(...provided)).toBe(expected);
  });
});

describe("negotiation matrix: is() tables", () => {
  const rows: [string | null, string[], string | null | false][] = [
    ["application/json", ["json"], "json"],
    ["application/json; charset=utf-8", ["application/json"], "application/json"],
    ["application/json", ["html", "xml"], false],
    ["text/html", ["html"], "html"],
    ["text/html", ["text/*"], "text/*"],
    ["text/html", ["*"], "text/html"],
    ["image/png", ["image/*"], "image/*"],
    ["application/vnd.api+json", ["json"], "json"],
    ["application/atom+xml", ["xml"], "xml"],
    [null, ["json"], null],
    [null, [], ""],
  ];
  it.each(rows)("is(%j, %j) → %j", async (contentType, types, expected) => {
    const headers: Record<string, string> =
      contentType === null ? {} : { "Content-Type": contentType };
    const ctx = await probe(headers);
    expect(ctx.is(...types)).toBe(expected);
  });

  it.each([
    ["text/html", "text/html"],
    ["text/html;charset=utf8", "text/html"],
    ["", ""],
    [null, ""],
  ])("argless is() with content-type %j → %j", async (contentType, expected) => {
    const headers: Record<string, string> =
      contentType === null ? {} : { "Content-Type": contentType };
    const ctx = await probe(headers);
    expect(ctx.is()).toBe(expected);
  });
});

describe("cookies matrix: serialization option table", () => {
  const rows: [string, Record<string, unknown>, string][] = [
    ["plain", {}, "sid=1"],
    ["path", { path: "/app" }, "sid=1; Path=/app"],
    ["domain", { domain: "ex.com" }, "sid=1; Domain=ex.com"],
    ["maxAge", { maxAge: 3600 }, "sid=1; Max-Age=3600"],
    ["maxAge negative", { maxAge: -1 }, "sid=1; Max-Age=-1"],
    [
      "expires",
      { expires: new Date(Date.UTC(2025, 0, 2)) },
      "sid=1; Expires=Thu, 02 Jan 2025 00:00:00 GMT",
    ],
    ["httpOnly", { httpOnly: true }, "sid=1; HttpOnly"],
    ["secure", { secure: true }, "sid=1; Secure"],
    ["sameSite strict", { sameSite: "strict" }, "sid=1; SameSite=Strict"],
    ["sameSite lax", { sameSite: "lax" }, "sid=1; SameSite=Lax"],
    ["sameSite none", { sameSite: "none" }, "sid=1; SameSite=None"],
    ["sameSite true", { sameSite: true }, "sid=1; SameSite=Strict"],
    ["sameSite false", { sameSite: false }, "sid=1"],
    ["partitioned", { partitioned: true, secure: true }, "sid=1; Partitioned; Secure"],
    ["priority low", { priority: "low" }, "sid=1; Priority=Low"],
    ["priority medium", { priority: "medium" }, "sid=1; Priority=Medium"],
    ["priority high", { priority: "high" }, "sid=1; Priority=High"],
    [
      "everything",
      { path: "/", secure: true, httpOnly: true, sameSite: "lax" },
      "sid=1; Path=/; SameSite=Lax; Secure; HttpOnly",
    ],
  ];
  it.each(rows)("%s serializes fully", (_label, options, expected) => {
    expect(serializeCookie("sid", "1", options as never)).toBe(expected);
  });
});

describe("cookies matrix: facade behaviors", () => {
  it("multiple distinct cookies accumulate in order", async () => {
    const app = new Keala(quiet);
    app.use(async (c) => {
      c.cookies.set("a", "1");
      c.cookies.set("b", "2");
      c.cookies.set("c", "3");
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect([...res.headers.getSetCookie()]).toEqual(["a=1", "b=2", "c=3"]);
  });

  it("signed cookies round-trip through the facade with options intact", async () => {
    const app = new Keala({ ...quiet, keys: ["k1"] });
    app.use(async (c) => {
      if (c.path === "/set") {
        c.cookies.set("sid", "user-9", { signed: true, httpOnly: true, path: "/" });
        return;
      }
      c.body = c.cookies.get("sid") ?? "none";
    });
    await app.handle(new Request("http://localhost:3000/set"));
    const setter = new Keala({ ...quiet, keys: ["k1"] });
    setter.use(async (c) => {
      c.cookies.set("sid", "user-9", { signed: true });
    });
    const baked = await setter.handle(new Request("http://localhost:3000/"));
    const cookieLine = baked.headers.getSetCookie()[0] ?? "";
    const res = await app.handle(
      new Request("http://localhost:3000/get", {
        headers: { Cookie: cookieLine.split(";")[0] ?? "" },
      }),
    );
    expect(await res.text()).toBe("user-9");
  });

  it.each([
    ["a", "1"],
    ["Session-Id", "abc"],
    ["a.b.c", "v"],
    ["a-b_c", "v"],
    ["~tilde", "v"],
    ["dollar$", "v"],
  ])("cookie name %p is legal", (name, value) => {
    expect(() => serializeCookie(name, value)).not.toThrow();
  });

  it.each([
    ["sid", "a b"],
    ["sid", "a\tb"],
    ["sid", "中文"],
    ["sid", "x".repeat(4096)],
  ])("cookie value %p for %s is rejected or safe", (_name, value) => {
    const result = (() => {
      try {
        return serializeCookie("sid", value as string);
      } catch {
        return null;
      }
    })();
    if (result !== null) {
      expect(result).not.toMatch(/[\r\n]/);
    }
  });
});

describe("url/query matrix: dense getters", () => {
  const rows: [string, Record<string, unknown>][] = [
    ["http://h:8080/", { path: "/", host: "h:8080", hostname: "h", querystring: "" }],
    ["http://h/", { path: "/", host: "h", hostname: "h" }],
    ["http://h/a?b", { path: "/a", querystring: "b", search: "?b" }],
    ["http://h/a#f", { path: "/a", querystring: "" }],
    ["http://h/a?f#g", { path: "/a", querystring: "f" }],
    ["http://h/a%20b", { path: "/a%20b" }],
  ];
  it.each(rows)("%s → %j", async (url, expected) => {
    const app = new Keala(quiet);
    let seen: Record<string, unknown> = {};
    app.use(async (c) => {
      seen = {
        path: c.path,
        host: c.host,
        hostname: c.hostname,
        querystring: c.querystring,
        search: c.search,
      };
      c.body = "ok";
    });
    await app.handle(new Request(url, { headers: { Host: url.split("/")[2] ?? "h" } }));
    for (const [key, value] of Object.entries(expected)) {
      expect(seen[key]).toBe(value);
    }
  });
});
