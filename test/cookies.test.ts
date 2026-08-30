import { describe, expect, it } from "vitest";

import {
  createCookies,
  parseCookies,
  serializeCookie,
  sign,
  unsign,
  type CookiesHost,
} from "../src/context/cookies.ts";

describe("parseCookies", () => {
  it("parses pairs", () => {
    expect(parseCookies("a=1; b=2")).toEqual({ a: "1", b: "2" });
    expect(parseCookies(null)).toEqual({});
    expect(parseCookies("")).toEqual({});
  });

  it("keeps empty values and quoted values", () => {
    expect(parseCookies('empty=; q="v"')).toEqual({ empty: "", q: "v" });
  });

  it("decodes URI components safely", () => {
    expect(parseCookies("n=%E4%B8%AD")).toEqual({ n: "中" });
    expect(parseCookies("bad=%E4")).toEqual({ bad: "%E4" });
  });

  it("skips invalid cookie names", () => {
    expect(parseCookies("a[b]=1; ok=2")).toEqual({ ok: "2" });
  });

  it("returns a null-prototype map", () => {
    expect(Object.getPrototypeOf(parseCookies("a=1"))).toBe(null);
  });
});

describe("serializeCookie", () => {
  it("serializes name=value with options", () => {
    expect(serializeCookie("sid", "abc", { path: "/", httpOnly: true, secure: true })).toBe(
      "sid=abc; Path=/; Secure; HttpOnly",
    );
  });

  it("writes maxAge and expires", () => {
    expect(serializeCookie("sid", "v", { maxAge: 60 })).toContain("Max-Age=60");
    expect(serializeCookie("sid", "v", { maxAge: -1 })).toContain("Max-Age=-1");
    expect(serializeCookie("sid", "v", { expires: new Date(Date.UTC(2024, 0, 1)) })).toContain(
      "Expires=Mon, 01 Jan 2024 00:00:00 GMT",
    );
  });

  it("writes sameSite / priority / partitioned", () => {
    expect(serializeCookie("a", "1", { sameSite: "strict" })).toContain("SameSite=Strict");
    expect(serializeCookie("a", "1", { sameSite: true })).toContain("SameSite=Strict");
    expect(serializeCookie("a", "1", { sameSite: "lax" })).toContain("SameSite=Lax");
    expect(serializeCookie("a", "1", { sameSite: "none" })).toContain("SameSite=None");
    expect(serializeCookie("a", "1", { sameSite: false })).not.toContain("SameSite");
    expect(serializeCookie("a", "1", { priority: "high" })).toContain("Priority=High");
    expect(serializeCookie("a", "1", { partitioned: true })).toContain("Partitioned");
  });

  it("rejects invalid names and values", () => {
    expect(() => serializeCookie("bad name", "v")).toThrow(TypeError);
    expect(() => serializeCookie("bad;name", "v")).toThrow(TypeError);
    expect(() => serializeCookie("ok", "bad;value")).toThrow(TypeError);
    expect(() => serializeCookie("ok", "bad,value")).toThrow(TypeError);
    expect(() => serializeCookie("ok", "bad\r\nvalue")).toThrow(TypeError);
  });

  it("rejects header injection in path and domain", () => {
    expect(() => serializeCookie("a", "1", { path: "/x\r\nEvil: 1" })).toThrow(TypeError);
    expect(() => serializeCookie("a", "1", { domain: "evil.com\r\n" })).toThrow(TypeError);
  });

  it("rejects non-finite maxAge and non-Date expires", () => {
    expect(() => serializeCookie("a", "1", { maxAge: Number.POSITIVE_INFINITY })).toThrow(
      TypeError,
    );
    expect(() => serializeCookie("a", "1", { expires: "soon" as unknown as Date })).toThrow(
      TypeError,
    );
  });
});

describe("sign / unsign", () => {
  const keys = ["peanut butter", "almond butter"];

  it("round-trips a signed value", () => {
    const signed = sign("uid=42", keys[0] as string);
    expect(signed.startsWith("uid=42.")).toBe(true);
    expect(unsign(signed, keys)).toBe("uid=42");
  });

  it("verifies with any rotated key", () => {
    const signed = sign("uid=42", keys[1] as string);
    expect(unsign(signed, keys)).toBe("uid=42");
  });

  it("rejects tampered values", () => {
    const signed = sign("uid=42", keys[0] as string);
    expect(unsign(`uid=43${signed.slice(5)}`, keys)).toBe(false);
    expect(unsign("no-dot", keys)).toBe(false);
    expect(unsign("", keys)).toBe(false);
  });

  it("rejects when no key matches", () => {
    expect(unsign(sign("x", "right"), ["wrong"])).toBe(false);
  });
});

const makeHost = (
  cookieHeader: string | null,
  keys?: string[],
): CookiesHost & {
  jar: Record<string, string | string[]>;
} => {
  const jar: Record<string, string | string[]> = {};
  return {
    jar,
    cookieHeader,
    keys,
    get responseHeaders() {
      return jar;
    },
  } as CookiesHost & { jar: Record<string, string | string[]> };
};

describe("createCookies facade", () => {
  it("gets unsigned values by default when keys exist", () => {
    const host = makeHost(`sid=${sign("abc", "k1")}`, ["k1"]);
    const cookies = createCookies(host);
    expect(cookies.get("sid")).toBe("abc");
    expect(cookies.get("missing")).toBeUndefined();
  });

  it("returns raw values when signed explicitly disabled or no keys", () => {
    const host = makeHost(`sid=${sign("abc", "k1")}`, ["k1"]);
    const cookies = createCookies(host);
    expect(cookies.get("sid", { signed: false })).toBe(sign("abc", "k1"));
    const unsigned = createCookies(makeHost("sid=abc"));
    expect(unsigned.get("sid")).toBe("abc");
  });

  it("returns undefined for forged signed cookies", () => {
    const host = makeHost("sid=abc.forged", ["k1"]);
    expect(createCookies(host).get("sid")).toBeUndefined();
  });

  it("sets cookies into the response headers", () => {
    const host = makeHost(null);
    const cookies = createCookies(host);
    cookies.set("theme", "dark", { path: "/" });
    cookies.set("lang", "zh", { httpOnly: true });
    expect(host.jar["set-cookie"]).toEqual(["theme=dark; Path=/", "lang=zh; HttpOnly"]);
  });

  it("signs set values when keys exist", () => {
    const host = makeHost(null, ["k1"]);
    createCookies(host).set("sid", "abc", { signed: true });
    const [value] = host.jar["set-cookie"] as string[];
    expect(value?.startsWith("sid=")).toBe(true);
    expect(unsign((value ?? "").slice(4), ["k1"])).toBe("abc");
  });

  it("skips duplicate names unless overwrite", () => {
    const host = makeHost(null);
    const cookies = createCookies(host);
    cookies.set("a", "1");
    cookies.set("a", "2");
    expect(host.jar["set-cookie"]).toEqual(["a=1"]);
    cookies.set("a", "3", { overwrite: true });
    expect(host.jar["set-cookie"]).toEqual(["a=3"]);
  });

  it("overwrites within an existing plain header value", () => {
    const jar: Record<string, string | string[]> = { "set-cookie": "old=1" };
    const host = {
      get responseHeaders() {
        return jar;
      },
      cookieHeader: null,
      keys: undefined,
    } as unknown as CookiesHost;
    const cookies = createCookies(host);
    cookies.set("new", "2");
    expect(jar["set-cookie"]).toEqual(["old=1", "new=2"]);
    cookies.set("new", "3", { overwrite: true });
    expect(jar["set-cookie"]).toEqual(["old=1", "new=3"]);
  });
});
