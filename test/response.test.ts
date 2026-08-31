import { describe, expect, it } from "vitest";

import { Eleu } from "../src/index.ts";

const makeApp = () => new Eleu({ env: "test" });

describe("response facade (flat context)", () => {
  it("starts as 404 with no body", async () => {
    const app = makeApp();
    app.use(async (c) => {
      expect(c.status).toBe(404);
      expect(c.body).toBe(null);
      expect(c.headerSent).toBe(false);
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not Found");
  });

  it("validates status codes", async () => {
    const app = makeApp();
    app.use(async (c) => {
      expect(() => {
        c.status = 700;
      }).toThrow(TypeError);
      expect(() => {
        c.status = 404.5;
      }).toThrow(TypeError);
      c.status = 201;
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(201);
  });

  it("sets status message", async () => {
    const app = makeApp();
    app.use(async (c) => {
      c.status = 200;
      c.message = "all good";
      c.body = "x";
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(200);
    expect(res.statusText).toBe("all good");
  });

  it("rejects CR/LF in status message", async () => {
    const app = makeApp();
    app.use(async (c) => {
      expect(() => {
        c.message = "bad\r\nmessage";
      }).toThrow(TypeError);
      c.body = "ok";
    });
    await app.handle(new Request("http://localhost:3000/"));
  });

  it("delivers string bodies verbatim with a runtime text content-type (markup sniffing removed)", async () => {
    // D1 divergence: c.body = string no longer sniffs markup — no
    // content-type is recorded in-process and the wire type comes from the
    // fetch runtime (text/plain for strings).
    const app = makeApp();
    let sawType = "";
    app.use(async (c, next) => {
      await next();
      sawType = c.type;
    });
    app.use(async (c) => {
      c.body = "<h1>hello</h1>";
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(sawType).toBe("");
    expect(await res.text()).toBe("<h1>hello</h1>");
    const htmlType = res.headers.get("content-type") ?? "";
    expect(htmlType === "" || htmlType.startsWith("text/plain")).toBe(true);

    const plain = makeApp();
    plain.use(async (c) => {
      c.body = "plain words";
    });
    const plainRes = await plain.handle(new Request("http://localhost:3000/"));
    const plainType = plainRes.headers.get("content-type") ?? "";
    expect(plainType === "" || plainType.startsWith("text/plain")).toBe(true);
  });

  it("JSON-serializes object bodies via Response.json", async () => {
    const app = makeApp();
    app.use(async (c) => {
      c.body = { users: [1, 2, 3] };
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect((res.headers.get("content-type") ?? "").split(";")[0]).toBe("application/json");
    expect(await res.json()).toEqual({ users: [1, 2, 3] });
  });

  it("supports binary bodies", async () => {
    const app = makeApp();
    app.use(async (c) => {
      c.body = new Uint8Array([1, 2, 3]);
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    // D1: no octet-stream sniffing — the body passes through untouched.
    expect(res.headers.get("content-type")).toBe(null);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("supports stream bodies", async () => {
    const app = makeApp();
    app.use(async (c) => {
      c.body = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode("chunked"));
          controller.close();
        },
      });
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(await res.text()).toBe("chunked");
  });

  it("null body maps to 204 (or keeps empty statuses)", async () => {
    const app = makeApp();
    app.use(async (c) => {
      c.body = "temp";
      c.body = null;
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(204);
    expect(res.headers.get("content-type")).toBe(null);

    const keep304 = makeApp();
    keep304.use(async (c) => {
      c.status = 304;
      c.body = null;
    });
    const notModified = await keep304.handle(new Request("http://localhost:3000/"));
    expect(notModified.status).toBe(304);
  });

  it("keeps an explicit status when body is set", async () => {
    const app = makeApp();
    app.use(async (c) => {
      c.status = 201;
      c.body = { ok: true };
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(201);
  });

  it("strips content headers for 204/304", async () => {
    const app = makeApp();
    app.use(async (c) => {
      c.body = "will be dropped";
      c.status = 204;
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(204);
    expect(res.headers.get("content-type")).toBe(null);
    expect(res.headers.get("content-length")).toBe(null);
    expect(await res.text()).toBe("");
  });

  // CONFIRMED-BUG (core): the HEAD Content-Length backfill is lost whenever
  // the request produced NO other response headers. fromState reads the header
  // record into a local `const record` up front (src/core/respond.ts fromState,
  // `const record = c.headersRecord`); the HEAD backfill then assigns a FRESH
  // record via `(record ?? (c.headersRecord = {}))["content-length"] = ...`,
  // but hasRecord/multiValue/the serialization all still consult the stale
  // null local, so the bare fast path returns `new Response(null)` and the
  // backfilled "12" never reaches the wire. With any prior header (e.g. a
  // c.set call) the local is non-null and the backfill survives.
  // Expected (koa): HEAD keeps status 200, Content-Length "12", empty body.
  it("CONFIRMED-BUG: drops the body for HEAD requests", async () => {
    const app = makeApp();
    app.use(async (c) => {
      c.body = "body-content";
    });
    const res = await app.handle(new Request("http://localhost:3000/", { method: "HEAD" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("12");
    expect(await res.text()).toBe("");
  });

  it("set/append/remove/vary header operations", async () => {
    const app = makeApp();
    app.use(async (c) => {
      c.set("X-One", "1");
      c.set("x-one", "override");
      c.append("X-Many", "a");
      c.append("X-Many", "b");
      c.vary("Origin");
      c.vary("origin");
      c.vary("Accept");
      c.remove("x-one");
      c.body = "ok";
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.headers.get("x-one")).toBe(null);
    expect(res.headers.get("x-many")).toBe("a, b");
    expect(res.headers.get("vary")).toBe("Origin, Accept");
  });

  it("rejects invalid header field names and values", async () => {
    const app = makeApp();
    app.use(async (c) => {
      expect(() => c.set("Bad Name", "v")).toThrow(TypeError);
      expect(() => c.set("X-Ok", "v\r\nInjected: 1")).toThrow(TypeError);
      expect(() => c.vary("Origin, Accept")).toThrow(TypeError);
      c.body = "ok";
    });
    await app.handle(new Request("http://localhost:3000/"));
  });

  it("type setter and getter", async () => {
    const app = makeApp();
    app.use(async (c) => {
      c.type = "application/xml; charset=utf-8";
      expect(c.type).toBe("application/xml");
      c.body = "<x/>";
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.headers.get("content-type")).toBe("application/xml; charset=utf-8");
  });

  it("etag quoting and lastModified validation", async () => {
    const app = makeApp();
    app.use(async (c) => {
      c.etag = "abc";
      expect(c.etag).toBe('"abc"');
      c.etag = '"quoted"';
      expect(c.etag).toBe('"quoted"');
      c.lastModified = new Date(Date.UTC(2024, 5, 1));
      expect(c.lastModified?.toISOString()).toBe("2024-06-01T00:00:00.000Z");
      expect(() => {
        c.lastModified = "nope" as unknown as Date;
      }).toThrow(TypeError);
      c.body = "ok";
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.headers.get("etag")).toBe('"quoted"');
    expect(res.headers.get("last-modified")).toBe("Sat, 01 Jun 2024 00:00:00 GMT");
  });

  it("etag removal on empty value", async () => {
    const app = makeApp();
    app.use(async (c) => {
      c.etag = "temp";
      c.etag = "";
      c.body = "ok";
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.headers.get("etag")).toBe(null);
  });

  it("redirect sets location and html fallback body", async () => {
    const app = makeApp();
    app.use(async (c) => {
      c.redirect("/target?x=1");
    });
    const res = await app.handle(
      new Request("http://localhost:3000/", {
        headers: { Accept: "text/html" },
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/target?x=1");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toContain("Redirecting to /target?x=1.");

    const plain = makeApp();
    plain.use(async (c) => {
      c.redirect("/t");
    });
    const plainRes = await plain.handle(
      new Request("http://localhost:3000/", { headers: { Accept: "text/plain" } }),
    );
    expect(plainRes.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await plainRes.text()).toContain("Redirecting to /t.");
  });

  it("redirect supports back with referrer and alt fallback", async () => {
    const app = makeApp();
    app.use(async (c) => {
      c.redirect("back", "/fallback");
    });
    const withReferrer = await app.handle(
      new Request("http://localhost:3000/", { headers: { Referrer: "http://x.dev/prev" } }),
    );
    // Hardening divergence from koa: BOTH back spellings gate the Referrer
    // on same-origin — a cross-origin Referrer falls back to alt instead of
    // being forwarded verbatim (open-redirect defense).
    expect(withReferrer.headers.get("location")).toBe("/fallback");
    const sameOrigin = await app.handle(
      new Request("http://localhost:3000/", {
        headers: { Referrer: "http://localhost:3000/prev" },
      }),
    );
    expect(sameOrigin.headers.get("location")).toBe("http://localhost:3000/prev");

    const plain = makeApp();
    plain.use(async (c) => {
      c.redirect("back");
    });
    const res = await plain.handle(new Request("http://localhost:3000/"));
    expect(res.headers.get("location")).toBe("/");
  });

  it("keeps an explicit redirect status", async () => {
    const app = makeApp();
    app.use(async (c) => {
      c.status = 301;
      c.redirect("/gone");
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(301);
  });

  it("escapes html in redirect bodies", async () => {
    const app = makeApp();
    app.use(async (c) => {
      c.redirect("/a?next=<script>alert(1)</script>");
    });
    const res = await app.handle(
      new Request("http://localhost:3000/", { headers: { Accept: "text/html" } }),
    );
    const body = await res.text();
    expect(body).not.toContain("<script>");
    expect(body).toContain("&lt;script&gt;");
  });

  it("attachment sets content-disposition and infers type", async () => {
    const app = makeApp();
    app.use(async (c) => {
      c.attachment("report.pdf");
      c.body = "binary-ish";
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="report.pdf"');
    expect(res.headers.get("content-type")).toBe("application/pdf");
  });

  it("attachment without filename", async () => {
    const app = makeApp();
    app.use(async (c) => {
      c.attachment();
      c.body = "x";
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.headers.get("content-disposition")).toBe("attachment");
  });

  it("attachment rejects path separators in fallback", async () => {
    const app = makeApp();
    app.use(async (c) => {
      expect(() => c.attachment("报表.bin", { fallback: "a/b" })).toThrow(TypeError);
      c.body = "ok";
    });
    await app.handle(new Request("http://localhost:3000/"));
  });

  it("length setter coerces numbers", async () => {
    const app = makeApp();
    app.use(async (c) => {
      c.length = "42" as unknown as number;
      expect(c.length).toBe(42);
      c.length = Number.NaN;
      expect(c.length).toBe(0);
      c.body = "ok";
    });
    await app.handle(new Request("http://localhost:3000/"));
  });
});
