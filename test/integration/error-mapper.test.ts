import { describe, expect, it, vi } from "vitest";

import { Keala } from "../../src/core/app.ts";
import { createCookies } from "../../src/index.ts";
import type { HttpError } from "../../src/http/errors.ts";
import { Router } from "../../src/router/group.ts";
/**
 * Agent bug-review: logic defects in the R4.3 single-slot error mapper funnel
 * (commit 6ac9706). Contract source: docs/HOTPATH-R4-3-MIGRATION-ERROR-POLICY.md.
 *
 * Every non-skipped test asserts the CONTRACT-correct behavior and is RED
 * against the current code. Skipped tests carry an explanatory note.
 */

const requestFor = (path: string, init?: RequestInit): Request =>
  new Request(`http://localhost:3000${path}`, init);

const boot = (setup?: (app: Keala) => void, env = "test"): Keala => {
  const app = new Keala({ env });
  if (setup !== undefined) setup(app);
  return app;
};

describe("agent review: mergeAbsentHeaders (takeover merge)", () => {
  it("content-describing headers from error.headers are NEVER merged onto the takeover Response", async () => {
    const app = boot((a) => {
      a.get("/limited", (c) =>
        c.throw(429, "slow down", {
          expose: true,
          headers: {
            "retry-after": "60",
            "content-length": "999",
            "content-type": "application/json",
            "transfer-encoding": "chunked",
          },
        }),
      );
      // Bare Response: no content-type/content-length of its own (verified on
      // Bun/undici — the runtime adds those at send time, not in-memory).
      a.onError(() => new Response("rate limited", { status: 429 }));
    });
    const res = await app.handle(requestFor("/limited"));
    // Rule 3: error.headers merge if-absent EXCEPT content-describing headers.
    expect(res.headers.get("retry-after")).toBe("60");
    // A merged content-length: 999 over a 12-byte body is a wire desync; a
    // merged content-type mislabels the takeover body.
    expect(res.headers.get("content-length")).toBeNull();
    // Runtime-neutral: undici auto-sets text/plain on string bodies (Bun
    // leaves it unset) — the invariant is the ERROR's content-type never
    // lands on the takeover, not that none exists.
    expect(res.headers.get("content-type")).not.toBe("application/json");
    expect(res.headers.get("transfer-encoding")).toBeNull();
  });

  it("one invalid entry in error.headers must not abort the whole merge — staged security headers still apply", async () => {
    const app = boot((a) => {
      a.use((c, next) => {
        void c.setHeader("x-security", "on");
        return next();
      });
      a.get("/auth", (c) =>
        c.throw(401, "login required", {
          expose: true,
          // Object.entries order: the valid header lands first, the invalid
          // name throws mid-loop. The built-in decline path drops ONLY the
          // invalid header (per-header try/catch) — the takeover merge must
          // not lose the staged headers as collateral.
          headers: { "www-authenticate": "Bearer", "in valid name": "x" },
        }),
      );
      a.onError(() => new Response("unauthorized", { status: 401 }));
    });
    const res = await app.handle(requestFor("/auth"));
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
    expect(res.headers.get("x-security")).toBe("on");
  });

  it("staged multi-value set-cookie survives the if-absent merge (parity with the decline path)", async () => {
    // eslint-disable-next-line unicorn/consistent-function-scoping -- intentionally local fixture
    const staging = (a: Keala): void => {
      a.use((c, next) => {
        c.append("set-cookie", "a=1; Path=/");
        c.append("set-cookie", "b=2; Path=/");
        return next();
      });
      a.get("/boom", () => {
        throw new Error("x");
      });
    };
    // Snapshot into a plain array before asserting: vitest's diffing of the
    // live array returned by Bun's getSetCookie() is not reliable.
    // eslint-disable-next-line unicorn/consistent-function-scoping -- intentionally local fixture
    const cookiesOf = (res: Response): string[] =>
      JSON.parse(JSON.stringify(res.headers.getSetCookie())) as string[];

    // Decline ships both staged cookies (staged headers ride on error pages).
    const declining = boot((a) => {
      staging(a);
      a.onError(() => undefined);
    });
    const declined = await declining.handle(requestFor("/boom"));
    expect(cookiesOf(declined).toSorted()).toEqual(["a=1; Path=/", "b=2; Path=/"]);

    // Takeover must not collapse them to the first value: flattenHeaders
    // emits one pair per cookie, but the merge's headers.has() guard treats
    // the name as filled after the first set() and silently drops the rest.
    const taking = boot((a) => {
      staging(a);
      a.onError(() => new Response("err", { status: 500 }));
    });
    const res = await taking.handle(requestFor("/boom"));
    expect(cookiesOf(res).toSorted()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });
});

describe("agent review: toHttpError in-place classification", () => {
  it("a frozen Error still reaches the mapper (rule 2: the mapper ALWAYS receives an HttpError)", async () => {
    const seen: HttpError[] = [];
    const app = boot((a) => {
      a.get("/frozen", () => {
        // Frozen error singletons are a real reuse pattern; the in-place
        // `status = 500` write on a frozen object throws in strict mode.
        throw Object.freeze(new Error("frozen boom"));
      });
      a.onError((error) => {
        seen.push(error);
        return undefined;
      });
    });
    const res = await app.handle(requestFor("/frozen"));
    expect(res.status).toBe(500);
    expect(seen.length).toBe(1);
    expect(seen[0]?.message).toBe("frozen boom");
  });

  it("a frozen Error with no mapper still logs via the console fallback (rule 6: 5xx + non-test env)", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const app = boot((a) => {
        a.get("/frozen", () => {
          throw Object.freeze(new Error("frozen boom"));
        });
      }, "development");
      const res = await app.handle(requestFor("/frozen"));
      expect(res.status).toBe(500);
      expect(await res.text()).toBe("Internal Server Error");
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(consoleError.mock.calls.flat().join(" ")).toContain("frozen boom");
    } finally {
      consoleError.mockRestore();
    }
  });
});

/**
 * zz-red-bugs-6 — FINAL verification of reported findings. These assertions
 * encode the CORRECT expected behavior; failures are the bugs being reported.
 */

const hit = async (
  app: InstanceType<typeof Keala>,
  path: string,
  init?: RequestInit,
): Promise<Response> => app.handle(new Request(`http://localhost${path}`, init));

describe("BUG-1 (fixed): redirect() registration accepts every 3xx and honors it on the wire", () => {
  it("app.redirect 306 stays 306 (registration no longer coerces to 302)", async () => {
    const app = new Keala({ env: "test" });
    app.use(createCookies());
    app.redirect("/a", "/b", 306);
    const res = await hit(app, "/a");
    expect([res.status, res.headers.get("location")]).toEqual([306, "/b"]);
  });

  it("app.redirect 304 stays 304", async () => {
    const app = new Keala({ env: "test" });
    app.use(createCookies());
    app.redirect("/a", "/b", 304);
    const res = await hit(app, "/a");
    expect(res.status).toBe(304);
  });

  it("Router.redirect 306 stays 306", async () => {
    const app = new Keala({ env: "test" });
    app.use(createCookies());
    const r = new Router();
    r.redirect("/a", "/b", 306);
    app.mount("/", r);
    const res = await hit(app, "/a");
    expect(res.status).toBe(306);
  });

  it("contrast: c.redirect(target, 306) keeps 306 (explicit-code path)", async () => {
    const app = new Keala({ env: "test" });
    app.use(createCookies());
    app.get("/a", (c) => {
      return c.redirect("/b", 306);
    });
    const res = await hit(app, "/a");
    expect(res.status).toBe(306);
  });
});

describe("BUG-2: error-mapper takeover drops staged Set-Cookie when it sets its own", () => {
  it("staged cookie + takeover cookie both ship (join, not replace)", async () => {
    const app = new Keala({ env: "test" });
    app.use(createCookies());
    app.use((c, next) => {
      c.cookies.set("pre", "1");
      return next();
    });
    app.onError(
      () =>
        new Response("boom", {
          status: 500,
          headers: { "set-cookie": "post=2; Path=/" },
        }),
    );
    app.get("/", () => {
      throw new Error("x");
    });
    const res = await hit(app, "/");
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((line) => line.startsWith("pre="))).toBe(true);
    expect(cookies.some((line) => line.startsWith("post="))).toBe(true);
  });

  it("contrast: builtin path keeps the staged cookie", async () => {
    const app = new Keala({ env: "test" });
    app.use(createCookies());
    app.use((c, next) => {
      c.cookies.set("pre", "1");
      return next();
    });
    app.get("/", () => {
      throw new Error("x");
    });
    const res = await hit(app, "/");
    expect(res.headers.getSetCookie().some((line) => line.startsWith("pre="))).toBe(true);
  });
});

/**
 * U3c deletion (mapping #6): "BUG-3: c.body = <Response> type-checks but
 * silently serializes {}" locked the deleted `c.body =` setter's TypeError
 * guard ("return the Response instead"). With the setter gone the hazard it
 * guarded against (assigning a Response into the body slot) cannot be
 * expressed — returning the Response IS the API now.
 */
