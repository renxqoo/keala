/**
 * Extended security matrix: injection variants, pollution vectors, cookie
 * forgery, resource-abuse bounds and information disclosure. Every case
 * asserts both the safe outcome AND that the attack payload is absent from
 * the wire response. Migrated to the current API.
 *
 * note: `c.redirect()` percent-encodes CR/LF/NUL inside the Location
 * value instead of throwing (koa's encodeurl leaves them for set() to
 * reject). The redirect locks below therefore assert the wire outcome —
 * single-line Location, no injected headers — which is the actual security
 * contract.
 */

import { describe, expect, it } from "vitest";

import { Keala } from "../../src/core/app.ts";
import type { Context } from "../../src/core/context/context.ts";
import { sign, unsign } from "../../src/context/cookies.ts";

const quiet = { env: "test" } as const;

const attack = async (setup: (c: Context) => unknown, init?: RequestInit): Promise<Response> => {
  const app = new Keala(quiet);
  app.onError(() => {});
  // Propagate setup's return (U3a: `return c.redirect(...)` must become the
  // middleware's answer, not vanish).
  app.use((c) => setup(c) as Response | undefined);
  return app.handle(new Request("http://localhost:3000/", init));
};

const wireHeaders = (res: Response): string =>
  [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");

describe("security: response-splitting variant matrix", () => {
  const payloads = [
    "v\r\nSet-Cookie: evil=1",
    "v\nSet-Cookie: evil=1",
    "v\rSet-Cookie: evil=1",
    "v\u0000Set-Cookie: evil=1",
    "v\r\n X-Inject: 1",
    "v\n\nHTTP/1.1 200 OK",
    "\r\n",
    "v\u000d\u000aX-I: 1",
    "v\u240d\u240a-not-crlf",
  ];

  it.each(payloads)("set() blocks %p", async (payload) => {
    const res = await attack((c) => {
      expect(() => c.setHeader("X-Target", payload)).toThrow(TypeError);
      c.body = "ok";
    });
    expect(wireHeaders(res)).not.toContain("evil=1");
    expect(wireHeaders(res)).not.toContain("X-Inject");
  });

  it.each(payloads)("redirect keeps %p out of the wire as raw CR/LF", async (payload) => {
    const res = await attack((c) => {
      return c.redirect(payload);
    });
    expect(res.headers.get("location")).not.toMatch(/[\r\n]/);
    expect(res.headers.get("set-cookie")).toBe(null);
    expect(res.headers.get("x-inject")).toBe(null);
    expect(res.status).toBe(302);
  });

  it.each(payloads.filter((p) => p !== "v\u240d\u240a-not-crlf"))(
    "cookie value blocks %p",
    async (payload) => {
      const res = await attack((c) => {
        expect(() => c.cookies.set("sid", payload)).toThrow(TypeError);
        c.body = "ok";
      });
      expect(res.headers.get("set-cookie")).toBe(null);
    },
  );

  it("cookie value: non-ASCII LOOKS like breaks but percent-encodes safely (R4.10)", async () => {
    // U+240D/U+240A are "symbol for CR/LF" glyphs, not control bytes — the
    // symmetric codec encodes them to %E2%90%8D…, which cannot split a
    // header. The old validator hard-rejected ALL non-ASCII, so legal
    // Unicode values were impossible to set.
    const res = await attack((c) => {
      c.cookies.set("sid", "v\u240d\u240a-not-crlf");
      c.body = "ok";
    });
    expect(res.headers.get("set-cookie")).toBe("sid=v%E2%90%8D%E2%90%8A-not-crlf; Path=/");
  });

  it.each(["__proto__", "constructor", "prototype", "a b", "a;b", "a=b", "é"])(
    "header name %p rejected before storage",
    async (name) => {
      await attack((c) => {
        expect(() => c.setHeader(name, "v")).toThrow(TypeError);
      });
    },
  );

  it("append() applies identical validation to every element", async () => {
    const res = await attack((c) => {
      expect(() => c.append("X-Multi", ["ok", "evil\r\nX-Bad: 1"])).toThrow(TypeError);
      c.body = "ok";
    });
    expect(res.headers.get("x-bad")).toBe(null);
  });

  it("set({object}) validates values too", async () => {
    const res = await attack((c) => {
      expect(() => c.setHeader({ "X-A": "fine", "X-B": "bad\r\nX-C: 1" } as never)).toThrow(
        TypeError,
      );
      c.body = "ok";
    });
    expect(res.headers.get("x-c")).toBe(null);
  });
});

describe("security: prototype pollution vector matrix", () => {
  it.each([
    ["__proto__", "x"],
    ["constructor", "x"],
    ["prototype", "x"],
    ["constructor[prototype][x]", "x"],
    ["__proto__.polluted", "x"],
    ["__defineGetter__", "x"],
  ])("query key %p never pollutes Object.prototype", async (key, value) => {
    let readBack = "unset";
    const app = new Keala(quiet);
    app.use((c) => {
      // A targeted read of the hostile key is just a string lookup — no
      // object, no property assignment, pollution structurally impossible.
      readBack = c.query(key) ?? "absent";
      c.body = "ok";
    });
    const res = await app.handle(
      new Request(`http://localhost:3000/?${encodeURIComponent(key)}=${value}&ok=1`),
    );
    expect(res.status).toBe(200);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(readBack).toBe(value);
  });

  it("nested JSON-style query keys are kept as literal keys", async () => {
    await attack((c) => {
      expect(c.query("__proto__[polluted]")).toBeDefined();
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });
  });

  it("pollution through cookie names, state and params is inert", async () => {
    const app = new Keala(quiet);
    app.get("/:__proto__", () => {});
    app.use((c) => {
      c.state["__proto__"] = { polluted: true } as never;
      c.cookies.set("ok", "1");
      c.body = "ok";
    });
    const res = await app.handle(
      new Request("http://localhost:3000/p", {
        headers: { Cookie: "__proto__[x]=1; constructor.y=2" },
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("security: cookie forgery matrix", () => {
  const KEYS = ["current", "retired"];

  it.each([
    ["tampered payload", "admin.deadbeefbase64"],
    ["empty signature", "admin."],
    ["no separator", "admin"],
    ["wrong key signature", () => sign("admin", "wrong")],
    ["signature moved to payload", "admin.sig.value"],
    [
      "payload swapped after signing",
      (() => {
        const signed = sign("user", "current");
        return `admin${signed.slice(4)}`;
      })(),
    ],
  ])("%s is rejected", (_label, value) => {
    const cookie = typeof value === "function" ? value() : value;
    expect(unsign(cookie, KEYS)).toBe(false);
  });

  it("rotated keys still verify old signatures but sign with the new key", () => {
    const oldSigned = sign("data", "retired");
    expect(unsign(oldSigned, KEYS)).toBe("data");
    const newSigned = sign("data", KEYS[0] as string);
    expect(newSigned).not.toBe(oldSigned);
    expect(unsign(newSigned, ["retired"])).toBe(false);
  });

  it("signature bytes cannot be truncated into validity", () => {
    const signed = sign("admin", "current");
    for (let cut = 1; cut < 8; cut++) {
      expect(unsign(signed.slice(0, signed.length - cut), KEYS)).toBe(false);
    }
  });

  it("end-to-end: forged cookies read as absent", async () => {
    const app = new Keala({ ...quiet, keys: ["prod-key"] });
    app.use((c) => {
      c.body = c.cookies.get("sid") ?? "anonymous";
    });
    for (const forged of ["sid=root.aaaa", "sid=root", "sid=.", `sid=${sign("root", "off-key")}`]) {
      const res = await app.handle(
        new Request("http://localhost:3000/", { headers: { Cookie: forged } }),
      );
      expect(await res.text()).toBe("anonymous");
    }
  });
});

describe("security: redirect and XSS matrix", () => {
  it.each([
    ["/next?<script>alert(1)</script>"],
    ['/next?x="><img src=x onerror=alert(1)>'],
    ["/a'b\"c<d>e"],
    ["/next#<iframe>"],
  ])("redirect %p never emits raw markup", async (url) => {
    const res = await attack(
      (c) => {
        return c.redirect(url);
      },
      { headers: { Accept: "text/html" } },
    );
    const body = await res.text();
    expect(body).not.toMatch(/<(script|img|iframe)[\s>]/i);
  });

  it.each([['report"; X-Evil: 1.pdf'], ["report\r\nSet-Cookie: evil=1.pdf"], ["a;b=c.png"]])(
    "attachment filename %p stays inside Content-Disposition",
    async (filename) => {
      const res = await attack((c) => {
        c.attachment(filename);
        c.body = "f";
      });
      // The header value must be a single line: any raw CR/LF would split it.
      const disposition = res.headers.get("content-disposition") ?? "";
      expect(disposition).not.toMatch(/[\r\n]/);
      // And no injected header of its own may appear anywhere.
      expect(res.headers.get("x-evil")).toBe(null);
      expect(res.headers.get("set-cookie")).toBe(null);
    },
  );

  it("open redirect scope: absolute external URLs are allowed but CRLF is not", async () => {
    const res = await attack((c) => {
      return c.redirect("https://example.org/away");
    });
    expect(res.headers.get("location")).toBe("https://example.org/away");
  });

  it("redirect status is never downgraded to 2xx by attacker input", async () => {
    const res = await attack((c) => {
      c.status = 200;
      return c.redirect("/moved");
    });
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
  });

  it("an absolute target with a backslash-at stays a path, never a userinfo separator", async () => {
    // Ported from the retired koa parity suite (U1): the \@ in
    // "http://google.com\@apple.com" must never normalize into authority
    // userinfo — the backslash becomes a path slash and @ lands in the PATH.
    const app = new Keala(quiet);
    app.get("/r", (c) => c.redirect("http://google.com\\@apple.com"));
    const res = await app.handle(new Request("http://localhost:3000/r"));
    expect(res.headers.get("location")).toBe("http://google.com/@apple.com");
    expect(res.status).toBe(302);
  });
});

describe("security: path traversal and routing abuse", () => {
  it.each([
    ["%2e%2e%2fetc%2fpasswd"],
    ["..%2f..%2fsecret"],
    ["%252e%252e%252fdouble-encoded"],
    ["a/../../../b"],
    ["/static/../../etc/passwd"],
  ])("wildcard capture of %p stays inside the route", async (raw) => {
    const app = new Keala(quiet);
    app.get("/static/*", (c) => {
      c.body = `cap:${c.params("wildcard")}`;
    });
    const path = raw.startsWith("/") ? raw : `/static/${raw}`;
    const res = await app.handle(new Request(`http://localhost:3000${path}`));
    expect(res.status).toBeLessThan(500);
    const body = await res.text();
    expect(body.startsWith("cap:") || body === "Not Found").toBe(true);
  });

  it("decoded params never escape their segment for :name captures", async () => {
    const app = new Keala(quiet);
    app.get("/users/:name/files/:rest", (c) => {
      c.body = `${c.params("name")}/${c.params("rest")}`;
    });
    const res = await app.handle(new Request("http://localhost:3000/users/a%2Fb/files/c%2Fd"));
    // Decoding is intentional; the capture stays a value and never
    // re-enters routing.
    expect(await res.text()).toBe("a/b/c/d");
  });

  it("many routes do not degrade matching into wrong hits", async () => {
    const app = new Keala(quiet);
    for (let i = 0; i < 200; i++) {
      app.get(`/r${i}/:id(\\d+)`, (c) => {
        c.body = `r${i}`;
      });
    }
    const res = await app.handle(new Request("http://localhost:3000/r199/7"));
    expect(await res.text()).toBe("r199");
    const miss = await app.handle(new Request("http://localhost:3000/r199/x"));
    expect(miss.status).toBe(404);
  });
});

describe("security: resource-abuse bounds", () => {
  it("a 64KB query string parses under 300ms", async () => {
    const app = new Keala(quiet);
    let values = 0;
    app.use((c) => {
      // Touch the query so the parse actually happens inside the timed window.
      values = c.queries("k").length;
      return new Response(null, { status: 204 });
    });
    const huge = `?${"k=1&".repeat(16_000)}`;
    const start = Date.now();
    const res = await app.handle(new Request(`http://localhost:3000/${huge}`));
    {
      expect(res.status).toBe(204);
      expect(values).toBe(16_000);
      expect(Date.now() - start).toBeLessThan(300);
    }
  });

  it("a pathological Accept header with 2k entries parses bounded", async () => {
    const app = new Keala(quiet);
    app.use((c) => {
      c.body = String(c.accepts("html"));
    });
    const header = Array.from({ length: 2000 }, (_, i) => `t${i}/x;q=0.${i % 10}`).join(",");
    const res2 = await app.handle(
      new Request("http://localhost:3000/", { headers: { Accept: header } }),
    );
    expect(res2.status).toBeLessThan(500);
  });

  it("deeply nested wildcard-free tries stay bounded on misses", async () => {
    const app = new Keala(quiet);
    app.get("/:a/:b/:c/:d/:e/:f/:g/:h/:i/:j/end", () => {});
    const start = Date.now();
    await app.handle(new Request("http://localhost:3000/1/2/3/4/5/6/7/8/9/10/miss"));
    expect(Date.now() - start).toBeLessThan(50);
  });
});

describe("security: information disclosure matrix", () => {
  it.each([
    [
      "middleware error",
      () => {
        throw new Error("SECRETS: db://user:pass@host");
      },
    ],
    ["async rejection", async () => Promise.reject(new Error("token=abc123"))],
    [
      "nested property error",
      () => {
        const err = new Error("inner leak");
        (err as Error & { details: unknown }).details = { password: "hunter2" };
        throw err;
      },
    ],
  ])("%s hides the message on 5xx", async (_label, boom) => {
    const app = new Keala({ env: "production" });
    app.onError(() => {});
    app.use(async () => {
      await boom();
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    const body = await res.text();
    expect(res.status).toBe(500);
    expect(body).toBe("Internal Server Error");
    expect(body).not.toMatch(/SECRETS|token|hunter2|pass/);
  });

  it("stack traces never reach the response body in any env", async () => {
    for (const env of ["development", "production", "test"]) {
      const app = new Keala({ env });
      app.onError(() => {});
      app.use(async () => {
        throw new Error("boom");
      });
      const res = await app.handle(new Request("http://localhost:3000/"));
      expect(await res.text()).not.toContain("at ");
    }
  });

  it("exposed 4xx messages cannot smuggle headers via multi-line payloads", async () => {
    const app = new Keala(quiet);
    app.use(async (c) => {
      c.throw(400, "line1\r\nX-Evil: 1");
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.headers.get("x-evil")).toBe(null);
  });

  it("error.headers values are validated even for trusted-looking errors", async () => {
    const app = new Keala(quiet);
    app.use(async () => {
      const err = new Error("x") as Error & { status: number; headers: unknown };
      err.status = 418;
      err.headers = { Location: "/tea\r\nX-Evil: 1", "X-OK": "yes" };
      throw err;
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.headers.get("x-evil")).toBe(null);
    expect(res.headers.get("x-ok")).toBe("yes");
  });
});
