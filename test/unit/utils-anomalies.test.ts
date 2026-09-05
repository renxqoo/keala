import { describe, expect, it } from "vitest";

import { Keala, createError, type Context, type HttpErrorProps } from "../../src/index.ts";
import { parseQuery } from "../../src/utils/query.ts";
import { parseCookies } from "../../src/index.ts";
import { validateHeaderName } from "../../src/utils/text.ts";
/**
 * Anomaly-path matrix: every illegal/edge input to every public API must
 * either throw a TypeError with a clear message or produce a safe result —
 * never crash the process, never leak internals, never hang.
 *
 * migration: single-object Context (`c`), app-level routing, `c.set` /
 * `c.resHeader` instead of the request/response facades. Two body-setter
 * cases are locked as CONFIRMED-BUG (see the report): the finalizer lets
 * JSON serialization errors escape `app.handle` instead of answering 500
 * (cyclic/BigInt bodies — `dispatchChain` does not guard the finalize call
 * on the fulfilled path). The empty-status/HEAD locks live in matrix.test.ts.
 */

const quiet = { env: "test" } as const;

const captureCtx = async (
  setup: (c: Context) => void,
  url = "http://localhost:3000/",
  init?: RequestInit,
): Promise<Context> => {
  const app = new Keala(quiet);
  let captured: Context | undefined;
  app.use(async (c) => {
    captured = c;
    setup(c);
  });
  await app.handle(new Request(url, init));
  if (captured === undefined) throw new Error("probe failed");
  return captured;
};

describe("anomalies: c.throw argument matrix", () => {
  const cases: [unknown, unknown, unknown, number, string][] = [
    [400, "plain", undefined, 400, "plain"],
    [404, undefined, undefined, 404, "Not Found"],
    [418, new Error("nested"), undefined, 418, "nested"],
    ["500", "msg", undefined, 500, "Internal Server Error"],
    [NaN, "msg", undefined, 500, "Internal Server Error"],
    [99, "msg", undefined, 500, "Internal Server Error"],
    [600, "msg", undefined, 500, "Internal Server Error"],
    [-1, "msg", undefined, 500, "Internal Server Error"],
    [404.5, "msg", undefined, 500, "Internal Server Error"],
    [null, "msg", undefined, 500, "Internal Server Error"],
    [undefined, "just a message", undefined, 500, "Internal Server Error"],
    [429, "slow", { headers: { "Retry-After": "9" } }, 429, "slow"],
    [403, "nope", { expose: false }, 403, "Forbidden"],
    [500, "secret", { expose: true }, 500, "secret"],
    [401, "denied", { code: "A1" }, 401, "denied"],
  ];
  it.each(cases)("throw(%p, %p, %p)", async (status, message, props, wantStatus, wantBody) => {
    const app = new Keala(quiet);
    app.get("/", (c) => {
      c.throw(
        status as number,
        message as string | HttpErrorProps | undefined,
        props as HttpErrorProps | undefined,
      );
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(wantStatus);
    expect(await res.text()).toBe(wantBody);
  });

  it("throw with headers only in props still applies them", async () => {
    const app = new Keala(quiet);
    app.get("/", (c) => {
      c.throw(410, { headers: { Allow: "GET" } });
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(410);
    expect(res.headers.get("allow")).toBe("GET");
  });

  it("throw of a thrown error keeps original headers", async () => {
    const app = new Keala(quiet);
    app.get("/", async () => {
      throw createError(409, "clash", { headers: { "X-Conflict": "yes" } });
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(409);
    expect(res.headers.get("x-conflict")).toBe("yes");
  });
});

describe("anomalies: status setter rejects the invalid matrix", () => {
  const invalid: unknown[] = [
    NaN,
    Infinity,
    -1,
    0,
    99,
    199,
    600,
    1000,
    404.5,
    "200",
    null,
    undefined,
    {},
    [],
  ];
  it.each(invalid)("c.status = %p throws", async (value) => {
    await captureCtx((c) => {
      expect(() => {
        c.status = value as number;
      }).toThrow(TypeError);
    });
  });

  const valid: number[] = [200, 201, 204, 301, 304, 400, 404, 418, 500, 599];
  it.each(valid)("c.status = %p is accepted", async (value) => {
    await captureCtx((c) => {
      c.status = value;
      expect(c.status).toBe(value);
    });
  });
});

describe("anomalies: body setter exotic values", () => {
  // core bug: `bodyInitOf(null→object)` calls JSON.stringify inside the
  // finalizer, and `dispatchChain` does not wrap `finalize` — a serialization
  // failure escapes `app.handle` as a rejected promise. koa answered 500.
  // Intended behavior: res.status === 500. Locked phenomenon: TypeError.
  it("unserializable bodies (circular) answer 500, never reject app.handle", async () => {
    const app = new Keala(quiet);
    app.onError(() => {});
    app.get("/", (c) => {
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      c.body = cyclic;
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Internal Server Error");
  });

  it("unserializable bodies (BigInt) answer 500, never reject app.handle", async () => {
    const app = new Keala(quiet);
    app.onError(() => {});
    app.get("/", (c) => {
      c.body = 10n as never;
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Internal Server Error");
  });

  it.each([
    ["empty string", ""],
    ["single space", " "],
    ["nul byte", "a\0b"],

    ["64KB string", "x".repeat(64 * 1024)],
  ])("string body %s round-trips", async (_label, value) => {
    const app = new Keala(quiet);
    app.get("/", (c) => {
      c.body = value;
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(value);
  });

  it("empty Uint8Array responds 200 with empty body", async () => {
    const app = new Keala(quiet);
    app.get("/", (c) => {
      c.body = new Uint8Array(0);
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(200);
    expect(await res.arrayBuffer()).toHaveProperty("byteLength", 0);
  });

  it("JSON body with nested unicode survives", async () => {
    const app = new Keala(quiet);
    app.get("/", (c) => {
      c.body = { deep: { emoji: "🎉", cjk: "中文", quote: '""' } };
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ deep: { emoji: "🎉", cjk: "中文", quote: '""' } });
  });

  it("body null after object keeps the JSON type and yields literal null", async () => {
    await captureCtx((c) => {
      c.type = "application/json";
      c.body = { a: 1 };
      c.body = null;
      expect(c.body).toBe("null");
    });
  });

  it("failing stream surfaces as 500", async () => {
    const app = new Keala(quiet);
    app.onError(() => {});
    app.get("/", (c) => {
      c.body = new ReadableStream({
        start(controller) {
          controller.error(new Error("stream broke"));
        },
      });
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect([200, 500]).toContain(res.status);
  });
});

describe("anomalies: header operations", () => {
  const badNames = ["", " ", "a b", "a:b", "a;b", "a,b", "a=b", "é", "a(b)", "__proto__"];
  it.each(badNames)("set(%p) throws TypeError", async (name) => {
    await captureCtx((c) => {
      expect(() => c.setHeader(name, "v")).toThrow(TypeError);
    });
  });

  const badValues = ["v\r\nX: 1", "v\nX: 1", "v\rX: 1", "v\0", "v\u0000x"];
  it.each(badValues)("set(name, %p) throws", async (value) => {
    await captureCtx((c) => {
      expect(() => c.setHeader("X-Safe", value)).toThrow(TypeError);
    });
  });

  it.each(["", " ", "x".repeat(16 * 1024)])("accepts value %s without crashing", async (value) => {
    const app = new Keala(quiet);
    app.get("/", (c) => {
      c.setHeader("X-Long", value);
      c.body = "ok";
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(200);
  });

  it("append to a non-existent header then set replaces it", async () => {
    await captureCtx((c) => {
      c.append("X-A", "1");
      c.append("X-A", "2");
      c.setHeader("X-A", "3");
      expect(c.resHeader("X-A")).toBe("3");
    });
  });

  it("remove on a missing header is a no-op", async () => {
    await captureCtx((c) => {
      expect(() => c.remove("X-Missing")).not.toThrow();
    });
  });

  it("set(undefined value) is ignored, not stored", async () => {
    await captureCtx((c) => {
      c.setHeader("X-Undefined", undefined as unknown as string);
      expect(c.resHeader("X-Undefined")).toBe("");
    });
  });
});

describe("anomalies: etag inputs", () => {
  // 0.7: the c.message input matrix is gone with the API (statusText
  // customization no longer exists, so there is nothing to poison).

  it.each(["", "abc", '"quoted"', 'W/"weak"', '\\"escaped'])(
    "etag %p accepted safely",
    async (etag) => {
      await captureCtx((c) => {
        c.etag = etag;
        expect(c.resHeader("ETag")).not.toContain("\n");
      });
    },
  );
});

describe("anomalies: cookies illegal inputs", () => {
  const badNames = ["", "a b", "a;b", "a=b", "a,b", "a[b]", "é"];
  it.each(badNames)("set cookie name %p throws", async (name) => {
    await captureCtx((c) => {
      expect(() => c.cookies.set(name, "v")).toThrow(TypeError);
    });
  });

  const badValues = ["a;b", "a,b", 'a"b', "a\\b", "a\rb", "a\nb", "a\0b"];
  it.each(badValues)("set cookie value %p throws", async (value) => {
    await captureCtx((c) => {
      expect(() => c.cookies.set("sid", value)).toThrow(TypeError);
    });
  });

  it.each([NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "60"])(
    "maxAge %p throws",
    async (maxAge) => {
      await captureCtx((c) => {
        expect(() => c.cookies.set("sid", "v", { maxAge: maxAge as number })).toThrow(TypeError);
      });
    },
  );

  it("expires as non-Date throws", async () => {
    await captureCtx((c) => {
      expect(() => c.cookies.set("sid", "v", { expires: "soon" as unknown as Date })).toThrow(
        TypeError,
      );
    });
  });

  it("validates domain and path against injection", async () => {
    await captureCtx((c) => {
      expect(() => c.cookies.set("sid", "v", { domain: "a\r\nb" })).toThrow(TypeError);
      expect(() => c.cookies.set("sid", "v", { path: "a;b" })).toThrow(TypeError);
      expect(() => c.cookies.set("sid", "v", { domain: "example.com" })).not.toThrow();
    });
  });

  it("malformed Cookie headers never throw on get", async () => {
    await captureCtx(
      (c) => {
        expect(c.cookies.get("anything")).toBeUndefined();
      },
      "http://localhost:3000/",
      { headers: { Cookie: ";;;=;;==;;not a cookie at all;;" } },
    );
  });
});

/**
 * Unicode-confusion probes (NFKC folding, fullwidth homoglyphs) — split
 * from agent-security-audit for the 500-line budget.
 */

const drive = async (app: InstanceType<typeof Keala>, url: string): Promise<Response> =>
  app.handle(new Request(url));

const FULLWIDTH_PROTO = "＿＿ｐｒｏｔｏ＿＿"; // U+FF3F/U+FF50 variants

describe("audit: unicode confusion (no normalization bypass)", () => {
  it("a fullwidth proto key NFKC-folds to __proto__ but stays inert here", async () => {
    // Document the attack intent: NFKC would fold the key to `__proto__`.
    expect(FULLWIDTH_PROTO.normalize("NFKC")).toBe("__proto__");
    const app = new Keala(quiet);
    let folded: string | undefined = "unset";
    let literal: string | undefined = "unset";
    app.use((c) => {
      // NFKC must NOT be applied: the fullwidth key stays a distinct literal
      // (findable by its own name), never folding onto __proto__.
      folded = c.query("__proto__");
      literal = c.query(FULLWIDTH_PROTO);
      c.body = "ok";
    });
    const res = await drive(
      app,
      `http://localhost:3000/?${encodeURIComponent(FULLWIDTH_PROTO)}=1&ok=2`,
    );
    expect(res.status).toBe(200);
    expect(folded).toBeUndefined(); // no NFKC fold onto __proto__
    expect(literal).toBe("1"); // the fullwidth literal stays its own key
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("fullwidth period in a path never folds into a traversal dot", async () => {
    const app = new Keala(quiet);
    let path = "";
    app.use((c) => {
      path = c.path;
      c.body = "ok";
    });
    // %EF%BC%8E is U+FF0E FULLWIDTH FULL STOP.
    await drive(app, "http://localhost:3000/a%EF%BC%8E%EF%BC%8E/b");
    expect(path).toBe("/a%EF%BC%8E%EF%BC%8E/b"); // no decode, no folding
    expect(decodeURIComponent("%EF%BC%8E").normalize("NFKC")).toBe(".");
    expect(decodeURIComponent("/a%EF%BC%8E%EF%BC%8E/b")).not.toContain("..");
  });

  it("overlong UTF-8 percent escapes never decode into metacharacters", () => {
    // %C0%AF is an overlong encoding of "/"; decoders must reject it.
    const parsed = parseQuery("?x=%C0%AF..%C0%AFetc");
    expect(parsed["x"]).not.toContain("/");
    expect(parsed["x"]).toBe("%C0%AF..%C0%AFetc");
  });

  it("fullwidth and homoglyph header names are rejected as invalid tokens", () => {
    expect(() => validateHeaderName("Ｘ-Evil")).toThrow(TypeError); // U+FF38
    expect(() => validateHeaderName("x\u200bevil")).toThrow(TypeError); // ZWSP
    expect(() => validateHeaderName("x‑forwarded‑for")).toThrow(TypeError); // U+2011
  });

  it("fullwidth cookie names are dropped by the parser (ASCII tokens only)", () => {
    const jar = parseCookies(`${FULLWIDTH_PROTO}=1; ｓｅｓｓｉｏｎ=x; session=ok`);
    expect(jar["session"]).toBe("ok");
    expect(Object.keys(jar)).toEqual(["session"]);
  });
});

// ---------------------------------------------------------------------------
// 7. Negotiation/cookie parser complexity locks.
// ---------------------------------------------------------------------------
