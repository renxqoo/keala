/**
 * Response behavior matrix: body kinds x status families x HEAD x messages,
 * plus the exact bytes/headers the runtime produces.
 *
 * migration notes:
 *  - Markup sniffing and the bytes/stream → application/octet-stream
 *    inference are gone (D1): string bodies carry no framework content-type
 *    (the runtime provides a text/plain variant); binary bodies carry none.
 *  - HEAD: the Content-Length contract is carried by the sugar
 *    (`c.text()`/`c.json()`) path, which builds the HEAD view at
 *    construction; a returned `new Response(...)` strips the body WITHOUT
 *    backfilling Content-Length (§2.3-3, deliberate U3c change).
 *  - U3c: the state-mode response setters are gone — the matrix runs on the
 *    return-style/sugar surface. Empty statuses (204/205/304) are cleaned
 *    unconditionally (§2.3-2): no body, no content-describing headers.
 */

import { describe, expect, it } from "vitest";

import { Keala, type Context } from "../../src/index.ts";
import { statusMessage } from "../../src/http/status.ts";

const quiet = { env: "test" } as const;

const respondWith = async (
  setup: (c: Context) => unknown,
  init?: RequestInit,
): Promise<Response> => {
  const app = new Keala(quiet);
  // Propagate setup's return (U3a: `return c.redirect(...)` inside setup must
  // become the handler's answer).
  app.get("/", (c) => setup(c) as Response | undefined);
  return app.handle(new Request("http://localhost:3000/", init)) as Promise<Response>;
};

const captureCtx = async (setup: (c: Context) => unknown): Promise<Context> => {
  let captured: Context | undefined;
  const app = new Keala(quiet);
  app.use(async (c) => {
    captured = c;
    return setup(c) as Response | undefined;
  });
  await app.handle(new Request("http://localhost:3000/"));
  if (captured === undefined) throw new Error("probe failed");
  return captured;
};

describe("matrix: body kinds x explicit empty statuses", () => {
  // U3c: the old state-mode matrix staged `c.body = X; c.status = 204`. The
  // sugar path is the surviving expression: its explicit status parameter
  // drives the same empty-status contract (no body, no content headers).
  const bodies: [string, unknown][] = [
    ["text", "hello"],
    ["markup", "<b>hi</b>"],
    ["object", { ok: true }],
  ];

  it.each(bodies)("body %s + 204 → empty response", async (_label, body) => {
    const res = await respondWith((c) =>
      typeof body === "string" ? c.text(body, 204) : c.json(body, 204),
    );
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(res.headers.get("content-type")).toBe(null);
    expect(res.headers.get("content-length")).toBe(null);
  });

  it.each([204, 304])(
    "status %s keeps unrelated headers while clearing content headers",
    async (status) => {
      const res = await respondWith((c) => {
        c.setHeader("Content-Length", "99");
        c.setHeader("X-Keep", "1");
        return c.text("payload", status);
      });
      expect(res.status).toBe(status);
      expect(res.headers.get("x-keep")).toBe("1");
      expect(res.headers.get("content-type")).toBe(null);
      expect(res.headers.get("content-length")).toBe(null);
    },
  );

  it.each([204, 304])(
    "status %s clears the body and content headers in-process",
    async (status) => {
      const c = await captureCtx((ctx) => {
        ctx.setHeader("Content-Length", "99");
        ctx.setHeader("X-Keep", "1");
        return ctx.text("payload", status);
      });
      // U3c: the body read is gone — the committed sugar answer carries the
      // verdict (post-commit reads fall back to its headers).
      expect(c.has("Content-Type")).toBe(false);
      expect(c.has("Content-Length")).toBe(false);
      expect(c.has("X-Keep")).toBe(true);
    },
  );

  // U3c deletions (mapping #8/#9): the two staged-ordering locks — "status
  // set before body suppresses the body" / "status set after body" — locked
  // the deleted setters' write-order interplay. The sugar's status parameter
  // has no ordering dimension; the empty-status verdict itself is locked by
  // the tests above.
});

describe("matrix: missing body per status family (koa respond semantics)", () => {
  const cases: [number, string][] = [
    [200, "OK"],
    [201, "Created"],
    [202, "Accepted"],
    [400, "Bad Request"],
    [404, "Not Found"],
    [410, "Gone"],
    [418, "I'm a teapot"],
    [500, "Internal Server Error"],
    [503, "Service Unavailable"],
    [599, "599"],
  ];
  it.each(cases)("status %d → %j body", async (status, expected) => {
    // The documented U3c idiom for a status-only answer (§2.2 mapping):
    // `return c.text(statusMessage(N) || String(N), N)`.
    const res = await respondWith((c) => c.text(statusMessage(status) || String(status), status));
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
    // Sugar path: Content-Length is backfilled from the would-be body at
    // construction — the koa contract survives here (§2.3-3).
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
    "HEAD %s via a returned Response strips the body and does NOT backfill Content-Length",
    async (_label, body, _length) => {
      // §2.3-3 deliberate U3c change: state-mode HEAD (with its would-be
      // body backfill) is gone. A returned `new Response(...)` is stripped
      // by the finalizer — no would-be value exists to measure.
      const res = await respondWith(
        () =>
          new Response(
            typeof body === "string"
              ? body
              : body instanceof Uint8Array
                ? body
                : JSON.stringify(body),
          ),
        { method: "HEAD" },
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("");
      expect(res.headers.get("content-length")).toBe(null);
    },
  );

  it("HEAD on the sugar path keeps Content-Length when other response headers exist", async () => {
    const res = await respondWith(
      (c) => {
        c.setHeader("X-A", "1");
        return c.text("0123456789");
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
  // U3c deletions (mapping #4, lossy): "explicit length before body is
  // recomputed from the body" and "length %p coerces to 0" locked the deleted
  // `c.length` setter's recompute/coercion semantics. `c.setHeader(
  // "Content-Length", ...)` is verbatim — the caller owns the value.
  it("a staged Content-Length rides the sugar answer verbatim", async () => {
    const res = await respondWith((c) => {
      c.setHeader("Content-Length", "42");
      return c.text("abcde");
    });
    expect(res.headers.get("content-length")).toBe("42");
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
      // U3c: c.type is gone — the staged-header read is the pre-commit view.
      capturedType = c.resHeader("Content-Type"); // in-process: nothing staged
      return c.json(body);
    });
    expect(capturedType).toBe("");
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual(body);
  });

  it("plain strings are served as text (sniffing removed)", async () => {
    const res = await respondWith((c) => c.text("just text"));
    const ct = res.headers.get("content-type") ?? "";
    // D1: absent in-process under Bun (added at send time) or a text/plain
    // variant under Node — never anything else.
    expect(ct === "" || ct.startsWith("text/plain")).toBe(true);
    expect(ct).not.toContain("text/html");
    expect(await res.text()).toBe("just text");
  });

  it("markup strings are served as text too (koa sniffed them to text/html)", async () => {
    const res = await respondWith((c) => c.text("<p>x</p>"));
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
      const res = await respondWith(() => new Response(body));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(null);
    }
  });

  it("explicit type always wins over inference", async () => {
    const c = await captureCtx((ctx) => {
      // U3c: c.type is gone — an explicit Content-Type header is the lossy
      // mapping, and the sugar honors it over its own default.
      ctx.setHeader("Content-Type", "application/x-custom");
      expect(ctx.resHeader("Content-Type")).toBe("application/x-custom");
      return ctx.text("<p>markup</p>");
    });
    expect(c.resHeader("Content-Type")).toBe("application/x-custom");
  });
});

describe("matrix: redirect status preservation", () => {
  const redirectCodes = [300, 301, 302, 303, 307, 308];
  it.each(redirectCodes)("redirect keeps explicit %d", async (code) => {
    const res = await respondWith((c) => c.redirect("/next", code));
    expect(res.status).toBe(code);
    expect(res.headers.get("location")).toBe("/next");
  });

  it.each([200, 201, 400, 404])(
    "an explicit non-redirect %d is a loud TypeError, not a silent 302",
    async (code) => {
      // U3c: the old lock staged a non-3xx `c.status` and asserted redirect
      // coerced to 302. Staged status no longer exists; the explicit
      // parameter is validated loudly (response.ts redirect guard).
      const res = await respondWith((c) => c.redirect("/next", code));
      expect(res.status).toBe(500); // the TypeError escapes → error funnel
    },
  );

  it("no explicit code answers the 302 default", async () => {
    const res = await respondWith((c) => c.redirect("/next"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/next");
  });
});

describe("matrix: Vary via append (comma-joined, casing preserved)", () => {
  it.each([
    [[["a"], ["b"]], "a, b"],
    [[["a"], ["A"]], "a, A"],
    [[["Origin"], ["Accept-Encoding"]], "Origin, Accept-Encoding"],
  ])("append %p → %s", async (stages, expected) => {
    const res = await respondWith((c) => {
      for (const stage of stages as string[][]) for (const field of stage) c.append("Vary", field);
      return c.text("ok");
    });
    expect(res.headers.get("vary")).toBe(expected);
  });
});
