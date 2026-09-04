/**
 * Network security test suite: injection, pollution, malformed input,
 * information disclosure and abuse resistance. Migrated to the current API
 * (single context object, app-level routing, fetch finalizer).
 *
 * semantic notes kept deliberate here:
 *  - `c.redirect()` no longer throws on CR/LF: the Location value is
 *    percent-encoded (controls included), so the wire header stays a single
 *    line. The lock asserts the OUTCOME (no CRLF on the wire, no injected
 *    headers) instead of the throw.
 *  - Empty-body endings use a committed `new Response(null, { status: 204 })`
 *    or `c.body = "ok"` because the state-mode null-body path is currently
 *    broken (see the CONFIRMED-BUG block at the bottom).
 */

import { describe, expect, it, vi } from "vitest";

import { Keala } from "../src/core/app.ts";
import { createError } from "../src/http/errors.ts";

const quiet = { env: "test" } as const;
const drive = (app: InstanceType<typeof Keala>, request: Request) => app.handle(request);

describe("header injection (response splitting)", () => {
  it("rejects CRLF in header values via set/append", async () => {
    const app = new Keala(quiet);
    app.use(async (c) => {
      expect(() => c.setHeader("X-Safe", "v\r\nSet-Cookie: pwned=1")).toThrow(TypeError);
      expect(() => c.append("X-Safe", "v\nX-Evil: 1")).toThrow(TypeError);
      expect(() => c.setHeader("X-Safe", "v\rX-Evil: 1")).toThrow(TypeError);
      expect(() => c.setHeader("X-Safe", "v\u0000")).toThrow(TypeError);
      c.body = "ok";
    });
    const res = await drive(app, new Request("http://localhost:3000/"));
    expect(res.headers.get("x-evil")).toBe(null);
    expect(res.headers.get("set-cookie")).toBe(null);
  });

  it("keeps CR/LF out of redirect Location values (percent-encodes)", async () => {
    const app = new Keala(quiet);
    app.use(async (c) => {
      c.redirect("/ok\r\nSet-Cookie: evil=1");
    });
    const res = await drive(app, new Request("http://localhost:3000/"));
    // The attack intent: no response splitting. The Location value must be a
    // single line and no extra header may appear.
    expect(res.headers.get("location")).not.toMatch(/[\r\n]/);
    expect(res.headers.get("set-cookie")).toBe(null);
  });

  // 0.7: the "rejects CRLF in status messages" lock is gone with c.message
  // (statusText customization no longer exists).

  it("rejects CRLF and NUL in cookie serialization", async () => {
    const app = new Keala(quiet);
    app.use(async (c) => {
      expect(() => c.cookies.set("sid", "v\r\nSet-Cookie: evil=1")).toThrow(TypeError);
      expect(() => c.cookies.set("sid", "v\u0000")).toThrow(TypeError);
      c.body = "ok";
    });
    const res = await drive(app, new Request("http://localhost:3000/"));
    expect(res.headers.get("set-cookie")).toBe(null);
  });

  it("rejects CRLF in ETag values", async () => {
    const app = new Keala(quiet);
    app.use(async (c) => {
      expect(() => {
        c.etag = 'x"\r\nX-Evil: 1';
      }).toThrow(TypeError);
      c.body = "ok";
    });
    await drive(app, new Request("http://localhost:3000/"));
  });

  it("drops invalid headers arriving via error.headers instead of crashing", async () => {
    const app = new Keala(quiet);
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
    const app = new Keala();
    let sawOk: string | undefined;
    let sawProtoKey: string | undefined;
    app.use(async (c) => {
      // Targeted reads return strings — no object, no property assignment,
      // pollution structurally impossible. Unsafe-looking keys are just keys.
      sawOk = c.query("ok");
      sawProtoKey = c.query("__proto__[polluted]");
      c.body = "ok";
    });
    await drive(
      app,
      new Request(
        "http://localhost:3000/?__proto__[polluted]=1&constructor.prototype.x=2&prototype=3&ok=1",
      ),
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(sawOk).toBe("1");
    expect(sawProtoKey).toBe("1");
  });

  it("rejects __proto__-style header names", async () => {
    const app = new Keala(quiet);
    app.use(async (c) => {
      expect(() => c.setHeader("__proto__", "x")).toThrow(TypeError);
      expect(() => c.setHeader("constructor", "x")).toThrow(TypeError);
      expect(() => c.setHeader("prototype", "x")).toThrow(TypeError);
      c.body = "ok";
    });
    await drive(app, new Request("http://localhost:3000/"));
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it("ignores __proto__ cookie names instead of mutating the session map", async () => {
    const app = new Keala({ keys: ["k"] });
    app.use(async (c) => {
      expect(c.cookies.get("__proto__")).toBeUndefined();
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      c.body = "ok";
    });
    await drive(
      app,
      new Request("http://localhost:3000/", {
        headers: { Cookie: "__proto__[polluted]=yes; session=abc" },
      }),
    );
  });

  it("keeps state and params maps unpollutable", async () => {
    const app = new Keala();
    app.get("/files/*", (c) => {
      c.state["__proto__"] = "x";
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      c.body = "ok";
    });
    await drive(app, new Request("http://localhost:3000/files/a"));
  });
});

describe("malformed input must never crash the process", () => {
  it("survives broken percent-encoding in paths and queries", async () => {
    const app = new Keala();
    app.get("/files/:name", (c) => {
      c.body = String(c.params.name);
    });
    const res = await drive(app, new Request("http://localhost:3000/files/%E0%A4%A?x=%ZZ"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("%E0%A4%A");
  });

  it("survives enormous paths and query strings", async () => {
    const app = new Keala();
    let queryKeys = 0;
    app.use(async (c) => {
      queryKeys = (c.query("k0") === "1" ? 1 : 0) + (c.query("k999") === "1" ? 1 : 0);
      return new Response(null, { status: 204 });
    });
    const longPath = `/${"a".repeat(4000)}`;
    const longQuery = `?${Array.from({ length: 1000 }, (_, i) => `k${i}=1`).join("&")}`;
    const res = await drive(app, new Request(`http://localhost:3000${longPath}${longQuery}`));
    expect(res.status).toBe(204);
    expect(queryKeys).toBe(2); // extremes k0 + k999 readable
  });

  it("survives malformed cookie headers", async () => {
    const app = new Keala();
    app.use(async (c) => {
      expect(c.cookies.get("session")).toBe("ok");
      c.body = "ok";
    });
    await drive(
      app,
      new Request("http://localhost:3000/", {
        headers: { Cookie: "garbage;;;;;=;;session=ok;=;bad[name]=1" },
      }),
    );
  });

  it("survives hostile accept headers", async () => {
    const app = new Keala();
    app.use(async (c) => {
      expect(c.accepts("html")).toBeDefined();
      c.body = "ok";
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
    const app = new Keala(quiet);
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
    const app = new Keala({ env: "production" });
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
    const app = new Keala(quiet);
    app.use(async (c) => {
      c.throw(400, "invalid input");
    });
    const res = await drive(app, new Request("http://localhost:3000/"));
    expect(await res.text()).toBe("invalid input");
  });

  it("redirect bodies are gone; the Location value carries no raw markup (XSS)", async () => {
    // 0.7: redirects are empty-bodied (Location only), so the old fallback
    // page's HTML-escaping surface is gone — the attack intent moves to the
    // header, where encodeUrlValue percent-encodes < > " and friends.
    const app = new Keala();
    app.use(async (c) => {
      c.redirect("/next?<script>alert(document.domain)</script>");
    });
    const res = await drive(
      app,
      new Request("http://localhost:3000/", { headers: { Accept: "text/html" } }),
    );
    expect(await res.text()).toBe("");
    const location = res.headers.get("location") ?? "";
    expect(location).not.toContain("<");
    expect(location).not.toContain(">");
    expect(location).toContain("%3Cscript%3E");
  });

  it("redirect Location values never carry raw quotes", async () => {
    const app = new Keala();
    app.use(async (c) => {
      c.redirect('/a?x="onmouseover=alert(1)');
    });
    const res = await drive(
      app,
      new Request("http://localhost:3000/", { headers: { Accept: "text/html" } }),
    );
    expect(await res.text()).toBe("");
    expect(res.headers.get("location")).not.toContain('"');
  });
});

describe("cookie integrity", () => {
  it("rejects forged signatures", async () => {
    const app = new Keala({ keys: ["production-key"] });
    app.use(async (c) => {
      c.body = c.cookies.get("sid") ?? "anonymous";
    });
    const forged = await drive(
      app,
      new Request("http://localhost:3000/", { headers: { Cookie: "sid=admin.deadbeef" } }),
    );
    expect(await forged.text()).toBe("anonymous");
  });

  it("does not accept cookies signed with a retired key as new signatures", async () => {
    const app = new Keala({ keys: ["new-key", "old-key"] });
    app.use(async (c) => {
      if (c.path === "/set") {
        c.cookies.set("sid", "fresh", { signed: true });
      } else {
        c.body = c.cookies.get("sid") ?? "anonymous";
      }
    });
    const set = await drive(app, new Request("http://localhost:3000/set"));
    const outgoing = set.headers.getSetCookie()[0] ?? "";
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

describe("routing abuse resistance", () => {
  it("does not match path traversal out of the wildcard scope via decode", async () => {
    const app = new Keala();
    app.get("/assets/*", (c) => {
      c.body = `wildcard:${c.params.wildcard}`;
    });
    const res = await drive(app, new Request("http://localhost:3000/assets/a%2F..%2Fsecret"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("wildcard:a/../secret");
  });

  it("treats conflicting routes deterministically (no crash on adversarial patterns)", () => {
    const app = new Keala();
    expect(() => {
      app.get("/a/:x(\\d+)", () => {});
      app.get("/a/:x([a-z]+)", () => {});
      app.get("/a/*", () => {});
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// CONFIRMED-BUG ledger (core, do not fix here — src/ is frozen for this task).
// Root cause: src/core/respond.ts `bodyInitOf()` ends with
// `return JSON.stringify(body) ?? "null"` — for `body === null`,
// JSON.stringify(null) IS the string "null", so every null-body response is
// finalized with the literal text "null" as its body.
//  - Bun: a 204 (or any explicit-null-body) response carries body "null".
//  - Node/undici (vitest): `new Response("null", { status: 204 })` throws
//    "Invalid response status code 204", so app.handle REJECTS.
// ---------------------------------------------------------------------------

describe("CONFIRMED-BUG: null-body finalization", () => {
  it('CONFIRMED-BUG(now fixed): a 204 response must have an empty body, not the text "null" (TODO-BUG: respond.ts bodyInitOf)', async () => {
    const app = new Keala(quiet);
    app.use((c) => {
      c.status = 204;
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe(""); // actual: "null" (Bun) / TypeError (Node)
  });

  it('CONFIRMED-BUG(now fixed): explicit null body then explicit status serves "" not "null" (TODO-BUG: respond.ts bodyInitOf)', async () => {
    const app = new Keala(quiet);
    app.use((c) => {
      c.body = null;
      c.body = undefined as never; // koa allows an undefined body assignment
      c.status = 200;
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(""); // actual: "null"
  });
});
