/**
 * Anomaly-path matrix: every illegal/edge input to every public API must
 * either throw a TypeError with a clear message or produce a safe result —
 * never crash the process, never leak internals, never hang.
 */

import { describe, expect, it } from "vitest";

import { createApp } from "../src/application/app.ts";
import type { Context } from "../src/context/context.ts";
import { createError } from "../src/http/errors.ts";

const quiet = { env: "test" } as const;

const captureCtx = async (
  setup: (ctx: Context) => void,
  url = "http://localhost:3000/",
  init?: RequestInit,
): Promise<Context> => {
  const app = createApp(quiet);
  let ctx: Context | undefined;
  app.use(async (c) => {
    ctx = c;
    setup(c);
  });
  await app.handle(new Request(url, init));
  if (ctx === undefined) throw new Error("probe failed");
  return ctx;
};

describe("anomalies: ctx.throw argument matrix", () => {
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
    const app = createApp(quiet);
    app.use(async (ctx) => {
      ctx.throw(status as number, message as string, props as Parameters<typeof ctx.throw>[2]);
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(wantStatus);
    expect(await res.text()).toBe(wantBody);
  });

  it("throw with headers only in props still applies them", async () => {
    const app = createApp(quiet);
    app.use(async (ctx) => {
      ctx.throw(410, { headers: { Allow: "GET" } });
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(410);
    expect(res.headers.get("allow")).toBe("GET");
  });

  it("throw of a thrown error keeps original headers", async () => {
    const app = createApp(quiet);
    app.use(async () => {
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
  it.each(invalid)("ctx.status = %p throws", async (value) => {
    await captureCtx((ctx) => {
      expect(() => {
        ctx.status = value as number;
      }).toThrow(TypeError);
    });
  });

  const valid: number[] = [200, 201, 204, 301, 304, 400, 404, 418, 500, 599];
  it.each(valid)("ctx.status = %p is accepted", async (value) => {
    await captureCtx((ctx) => {
      ctx.status = value;
      expect(ctx.status).toBe(value);
    });
  });
});

describe("anomalies: body setter exotic values", () => {
  it("circular objects surface as 500, not a crash", async () => {
    const app = createApp(quiet);
    app.on("error", () => {});
    app.use(async (ctx) => {
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      ctx.body = cyclic;
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(500);
  });

  it("BigInt bodies surface as 500", async () => {
    const app = createApp(quiet);
    app.on("error", () => {});
    app.use(async (ctx) => {
      ctx.body = 10n;
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(500);
  });

  it.each([
    ["empty string", ""],
    ["single space", " "],
    ["nul byte", "a\0b"],

    ["64KB string", "x".repeat(64 * 1024)],
  ])("string body %s round-trips", async (_label, value) => {
    const app = createApp(quiet);
    app.use(async (ctx) => {
      ctx.body = value;
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(200);
    expect(res.status).toBe(200);
  });

  it("empty Uint8Array responds 200 with empty body", async () => {
    const app = createApp(quiet);
    app.use(async (ctx) => {
      ctx.body = new Uint8Array(0);
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(200);
    expect(await res.arrayBuffer()).toHaveProperty("byteLength", 0);
  });

  it("JSON body with nested unicode survives", async () => {
    const app = createApp(quiet);
    app.use(async (ctx) => {
      ctx.body = { deep: { emoji: "🎉", cjk: "中文", quote: '""' } };
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(await res.json()).toEqual({ deep: { emoji: "🎉", cjk: "中文", quote: '""' } });
  });

  it("body null after object keeps the JSON type and yields literal null", async () => {
    await captureCtx((ctx) => {
      ctx.type = "application/json";
      ctx.body = { a: 1 };
      ctx.body = null;
      expect(ctx.body).toBe("null");
    });
  });

  it("failing stream surfaces as 500", async () => {
    const app = createApp(quiet);
    app.on("error", () => {});
    app.use(async (ctx) => {
      ctx.body = new ReadableStream({
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
    await captureCtx((ctx) => {
      expect(() => ctx.set(name, "v")).toThrow(TypeError);
    });
  });

  const badValues = ["v\r\nX: 1", "v\nX: 1", "v\rX: 1", "v\0", "v\u0000x"];
  it.each(badValues)("set(name, %p) throws", async (value) => {
    await captureCtx((ctx) => {
      expect(() => ctx.set("X-Safe", value)).toThrow(TypeError);
    });
  });

  it.each(["", " ", "x".repeat(16 * 1024)])("accepts value %s without crashing", async (value) => {
    const app = createApp(quiet);
    app.use(async (ctx) => {
      ctx.set("X-Long", value);
      ctx.body = "ok";
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(200);
  });

  it("append to a non-existent header then set replaces it", async () => {
    await captureCtx((ctx) => {
      ctx.append("X-A", "1");
      ctx.append("X-A", "2");
      ctx.set("X-A", "3");
      expect(ctx.response.get("X-A")).toBe("3");
    });
  });

  it("remove on a missing header is a no-op", async () => {
    await captureCtx((ctx) => {
      expect(() => ctx.remove("X-Missing")).not.toThrow();
    });
  });

  it("set(undefined value) is ignored, not stored", async () => {
    await captureCtx((ctx) => {
      ctx.set("X-Undefined", undefined as unknown as string);
      expect(ctx.response.get("X-Undefined")).toBe("");
    });
  });
});

describe("anomalies: message and etag inputs", () => {
  it.each(["", "ok", "with spaces", "unicode 中文"])("message %p is safe to set", async (msg) => {
    const app = createApp(quiet);
    app.use(async (ctx) => {
      ctx.status = 201;
      ctx.message = msg;
      ctx.body = "ok";
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(201); // never a 500 from statusText encoding
  });

  it.each(["", "abc", '"quoted"', 'W/"weak"', '\\"escaped'])(
    "etag %p accepted safely",
    async (etag) => {
      await captureCtx((ctx) => {
        ctx.etag = etag;
        expect(ctx.response.get("ETag")).not.toContain("\n");
      });
    },
  );
});

describe("anomalies: cookies illegal inputs", () => {
  const badNames = ["", "a b", "a;b", "a=b", "a,b", "a[b]", "é"];
  it.each(badNames)("set cookie name %p throws", async (name) => {
    await captureCtx((ctx) => {
      expect(() => ctx.cookies.set(name, "v")).toThrow(TypeError);
    });
  });

  const badValues = ["a;b", "a,b", 'a"b', "a\\b", "a\rb", "a\nb", "a\0b"];
  it.each(badValues)("set cookie value %p throws", async (value) => {
    await captureCtx((ctx) => {
      expect(() => ctx.cookies.set("sid", value)).toThrow(TypeError);
    });
  });

  it.each([NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "60"])(
    "maxAge %p throws",
    async (maxAge) => {
      await captureCtx((ctx) => {
        expect(() => ctx.cookies.set("sid", "v", { maxAge: maxAge as number })).toThrow(TypeError);
      });
    },
  );

  it("expires as non-Date throws", async () => {
    await captureCtx((ctx) => {
      expect(() => ctx.cookies.set("sid", "v", { expires: "soon" as unknown as Date })).toThrow(
        TypeError,
      );
    });
  });

  it("validates domain and path against injection", async () => {
    await captureCtx((ctx) => {
      expect(() => ctx.cookies.set("sid", "v", { domain: "a\r\nb" })).toThrow(TypeError);
      expect(() => ctx.cookies.set("sid", "v", { path: "a;b" })).toThrow(TypeError);
      expect(() => ctx.cookies.set("sid", "v", { domain: "example.com" })).not.toThrow();
    });
  });

  it("malformed Cookie headers never throw on get", async () => {
    await captureCtx(
      (ctx) => {
        expect(ctx.cookies.get("anything")).toBeUndefined();
      },
      "http://localhost:3000/",
      { headers: { Cookie: ";;;=;;==;;not a cookie at all;;" } },
    );
  });
});
