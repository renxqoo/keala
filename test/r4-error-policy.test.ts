/**
 * R4.3 error response policy — behavior locks (written RED before
 * implementation). Contract source: docs/HOTPATH-R4-3-MIGRATION-ERROR-POLICY.md.
 *
 * Six groups, one per contract rule group:
 *   1. on/off differential — decline keeps the built-in response byte-identical
 *   2. single slot — duplicate registration throws
 *   3. async mapper — thenable awaited; rejection never escapes app.handle
 *   4. mapper failure — static 500 AND the framework console.errors the bug
 *   5. header merge — if-absent only, own headers win, content never copied
 *   6. funnel coverage — c.throw 4xx, unexpected wrap, finalize failure, ws
 *      upgrade rejection all reach the mapper
 */

import { describe, expect, it, vi } from "vitest";

import { Keala } from "../src/core/app.ts";
import type { HttpError } from "../src/http/errors.ts";

const requestFor = (path: string, init?: RequestInit): Request =>
  new Request(`http://localhost:3000${path}`, init);

const boot = (setup?: (app: Keala) => void): Keala => {
  const app = new Keala({ env: "test" });
  if (setup !== undefined) setup(app);
  return app;
};

describe("R4.3 error policy: on/off differential", () => {
  it("decline (void) keeps the built-in response byte-identical", async () => {
    const scenarios = (
      app: Keala,
    ): Array<{ path: string; status: number; body: string; extra?: [string, string] }> => {
      app.use((c, next) => {
        // Security header staged BEFORE the throw must survive on error pages.
        void c.set("x-security", "on");
        return next();
      });
      app.get("/exposed", (c) => c.throw(422, "invalid input", { expose: true }));
      app.get("/hidden", () => {
        throw new TypeError("secret internals");
      });
      app.get("/auth", (c) =>
        c.throw(401, "login required", {
          expose: true,
          headers: { "www-authenticate": "Bearer" },
        }),
      );
      return [
        { path: "/exposed", status: 422, body: "invalid input" },
        { path: "/hidden", status: 500, body: "Internal Server Error" },
        {
          path: "/auth",
          status: 401,
          body: "login required",
          extra: ["www-authenticate", "Bearer"],
        },
      ];
    };

    const plain = boot((app) => void scenarios(app));
    let mapperRan = 0;
    const declining = boot((app) => {
      void scenarios(app);
      app.onError(() => {
        mapperRan += 1; // side effect fires; void = decline
      });
    });

    const cases = [
      { path: "/exposed", status: 422, body: "invalid input" },
      { path: "/hidden", status: 500, body: "Internal Server Error" },
      {
        path: "/auth",
        status: 401,
        body: "login required",
        extra: ["www-authenticate", "Bearer"] as [string, string],
      },
    ];
    for (const c of cases) {
      const a = await plain.handle(requestFor(c.path));
      const b = await declining.handle(requestFor(c.path));
      expect(b.status).toBe(c.status);
      expect(a.status).toBe(c.status);
      expect(await b.text()).toBe(c.body);
      expect(await a.text()).toBe(c.body);
      expect(b.headers.get("x-security")).toBe("on");
      expect(a.headers.get("x-security")).toBe("on");
      expect(b.headers.get("content-type")).toBe(a.headers.get("content-type"));
      if (c.extra !== undefined) {
        expect(b.headers.get(c.extra[0])).toBe(c.extra[1]);
      }
    }
    expect(mapperRan).toBe(cases.length);
  });

  it("takeover returns the mapper's Response", async () => {
    const app = boot((a) => {
      a.get("/boom", () => {
        throw new Error("x");
      });
      a.onError((error, c) => c.json({ code: "E_INTERNAL", rid: c.state["rid"] }, error.status));
    });
    const res = await app.handle(requestFor("/boom"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ code: "E_INTERNAL", rid: undefined });
  });
});

describe("R4.3 error policy: single slot", () => {
  it("second onError registration throws TypeError", () => {
    const app = boot();
    app.onError(() => undefined);
    expect(() => app.onError(() => undefined)).toThrow(TypeError);
  });
});

describe("R4.3 error policy: async mapper", () => {
  it("thenable response is awaited and used", async () => {
    const app = boot((a) => {
      a.get("/boom", (c) => c.throw(503, "down", { expose: true }));
      a.onError(async (error) => {
        await Promise.resolve();
        return new Response(`async-${error.status}`, { status: error.status });
      });
    });
    const res = await app.handle(requestFor("/boom"));
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("async-503");
  });

  it("mapper rejection settles to static 500 without escaping app.handle", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const app = boot((a) => {
        a.get("/boom", () => {
          throw new Error("original");
        });
        a.onError(async () => {
          throw new Error("mapper blew up");
        });
      });
      const res = await app.handle(requestFor("/boom"));
      expect(res.status).toBe(500);
      expect(await res.text()).toBe("Internal Server Error");
      expect(consoleError).toHaveBeenCalled();
      const logged = consoleError.mock.calls.flat().join(" ");
      expect(logged).toContain("mapper blew up");
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("R4.3 error policy: mapper failure", () => {
  it("sync throw answers static 500 and the framework console.errors the mapper bug", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const app = boot((a) => {
        a.get("/boom", (c) => c.throw(401, "no", { expose: true }));
        a.onError(() => {
          throw new Error("envelope bug");
        });
      });
      const res = await app.handle(requestFor("/boom"));
      expect(res.status).toBe(500);
      expect(await res.text()).toBe("Internal Server Error");
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(consoleError.mock.calls.flat().join(" ")).toContain("envelope bug");
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("R4.3 error policy: header merge (if-absent)", () => {
  it("error.headers and staged security headers are added only when absent", async () => {
    const app = boot((a) => {
      a.use((c, next) => {
        void c.set("x-security", "staged");
        void c.set("retry-after", "30");
        // Content-describing staged headers describe the body that failed —
        // they are stripped by the reset and must never reach the takeover.
        void c.set("content-type", "application/staged-json");
        return next();
      });
      a.get("/limited", (c) =>
        c.throw(429, "slow down", {
          expose: true,
          headers: { "retry-after": "60", "www-authenticate": "Bearer" },
        }),
      );
      a.onError(() => new Response("rate limited", { status: 429 }));
    });
    const res = await app.handle(requestFor("/limited"));
    // error.headers fill absent slots…
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
    // …and shadow same-named staged values: the throw is the latest intent
    // (rule-4 order), so 60 (error) beats 30 (staged before the throw).
    expect(res.headers.get("retry-after")).toBe("60");
    expect(res.headers.get("x-security")).toBe("staged");
    // The takeover Response keeps its own content shape (Node auto-sets
    // text/plain for string bodies, Bun leaves it unset) — the STAGED
    // content-type must never survive onto it.
    expect(res.headers.get("content-type")).not.toBe("application/staged-json");
  });

  it("mapper's own headers always win", async () => {
    const app = boot((a) => {
      a.get("/x", (c) => c.throw(429, "slow", { expose: true, headers: { "retry-after": "60" } }));
      a.onError(() => new Response("no", { status: 429, headers: { "retry-after": "5" } }));
    });
    const res = await app.handle(requestFor("/x"));
    expect(res.headers.get("retry-after")).toBe("5");
  });

  // Bun 1.4 mutates even redirect Headers (R4.1 finding) — the immutable
  // branch only exists on Node runtimes.
  it.skipIf(typeof Bun !== "undefined")(
    "an immutable takeover Response ships untouched when the merge cannot write",
    async () => {
      const app = boot((a) => {
        a.get("/red", (c) =>
          c.throw(302, "go", { expose: true, headers: { "x-would-merge": "yes" } }),
        );
        // Response.redirect produces an immutable Headers on Node — the
        // if-absent merge must swallow the TypeError, not fail the request.
        a.onError(() => Response.redirect("http://localhost:3000/elsewhere"));
      });
      const res = await app.handle(requestFor("/red"));
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("http://localhost:3000/elsewhere");
      expect(res.headers.get("x-would-merge")).toBeNull();
    },
  );

  it("HEAD strips the takeover body", async () => {
    const app = boot((a) => {
      a.get("/h", () => {
        throw new Error("x");
      });
      a.onError(() => new Response("body-that-must-not-ship", { status: 500 }));
    });
    const res = await app.handle(new Request("http://localhost:3000/h", { method: "HEAD" }));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("");
  });
});

describe("R4.3 error policy: funnel coverage", () => {
  it("c.throw 4xx reaches the mapper with expose intact", async () => {
    const seen: HttpError[] = [];
    const app = boot((a) => {
      a.get("/v", (c) => c.throw(422, "bad", { code: "INVALID", expose: true }));
      a.onError((error) => {
        seen.push(error);
        return undefined;
      });
    });
    const res = await app.handle(requestFor("/v"));
    expect(res.status).toBe(422);
    expect(seen.length).toBe(1);
    expect(seen[0]?.status).toBe(422);
    expect(seen[0]?.expose).toBe(true);
    expect(seen[0]?.code).toBe("INVALID");
  });

  it("non-HttpError throwables are wrapped as 500 with stack and cause preserved", async () => {
    const seen: HttpError[] = [];
    const app = boot((a) => {
      a.get("/string", () => {
        throw "boom-string";
      });
      a.get("/object", () => {
        throw { weird: true };
      });
      a.get("/typed", () => {
        throw new TypeError("undefined is not a function");
      });
      a.onError((error) => {
        seen.push(error);
        return undefined;
      });
    });
    await app.handle(requestFor("/string"));
    await app.handle(requestFor("/object"));
    await app.handle(requestFor("/typed"));
    expect(seen.map((e) => e.status)).toEqual([500, 500, 500]);
    expect(seen[0]?.message).toBe("boom-string");
    expect(seen[2]?.message).toBe("undefined is not a function");
    // In-place classification: a real Error keeps its own identity — same
    // object, own stack — while non-Error throwables normalize with cause.
    const typed = seen[2] as HttpError;
    expect(typed).toBeInstanceOf(TypeError);
    expect(typed.stack).toContain("TypeError");
    expect(typed.expose).toBe(false);
  });

  it("finalize failures (unserializable body) reach the mapper", async () => {
    const seen: HttpError[] = [];
    const app = boot((a) => {
      a.get("/circular", (c) => {
        const obj: Record<string, unknown> = {};
        obj["self"] = obj;
        return c.json(obj);
      });
      a.onError((error) => {
        seen.push(error);
        return undefined;
      });
    });
    const res = await app.handle(requestFor("/circular"));
    expect(res.status).toBe(500);
    expect(seen.length).toBe(1);
    expect(seen[0]?.status).toBe(500);
  });

  it("ws upgrade rejection (501) reaches the mapper", async () => {
    const seen: HttpError[] = [];
    const app = boot((a) => {
      a.ws("/socket", { message: () => undefined });
      a.onError((error) => {
        seen.push(error);
        return undefined;
      });
    });
    const res = await app.handle(requestFor("/socket"));
    expect(res.status).toBe(501);
    expect(seen.length).toBe(1);
    expect(seen[0]?.status).toBe(501);
    expect(seen[0]?.expose).toBe(true);
  });

  it("console fallback fires for unobserved 5xx in non-test env", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const app = new Keala({ env: "development" });
      app.get("/boom", () => {
        throw new Error("unobserved");
      });
      const res = await app.handle(requestFor("/boom"));
      expect(res.status).toBe(500);
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(consoleError.mock.calls.flat().join(" ")).toContain("unobserved");
      // A registered (even declining) mapper takes over observation: no
      // framework console output.
      consoleError.mockClear();
      const quiet = new Keala({ env: "development" });
      quiet.get("/boom", () => {
        throw new Error("observed-by-mapper");
      });
      quiet.onError(() => undefined);
      const res2 = await quiet.handle(requestFor("/boom"));
      expect(res2.status).toBe(500);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});
