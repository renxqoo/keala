/**
 * Response behavior matrix: body kinds x status families x HEAD x messages,
 * plus the exact bytes/headers the runtime produces.
 */

import { describe, expect, it } from "vitest";

import { createApp } from "../src/application/app.ts";
import type { Context } from "../src/context/context.ts";

const quiet = { env: "test" } as const;

const respondWith = async (
  setup: (ctx: Context) => void,
  init?: RequestInit,
): Promise<Response> => {
  const app = createApp(quiet);
  app.use(async (ctx) => {
    setup(ctx);
  });
  return app.handle(new Request("http://localhost:3000/", init));
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
    const res = await respondWith((ctx) => {
      ctx.body = body as never;
      ctx.status = 204;
    });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(res.headers.get("content-type")).toBe(null);
    expect(res.headers.get("content-length")).toBe(null);
  });

  it.each(emptyStatuses)("status %s set before body suppresses the body", async (status) => {
    const res = await respondWith((ctx) => {
      ctx.status = status;
      ctx.body = "payload";
    });
    expect(res.status).toBe(status);
    expect(await res.text()).toBe("");
  });

  it.each(emptyStatuses)("status %s set after body suppresses the body", async (status) => {
    const res = await respondWith((ctx) => {
      ctx.body = "payload";
      ctx.status = status;
    });
    expect(await res.text()).toBe("");
  });
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
    const res = await respondWith((ctx) => {
      ctx.status = status;
      if (message) ctx.message = message;
    });
    expect(res.status).toBe(status);
    expect(await res.text()).toBe(expected);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
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
    const res = await respondWith(
      (ctx) => {
        ctx.body = body as never;
      },
      { method: "HEAD" },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(Number(res.headers.get("content-length"))).toBe(length);
  });
});

describe("matrix: explicit Content-Length interplay", () => {
  it("explicit length before body is recomputed from the body", async () => {
    const res = await respondWith((ctx) => {
      ctx.length = 999;
      ctx.body = "abcde";
    });
    const probe = createApp(quiet);
    let seen: number | undefined;
    probe.use(async (ctx) => {
      ctx.length = 999;
      ctx.body = "abcde";
      seen = ctx.response.length;
    });
    await probe.handle(new Request("http://localhost:3000/"));
    expect(seen).toBe(5);
    expect(res.status).toBe(200);
  });

  it("explicit length after body wins verbatim", async () => {
    const res = await respondWith((ctx) => {
      ctx.body = "abcde";
      ctx.length = 42;
    });
    expect(res.headers.get("content-length")).toBe("42");
  });

  it.each([0, -0, Number.NaN])("length %p coerces to 0", async (value) => {
    const res = await respondWith((ctx) => {
      ctx.body = "abc";
      ctx.length = value;
    });
    expect(res.headers.get("content-length")).toBe("0");
  });
});

describe("matrix: content-type inference table", () => {
  const rows: [string, unknown, string][] = [
    ["markup string", "<p>x</p>", "text/html; charset=utf-8"],
    ["plain string", "just text", "text/plain; charset=utf-8"],
    ["leading whitespace markup", "  <p>x</p>", "text/html; charset=utf-8"],
    ["tab-indented markup", "\t<b>y</b>", "text/html; charset=utf-8"],
    ["newline then markup", "\n<i>z</i>", "text/html; charset=utf-8"],
    ["not markup after space", " x<y descriptions>", "text/plain; charset=utf-8"],
    ["object", { a: 1 }, "application/json; charset=utf-8"],
    ["array", [1, 2], "application/json; charset=utf-8"],
    ["nested null field", { a: null }, "application/json; charset=utf-8"],
    ["bytes", new Uint8Array(4), "application/octet-stream"],
    ["stream", null, "application/octet-stream"],
  ];
  it.each(rows)("%s → %s", async (_label, body, expected) => {
    let capturedType = "";
    const res = await respondWith((ctx) => {
      if (body === null) {
        ctx.body = new ReadableStream({
          start(c) {
            c.close();
          },
        });
      } else {
        ctx.body = body as never;
      }
      capturedType = ctx.response.get("Content-Type");
    });
    expect(capturedType).toBe(expected);
    expect(res.status).toBe(200);
  });

  it("explicit type always wins over inference", async () => {
    await respondWith((ctx) => {
      ctx.type = "application/x-custom";
      ctx.body = "<p>markup</p>";
      expect(ctx.response.get("Content-Type")).toBe("application/x-custom");
    });
  });
});

describe("matrix: redirect status preservation", () => {
  const redirectCodes = [300, 301, 302, 303, 307, 308];
  it.each(redirectCodes)("redirect keeps explicit %d", async (code) => {
    const res = await respondWith((ctx) => {
      ctx.status = code;
      ctx.redirect("/next");
    });
    expect(res.status).toBe(code);
    expect(res.headers.get("location")).toBe("/next");
  });

  it.each([200, 201, 400, 404])("non-redirect %d becomes 302", async (code) => {
    const res = await respondWith((ctx) => {
      ctx.status = code;
      ctx.redirect("/next");
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
    const res = await respondWith((ctx) => {
      for (const stage of stages as string[][]) for (const field of stage) ctx.vary(field);
      ctx.body = "ok";
    });
    expect(res.headers.get("vary")).toBe(expected);
  });
});

describe("matrix: toJSON snapshots", () => {
  it("response toJSON reflects state at call time", async () => {
    await respondWith((ctx) => {
      ctx.status = 201;
      const before = ctx.response.toJSON();
      ctx.set("X-Step", "2");
      const after = ctx.response.toJSON();
      expect(before.headers["x-step"]).toBeUndefined();
      expect(after.headers["x-step"]).toBe("2");
      expect(after.status).toBe(201);
      expect(after.message).toBe("Created");
    });
  });

  it("request toJSON captures method/url/header", async () => {
    const app = createApp(quiet);
    let json: { method: string; url: string; header: Record<string, string> } | undefined;
    app.use(async (ctx) => {
      json = ctx.request.toJSON();
      ctx.status = 204;
    });
    await app.handle(new Request("http://localhost:3000/a/b?c=1", { headers: { "X-P": "yes" } }));
    expect(json?.method).toBe("GET");
    expect(json?.url).toBe("/a/b?c=1");
    expect(json?.header["x-p"]).toBe("yes");
  });
});
