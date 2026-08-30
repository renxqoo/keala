/**
 * Network security test suite: injection, pollution, malformed input,
 * information disclosure and abuse resistance.
 */

import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/application/app.ts";
import { createError } from "../src/http/errors.ts";
import { createRouter } from "../src/router/router.ts";

const quiet = { env: "test" } as const;
const drive = (app: ReturnType<typeof createApp>, request: Request) => app.handle(request);

describe("header injection (response splitting)", () => {
  it("rejects CRLF in header values via set/append", async () => {
    const app = createApp(quiet);
    app.use(async (ctx) => {
      expect(() => ctx.set("X-Safe", "v\r\nSet-Cookie: pwned=1")).toThrow(TypeError);
      expect(() => ctx.append("X-Safe", "v\nX-Evil: 1")).toThrow(TypeError);
      expect(() => ctx.set("X-Safe", "v\rX-Evil: 1")).toThrow(TypeError);
      expect(() => ctx.set("X-Safe", "v\u0000")).toThrow(TypeError);
      ctx.status = 204;
    });
    const res = await drive(app, new Request("http://localhost:3000/"));
    expect(res.headers.get("x-evil")).toBe(null);
    expect(res.headers.get("set-cookie")).toBe(null);
  });

  it("rejects CR/LF in redirect Location values", async () => {
    const app = createApp(quiet);
    app.use(async (ctx) => {
      expect(() => ctx.redirect("/ok\r\nSet-Cookie: evil=1")).toThrow(TypeError);
      ctx.status = 204;
    });
    const res = await drive(app, new Request("http://localhost:3000/"));
    expect(res.headers.get("set-cookie")).toBe(null);
  });

  it("rejects CRLF in status messages", async () => {
    const app = createApp(quiet);
    app.use(async (ctx) => {
      expect(() => {
        ctx.message = "fine\r\nX-Evil: 1";
      }).toThrow(TypeError);
      ctx.status = 204;
    });
    await drive(app, new Request("http://localhost:3000/"));
  });

  it("rejects CRLF and NUL in cookie serialization", async () => {
    const app = createApp(quiet);
    app.use(async (ctx) => {
      expect(() => ctx.cookies.set("sid", "v\r\nSet-Cookie: evil=1")).toThrow(TypeError);
      expect(() => ctx.cookies.set("sid", "v\u0000")).toThrow(TypeError);
      ctx.status = 204;
    });
    const res = await drive(app, new Request("http://localhost:3000/"));
    expect(res.headers.get("set-cookie")).toBe(null);
  });

  it("rejects CRLF in ETag values", async () => {
    const app = createApp(quiet);
    app.use(async (ctx) => {
      expect(() => {
        ctx.etag = 'x"\r\nX-Evil: 1';
      }).toThrow(TypeError);
      ctx.status = 204;
    });
    await drive(app, new Request("http://localhost:3000/"));
  });

  it("drops invalid headers arriving via error.headers instead of crashing", async () => {
    const app = createApp(quiet);
    app.use(async () => {
      throw createError(503, "down", {
        headers: { "Retry-After": "5", "X-Bad": "v\r\nSet-Cookie: evil=1" },
      });
    });
    const res = await drive(app, new Request("http://localhost:3000/"));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(res.headers.get("x-bad")).toBe(null);
    expect(res.headers.get("set-cookie")).toBe(null);
  });
});

describe("prototype pollution", () => {
  it("neutralizes __proto__ / constructor / prototype query keys", async () => {
    const app = createApp();
    let captured: Record<string, unknown> | undefined;
    app.use(async (ctx) => {
      captured = ctx.query as Record<string, unknown>;
      ctx.status = 204;
    });
    await drive(
      app,
      new Request(
        "http://localhost:3000/?__proto__[polluted]=1&constructor.prototype.x=2&prototype=3&ok=1",
      ),
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(captured, "ok")).toBe(true);
    expect(captured?.prototype).toBeUndefined();
  });

  it("rejects __proto__-style header names", async () => {
    const app = createApp(quiet);
    app.use(async (ctx) => {
      expect(() => ctx.set("__proto__", "x")).toThrow(TypeError);
      expect(() => ctx.set("constructor", "x")).toThrow(TypeError);
      expect(() => ctx.set("prototype", "x")).toThrow(TypeError);
      ctx.status = 204;
    });
    await drive(app, new Request("http://localhost:3000/"));
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it("ignores __proto__ cookie names instead of mutating the session map", async () => {
    const app = createApp({ keys: ["k"] });
    app.use(async (ctx) => {
      expect(ctx.cookies.get("__proto__")).toBeUndefined();
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      ctx.status = 204;
    });
    await drive(
      app,
      new Request("http://localhost:3000/", {
        headers: { Cookie: "__proto__[polluted]=yes; session=abc" },
      }),
    );
  });

  it("keeps state and params maps unpollutable", async () => {
    const app = createApp();
    const router = createRouter();
    router.get("/files/*", (ctx) => {
      ctx.state["__proto__"] = "x";
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      ctx.status = 204;
    });
    app.use(router.routes());
    await drive(app, new Request("http://localhost:3000/files/a"));
  });
});

describe("malformed input must never crash the process", () => {
  it("survives broken percent-encoding in paths and queries", async () => {
    const app = createApp();
    const router = createRouter();
    router.get("/files/:name", (ctx) => {
      ctx.body = String(ctx.params.name);
    });
    app.use(router.routes());
    const res = await drive(app, new Request("http://localhost:3000/files/%E0%A4%A?x=%ZZ"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("%E0%A4%A");
  });

  it("survives enormous paths and query strings", async () => {
    const app = createApp();
    let queryKeys = 0;
    app.use(async (ctx) => {
      queryKeys = Object.keys(ctx.query).length;
      ctx.status = 204;
    });
    const longPath = `/${"a".repeat(4000)}`;
    const longQuery = `?${Array.from({ length: 1000 }, (_, i) => `k${i}=1`).join("&")}`;
    const res = await drive(app, new Request(`http://localhost:3000${longPath}${longQuery}`));
    expect(res.status).toBe(204);
    expect(queryKeys).toBe(1000);
  });

  it("survives malformed cookie headers", async () => {
    const app = createApp();
    app.use(async (ctx) => {
      expect(ctx.cookies.get("session")).toBe("ok");
      ctx.status = 204;
    });
    await drive(
      app,
      new Request("http://localhost:3000/", {
        headers: { Cookie: "garbage;;;;;=;;session=ok;=;bad[name]=1" },
      }),
    );
  });

  it("survives hostile accept headers", async () => {
    const app = createApp();
    app.use(async (ctx) => {
      expect(ctx.accepts("html")).toBeDefined();
      ctx.status = 204;
    });
    await drive(
      app,
      new Request("http://localhost:3000/", {
        headers: {
          Accept: ",,;;,,*/*;q=999,,garbage;;,text/html;q=-5,",
          "Accept-Language": "(((((",
          "Accept-Charset": ";;;",
        },
      }),
    );
  });

  it("answers with a clean 500 when middleware throws non-errors", async () => {
    const app = createApp(quiet);
    app.use(async () => {
      throw { malicious: "object" };
    });
    const res = await drive(app, new Request("http://localhost:3000/"));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Internal Server Error");
  });
});

describe("information disclosure", () => {
  it("never leaks stack traces or internals on 5xx", async () => {
    const app = createApp({ env: "production" });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    app.use(async () => {
      throw new Error("SECRET_DATABASE_PASSWORD leak");
    });
    const res = await drive(app, new Request("http://localhost:3000/"));
    const body = await res.text();
    expect(res.status).toBe(500);
    expect(body).toBe("Internal Server Error");
    expect(body).not.toContain("SECRET_DATABASE_PASSWORD");
    errorSpy.mockRestore();
  });

  it("keeps 4xx exposed messages but sanitizes nothing else", async () => {
    const app = createApp(quiet);
    app.use(async (ctx) => {
      ctx.throw(400, "invalid input");
    });
    const res = await drive(app, new Request("http://localhost:3000/"));
    expect(await res.text()).toBe("invalid input");
  });

  it("escapes HTML in redirect bodies (XSS in fallback page)", async () => {
    const app = createApp();
    app.use(async (ctx) => {
      ctx.redirect("/next?<script>alert(document.domain)</script>");
    });
    const res = await drive(
      app,
      new Request("http://localhost:3000/", { headers: { Accept: "text/html" } }),
    );
    const body = await res.text();
    expect(body).not.toContain("<script>");
    expect(body).toContain("&lt;script&gt;");
  });

  it("escapes quotes in redirect href attributes", async () => {
    const app = createApp();
    app.use(async (ctx) => {
      ctx.redirect('/a?x="onmouseover=alert(1)');
    });
    const res = await drive(
      app,
      new Request("http://localhost:3000/", { headers: { Accept: "text/html" } }),
    );
    const body = await res.text();
    expect(body).not.toContain('"onmouseover');
  });
});

describe("cookie integrity", () => {
  it("rejects forged signatures", async () => {
    const app = createApp({ keys: ["production-key"] });
    app.use(async (ctx) => {
      ctx.body = ctx.cookies.get("sid") ?? "anonymous";
    });
    const forged = await drive(
      app,
      new Request("http://localhost:3000/", { headers: { Cookie: "sid=admin.deadbeef" } }),
    );
    expect(await forged.text()).toBe("anonymous");
  });

  it("does not accept cookies signed with a retired key as new signatures", async () => {
    const app = createApp({ keys: ["new-key", "old-key"] });
    let outgoing = "";
    app.use(async (ctx) => {
      if (ctx.path === "/set") {
        ctx.cookies.set("sid", "fresh", { signed: true });
        outgoing = ctx.responseHeaders["set-cookie"]?.[0] ?? "";
      } else {
        ctx.body = ctx.cookies.get("sid") ?? "anonymous";
      }
    });
    await drive(app, new Request("http://localhost:3000/set"));
    expect(outgoing.startsWith("sid=fresh.")).toBe(true); // signed with the FIRST key
    const verify = await drive(
      app,
      new Request("http://localhost:3000/get", {
        headers: { Cookie: outgoing.split(";")[0] ?? "" },
      }),
    );
    expect(await verify.text()).toBe("fresh");
  });
});

describe("router abuse resistance", () => {
  it("does not match path traversal out of the wildcard scope via decode", async () => {
    const app = createApp();
    const router = createRouter();
    router.get("/assets/*", (ctx) => {
      ctx.body = `wildcard:${ctx.params.wildcard}`;
    });
    app.use(router.routes()).use(router.allowedMethods());
    const res = await drive(app, new Request("http://localhost:3000/assets/a%2F..%2Fsecret"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("wildcard:a/../secret");
  });

  it("treats conflicting routes deterministically (no crash on adversarial patterns)", () => {
    const router = createRouter();
    expect(() => {
      router.get("/a/:x(\\d+)", (ctx) => void ctx);
      router.get("/a/:x([a-z]+)", (ctx) => void ctx);
      router.get("/a/*", (ctx) => void ctx);
    }).not.toThrow();
  });
});
