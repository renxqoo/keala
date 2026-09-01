/**
 * Response behavior matrix: body kinds x status families x HEAD x messages,
 * plus the exact bytes/headers the runtime produces.
 *
 * migration notes:
 *  - Markup sniffing and the bytes/stream → application/octet-stream
 *    inference are gone (D1): string bodies carry no framework content-type
 *    (the runtime provides a text/plain variant); binary bodies carry none.
 *  - HEAD: the Content-Length contract is carried by the committed
 *    (`c.text()`/`c.json()`) path; state-mode HEAD with no prior response
 *    headers drops the backfilled Content-Length — locked as CONFIRMED-BUG
 *    (stale local `record` in core/respond.ts fromState).
 */

import { describe, expect, it } from "vitest";

import { Keala, type Context } from "../src/index.ts";

const quiet = { env: "test" } as const;

const respondWith = async (setup: (c: Context) => void, init?: RequestInit): Promise<Response> => {
  const app = new Keala(quiet);
  app.get("/", (c) => {
    setup(c);
  });
  return app.handle(new Request("http://localhost:3000/", init)) as Promise<Response>;
};

const captureCtx = async (setup: (c: Context) => void): Promise<Context> => {
  let captured: Context | undefined;
  const app = new Keala(quiet);
  app.use(async (c) => {
    captured = c;
    setup(c);
  });
  await app.handle(new Request("http://localhost:3000/"));
  if (captured === undefined) throw new Error("probe failed");
  return captured;
};

describe("matrix: body kinds x explicit empty statuses", () => {
  const bodies: [string, unknown][] = [
    ["text", "hello"],
    ["markup", "<b>hi</b>"],
    ["bytes", new Uint8Array([65, 66])],
    ["object", { ok: true }],
    ["blob", new Blob(["bl"], { type: "text/plain" })],
  ];
  const emptyStatuses = [204, 205, 304];

  it.each(bodies)("body %s + 204 → empty response", async (_label, body) => {
    const res = await respondWith((c) => {
      c.body = body as never;
      c.status = 204;
    });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(res.headers.get("content-type")).toBe(null);
    expect(res.headers.get("content-length")).toBe(null);
  });

  it.each(emptyStatuses)("status %s set before body suppresses the body", async (status) => {
    const res = await respondWith((c) => {
      c.status = status;
      c.body = "payload";
    });
    expect(res.status).toBe(status);
    expect(await res.text()).toBe("");
  });

  it.each(emptyStatuses)("status %s set after body suppresses the body", async (status) => {
    const res = await respondWith((c) => {
      c.body = "payload";
      c.status = status;
    });
    expect(res.status).toBe(status);
    expect(await res.text()).toBe("");
    expect(res.headers.get("content-type")).toBe(null);
  });

  it.each(emptyStatuses)(
    "status %s keeps unrelated headers while clearing content headers",
    async (status) => {
      const res = await respondWith((c) => {
        c.body = "payload";
        c.set("Content-Length", "99");
        c.set("X-Keep", "1");
        c.status = status;
      });
      expect(res.status).toBe(status);
      expect(res.headers.get("x-keep")).toBe("1");
      expect(res.headers.get("content-type")).toBe(null);
      expect(res.headers.get("content-length")).toBe(null);
    },
  );

  it.each(emptyStatuses)(
    "status %s clears the body and content headers in-process",
    async (status) => {
      const c = await captureCtx((ctx) => {
        ctx.body = "payload";
        ctx.set("X-Keep", "1");
        ctx.status = status;
      });
      expect(c.body).toBe(null);
      expect(c.has("Content-Type")).toBe(false);
      expect(c.has("Content-Length")).toBe(false);
      expect(c.has("X-Keep")).toBe(true);
    },
  );
});

describe("matrix: missing body per status family (koa respond semantics)", () => {
  const cases: [number, string, string][] = [
    [200, "OK", "OK"],
    [201, "Created", "Created"],
    [202, "", "Accepted"],
    [400, "Bad Request", "Bad Request"],
    [404, "", "Not Found"],
    [410, "gone", "gone"],
    [418, "teapot", "teapot"],
    [500, "", "Internal Server Error"],
    [503, "", "Service Unavailable"],
    [599, "", "599"],
  ];
  it.each(cases)("status %d + msg %j → %j", async (status, message, expected) => {
    const res = await respondWith((c) => {
      c.status = status;
      if (message) c.message = message;
    });
    expect(res.status).toBe(status);
    expect(await res.text()).toBe(expected);
    // koa asserted "text/plain; charset=utf-8" set by the framework; D1
    // relies on the runtime, which provides a text/plain variant here.
    const ct = res.headers.get("content-type") ?? "";
    // D1: absent in-process under Bun (added at send time) or a text/plain
    // variant under Node — never anything else.
    expect(ct === "" || ct.startsWith("text/plain")).toBe(true);
  });
});

describe("matrix: HEAD across body kinds", () => {
  const heads: [string, unknown, number][] = [
    ["string", "0123456789", 10],
    ["ascii html", "<h1>x</h1>", 10],
    ["utf8 string", "中文", 6],
    ["bytes", new Uint8Array([1, 2, 3]), 3],
    ["json object", { a: 1 }, 7],
  ];

  it.each(heads)("HEAD %s keeps Content-Length %d", async (_label, body, length) => {
    // Dual-mode commit path: Content-Length is backfilled from the would-be
    // body exactly like koa.
    const app = new Keala(quiet);
    app.get("/", (c) => {
      if (typeof body === "object" && body !== null && !(body instanceof Uint8Array)) {
        return c.json(body);
      }
      return c.text(body as string);
    });
    const res = await app.handle(new Request("http://localhost:3000/", { method: "HEAD" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(Number(res.headers.get("content-length"))).toBe(length);
  });

  it.each(heads)(
    "HEAD %s in bare state mode backfills Content-Length from the would-be body",
    async (_label, body, length) => {
      // koa contract: state-mode HEAD computes Content-Length from the
      // would-be body and drops the body itself — including the bare path
      // where the header record is materialized just for the backfill.
      const res = await respondWith(
        (c) => {
          c.body = body as never;
        },
        { method: "HEAD" },
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("");
      expect(Number(res.headers.get("content-length"))).toBe(length);
    },
  );

  it("HEAD state mode keeps Content-Length when other response headers exist", async () => {
    // With a pre-existing header record the backfilled length survives.
    const res = await respondWith(
      (c) => {
        c.set("X-A", "1");
        c.body = "0123456789";
      },
      { method: "HEAD" },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(res.headers.get("x-a")).toBe("1");
    expect(res.headers.get("content-length")).toBe("10");
  });
});

describe("matrix: explicit Content-Length interplay", () => {
  it("explicit length before body is recomputed from the body", async () => {
    let seen: number | undefined;
    const c = await captureCtx((ctx) => {
      ctx.length = 999;
      ctx.body = "abcde";
      seen = ctx.length;
    });
    expect(seen).toBe(5);
    expect(c.body).toBe("abcde");
    expect(c.has("Content-Length")).toBe(false);
  });

  it("explicit length after body wins verbatim", async () => {
    const res = await respondWith((c) => {
      c.body = "abcde";
      c.length = 42;
    });
    expect(res.headers.get("content-length")).toBe("42");
  });

  it.each([0, -0, Number.NaN])("length %p coerces to 0", async (value) => {
    const res = await respondWith((c) => {
      c.body = "abc";
      c.length = value;
    });
    expect(res.headers.get("content-length")).toBe("0");
  });
});

describe("matrix: content-type behavior per body kind (D1)", () => {
  it.each([
    ["object", { a: 1 }],
    ["array", [1, 2]],
    ["nested null field", { a: null }],
  ])("%s serializes as JSON with an application/json content-type", async (_label, body) => {
    let capturedType = "";
    const res = await respondWith((c) => {
      c.body = body as never;
      capturedType = c.type; // in-process: no framework content-type is set
    });
    expect(capturedType).toBe("");
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual(body);
  });

  it("plain strings are served as text (sniffing removed)", async () => {
    const res = await respondWith((c) => {
      c.body = "just text";
    });
    const ct = res.headers.get("content-type") ?? "";
    // D1: absent in-process under Bun (added at send time) or a text/plain
    // variant under Node — never anything else.
    expect(ct === "" || ct.startsWith("text/plain")).toBe(true);
    expect(ct).not.toContain("text/html");
    expect(await res.text()).toBe("just text");
  });

  it("markup strings are served as text too (koa sniffed them to text/html)", async () => {
    const res = await respondWith((c) => {
      c.body = "<p>x</p>";
    });
    const ct = res.headers.get("content-type") ?? "";
    // D1: absent in-process under Bun (added at send time) or a text/plain
    // variant under Node — never anything else.
    expect(ct === "" || ct.startsWith("text/plain")).toBe(true);
    expect(ct).not.toContain("text/html");
    expect(await res.text()).toBe("<p>x</p>");
  });

  it("bytes and streams carry no framework content-type (inference removed)", async () => {
    for (const body of [
      new Uint8Array(4),
      new ReadableStream({
        start(c) {
          c.close();
        },
      }),
    ]) {
      const res = await respondWith((c) => {
        c.body = body as never;
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(null);
    }
  });

  it("explicit type always wins over inference", async () => {
    const c = await captureCtx((ctx) => {
      ctx.type = "application/x-custom";
      ctx.body = "<p>markup</p>";
      expect(ctx.resHeader("Content-Type")).toBe("application/x-custom");
    });
    expect(c.resHeader("Content-Type")).toBe("application/x-custom");
  });
});

describe("matrix: redirect status preservation", () => {
  const redirectCodes = [300, 301, 302, 303, 307, 308];
  it.each(redirectCodes)("redirect keeps explicit %d", async (code) => {
    const res = await respondWith((c) => {
      c.status = code;
      c.redirect("/next");
    });
    expect(res.status).toBe(code);
    expect(res.headers.get("location")).toBe("/next");
  });

  it.each([200, 201, 400, 404])("non-redirect %d becomes 302", async (code) => {
    const res = await respondWith((c) => {
      c.status = code;
      c.redirect("/next");
    });
    expect(res.status).toBe(302);
  });
});

describe("matrix: vary dedupe and ordering", () => {
  it.each([
    [[["a"], ["b"]], "a, b"],
    [[["a"], ["A"]], "a"],
    [[["a"], ["b"], ["a"]], "a, b"],
    [[["Origin"], ["origin"], ["Accept-Encoding"]], "Origin, Accept-Encoding"],
  ])("vary %p → %s", async (stages, expected) => {
    const res = await respondWith((c) => {
      for (const stage of stages as string[][]) for (const field of stage) c.vary(field);
      c.body = "ok";
    });
    expect(res.headers.get("vary")).toBe(expected);
  });
});

describe("matrix: toJSON snapshots", () => {
  it("toJSON reflects the state at call time (headers, status, message)", async () => {
    const c = await captureCtx((ctx) => {
      ctx.status = 201;
      const before = ctx.toJSON() as { headers: Record<string, string> };
      ctx.set("X-Step", "2");
      const after = ctx.toJSON() as {
        headers: Record<string, string>;
        status: number;
        message: string;
      };
      expect(before.headers["x-step"]).toBeUndefined();
      expect(after.headers["x-step"]).toBe("2");
      expect(after.status).toBe(201);
      expect(after.message).toBe("Created");
    });
    expect(c.toJSON()["status"]).toBe(201);
  });

  it("toJSON captures method/url/header from the request side", async () => {
    const app = new Keala(quiet);
    let json: Record<string, unknown> | undefined;
    app.use((c) => {
      json = c.toJSON();
      c.body = "ok";
    });
    await app.handle(new Request("http://localhost:3000/a/b?c=1", { headers: { "X-P": "yes" } }));
    expect(json?.["method"]).toBe("GET");
    expect(json?.["url"]).toBe("/a/b?c=1");
    const header = (json?.["header"] ?? {}) as Record<string, string>;
    expect(header["x-p"]).toBe("yes");
  });
});
