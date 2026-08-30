import { describe, expect, it } from "vitest";

import { createApp } from "../src/application/app.ts";

const makeApp = () => {
  const app = createApp();
  return app;
};

describe("response facade", () => {
  it("starts as 404 with no body", async () => {
    const app = makeApp();
    app.use(async (ctx) => {
      expect(ctx.status).toBe(404);
      expect(ctx.body).toBe(null);
      expect(ctx.headerSent).toBe(false);
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not Found");
  });

  it("validates status codes", async () => {
    const app = makeApp();
    app.use(async (ctx) => {
      expect(() => {
        ctx.status = 700;
      }).toThrow(TypeError);
      expect(() => {
        ctx.status = 404.5;
      }).toThrow(TypeError);
      ctx.status = 201;
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(201);
  });

  it("sets status message", async () => {
    const app = makeApp();
    app.use(async (ctx) => {
      ctx.status = 200;
      ctx.message = "all good";
      ctx.body = "x";
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(200);
    expect(res.statusText).toBe("all good");
  });

  it("rejects CR/LF in status message", async () => {
    const app = makeApp();
    app.use(async (ctx) => {
      expect(() => {
        ctx.message = "bad\r\nmessage";
      }).toThrow(TypeError);
      ctx.status = 204;
    });
    await app.handle(new Request("http://localhost:3000/"));
  });

  it("string bodies default to html only when markup is present", async () => {
    const app = makeApp();
    let sawHtmlType = "";
    let sawTextType = "";
    app.use(async (ctx, next) => {
      await next();
      sawHtmlType = ctx.type;
    });
    app.use(async (ctx) => {
      ctx.body = "<h1>hello</h1>";
      sawTextType = "";
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toBe("<h1>hello</h1>");
    expect(sawHtmlType).toBe("text/html");
    expect(sawTextType).toBe("");

    const plain = makeApp();
    plain.use(async (ctx) => {
      ctx.body = "plain words";
    });
    const plainRes = await plain.handle(new Request("http://localhost:3000/"));
    expect(plainRes.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });

  it("JSON-serializes object bodies", async () => {
    const app = makeApp();
    app.use(async (ctx) => {
      ctx.body = { users: [1, 2, 3] };
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await res.json()).toEqual({ users: [1, 2, 3] });
  });

  it("supports binary bodies", async () => {
    const app = makeApp();
    app.use(async (ctx) => {
      ctx.body = new Uint8Array([1, 2, 3]);
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("supports stream bodies", async () => {
    const app = makeApp();
    app.use(async (ctx) => {
      ctx.body = new ReadableStream({
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
    app.use(async (ctx) => {
      ctx.body = "temp";
      ctx.body = null;
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(204);
    expect(res.headers.get("content-type")).toBe(null);

    const keep304 = makeApp();
    keep304.use(async (ctx) => {
      ctx.status = 304;
      ctx.body = null;
    });
    const notModified = await keep304.handle(new Request("http://localhost:3000/"));
    expect(notModified.status).toBe(304);
  });

  it("keeps an explicit status when body is set", async () => {
    const app = makeApp();
    app.use(async (ctx) => {
      ctx.status = 201;
      ctx.body = { ok: true };
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(201);
  });

  it("strips content headers for 204/304", async () => {
    const app = makeApp();
    app.use(async (ctx) => {
      ctx.body = "will be dropped";
      ctx.status = 204;
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(204);
    expect(res.headers.get("content-type")).toBe(null);
    expect(res.headers.get("content-length")).toBe(null);
    expect(await res.text()).toBe("");
  });

  it("drops the body for HEAD requests", async () => {
    const app = makeApp();
    app.use(async (ctx) => {
      ctx.body = "body-content";
    });
    const res = await app.handle(new Request("http://localhost:3000/", { method: "HEAD" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("12");
    expect(await res.text()).toBe("");
  });

  it("set/append/remove/vary header operations", async () => {
    const app = makeApp();
    app.use(async (ctx) => {
      ctx.set("X-One", "1");
      ctx.set("x-one", "override");
      ctx.append("X-Many", "a");
      ctx.append("X-Many", "b");
      ctx.vary("Origin");
      ctx.vary("origin");
      ctx.vary("Accept");
      ctx.remove("x-one");
      ctx.body = "ok";
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.headers.get("x-one")).toBe(null);
    expect(res.headers.get("x-many")).toBe("a, b");
    expect(res.headers.get("vary")).toBe("Origin, Accept");
  });

  it("rejects invalid header field names and values", async () => {
    const app = makeApp();
    app.use(async (ctx) => {
      expect(() => ctx.set("Bad Name", "v")).toThrow(TypeError);
      expect(() => ctx.set("X-Ok", "v\r\nInjected: 1")).toThrow(TypeError);
      expect(() => ctx.vary("Origin, Accept")).toThrow(TypeError);
      ctx.status = 204;
    });
    await app.handle(new Request("http://localhost:3000/"));
  });

  it("type setter and getter", async () => {
    const app = makeApp();
    app.use(async (ctx) => {
      ctx.type = "application/xml; charset=utf-8";
      expect(ctx.type).toBe("application/xml");
      ctx.body = "<x/>";
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.headers.get("content-type")).toBe("application/xml; charset=utf-8");
  });

  it("etag quoting and lastModified validation", async () => {
    const app = makeApp();
    app.use(async (ctx) => {
      ctx.etag = "abc";
      expect(ctx.etag).toBe('"abc"');
      ctx.etag = '"quoted"';
      expect(ctx.etag).toBe('"quoted"');
      ctx.lastModified = new Date(Date.UTC(2024, 5, 1));
      expect(ctx.lastModified?.toISOString()).toBe("2024-06-01T00:00:00.000Z");
      expect(() => {
        ctx.lastModified = "nope" as unknown as Date;
      }).toThrow(TypeError);
      ctx.body = "ok";
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.headers.get("etag")).toBe('"quoted"');
    expect(res.headers.get("last-modified")).toBe("Sat, 01 Jun 2024 00:00:00 GMT");
  });

  it("etag removal on empty value", async () => {
    const app = makeApp();
    app.use(async (ctx) => {
      ctx.etag = "temp";
      ctx.etag = "";
      ctx.body = "ok";
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.headers.get("etag")).toBe(null);
  });

  it("redirect sets location and html fallback body", async () => {
    const app = makeApp();
    app.use(async (ctx) => {
      ctx.redirect("/target?x=1");
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
    plain.use(async (ctx) => {
      ctx.redirect("/t");
    });
    const plainRes = await plain.handle(
      new Request("http://localhost:3000/", { headers: { Accept: "text/plain" } }),
    );
    expect(plainRes.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await plainRes.text()).toContain("Redirecting to /t.");
  });

  it("redirect supports back with referrer and alt fallback", async () => {
    const app = makeApp();
    app.use(async (ctx) => {
      ctx.redirect("back", "/fallback");
    });
    const withReferrer = await app.handle(
      new Request("http://localhost:3000/", { headers: { Referrer: "http://x.dev/prev" } }),
    );
    expect(withReferrer.headers.get("location")).toBe("http://x.dev/prev");

    const plain = makeApp();
    plain.use(async (ctx) => {
      ctx.redirect("back");
    });
    const res = await plain.handle(new Request("http://localhost:3000/"));
    expect(res.headers.get("location")).toBe("/");
  });

  it("keeps an explicit redirect status", async () => {
    const app = makeApp();
    app.use(async (ctx) => {
      ctx.status = 301;
      ctx.redirect("/gone");
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(301);
  });

  it("escapes html in redirect bodies", async () => {
    const app = makeApp();
    app.use(async (ctx) => {
      ctx.redirect("/a?next=<script>alert(1)</script>");
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
    app.use(async (ctx) => {
      ctx.attachment("report.pdf");
      ctx.body = "binary-ish";
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="report.pdf"');
    expect(res.headers.get("content-type")).toBe("application/pdf");
  });

  it("attachment without filename", async () => {
    const app = makeApp();
    app.use(async (ctx) => {
      ctx.attachment();
      ctx.body = "x";
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.headers.get("content-disposition")).toBe("attachment");
  });

  it("attachment rejects path separators in fallback", async () => {
    const app = makeApp();
    app.use(async (ctx) => {
      expect(() => ctx.attachment("报表.bin", { fallback: "a/b" })).toThrow(TypeError);
      ctx.status = 204;
    });
    await app.handle(new Request("http://localhost:3000/"));
  });

  it("length setter coerces numbers", async () => {
    const app = makeApp();
    app.use(async (ctx) => {
      ctx.length = "42" as unknown as number;
      expect(ctx.response.length).toBe(42);
      ctx.length = Number.NaN;
      expect(ctx.response.length).toBe(0);
      ctx.status = 204;
    });
    await app.handle(new Request("http://localhost:3000/"));
  });
});
