/**
 * Agent-audit regression locks API: Referrer handling, redirect status
 * classification, emitter edges, router mount/trie encoding, is() array
 * form and the compose next() guard.
 *
 * migration notes (0.7):
 *  - One flat Context: no `ctx.request` / `ctx.response` facades; response
 *    headers are read via `c.resHeader`.
 *  - The app exposes a single-slot onError mapper (R4.3); the old emitter
 *    multi-cast surface is deleted.
 *  - new Router().use(prefix, mw) koa-mount url-stripping is gone: a
 *    standalone router's middleware prepends to its routes and sees the full
 *    url (route-table merge semantics). The query-visibility intent is kept.
 *  - response.is() no longer exists (type negotiation is request-side);
 *    that case was dropped — see the migration report.
 *  - 0.7 deleted the request url/path rewrite cache-chain suite and the
 *    c.fresh suite (requests are read-only; freshness lives in
 *    conditional.ts / the etag middleware), and c.back()/redirect("back")
 *    (open-redirect surface — callers read c.header("referrer") instead).
 */

import { describe, expect, it } from "vitest";

import { Keala, Router, isRedirectStatus, type Context } from "../src/index.ts";

const quiet = { env: "test" } as const;

/** Drive a request through an app and capture the context for inspection. */
const probe = async (
  init: { url: string; method?: string; headers?: Record<string, string> },
  setup?: (app: InstanceType<typeof Keala>) => void,
): Promise<Context> => {
  let captured: Context | undefined;
  const app = new Keala(quiet);
  app.use(async (c) => {
    captured = c;
    c.body = "done";
  });
  setup?.(app);
  await app.handle(new Request(init.url, init));
  if (captured === undefined) throw new Error("probe middleware did not run");
  return captured;
};

describe("agent audit: Referrer alias", () => {
  it("get() reads the Referer header through both spellings", async () => {
    const c = await probe({
      url: "http://localhost:3000/",
      headers: { Referer: "http://localhost:3000/login" },
    });
    expect(c.get("Referrer")).toBe("http://localhost:3000/login");
    expect(c.get("referrer")).toBe("http://localhost:3000/login");
    expect(c.get("Referer")).toBe("http://localhost:3000/login");
  });
});

describe("agent audit: redirect status classification (statuses.redirect)", () => {
  it("matches Koa's redirect class exactly", () => {
    for (const code of [300, 301, 302, 303, 305, 307, 308]) {
      expect(isRedirectStatus(code), `isRedirectStatus(${code})`).toBe(true);
    }
    for (const code of [200, 204, 304, 306, 400]) {
      expect(isRedirectStatus(code), `isRedirectStatus(${code})`).toBe(false);
    }
  });

  it("redirect() replaces a previously-set 304 instead of keeping it", async () => {
    const app = new Keala(quiet);
    app.get("/", (c) => {
      c.status = 304;
      c.redirect("/next");
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/next");
  });

  it("redirect() honors an explicit 305 code (a real redirect status)", async () => {
    const app = new Keala(quiet);
    app.get("/", (c) => {
      c.redirect("/proxy", 305);
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(305);
    expect(res.headers.get("location")).toBe("/proxy");
  });
});

describe("agent audit: router mount and trie encoding", () => {
  it("router.use() middleware keeps the query string visible downstream", async () => {
    const router = new Router();
    const app = new Keala(quiet);
    const seen: string[] = [];
    // Upstream of the mounted router: after next() resolves the url is intact.
    app.use(async (c, next) => {
      await next();
      seen.push(`upstream-after:${c.url}`);
    });
    router.use(async (c, next) => {
      seen.push(`mounted:${c.url}`, `query:${c.query("page") ?? "-"}`);
      await next();
      // route-table merge semantics: no koa-mount url stripping — the
      // mounted subtree still sees the full url.
      seen.push(`mounted-after:${c.url}`);
    });
    router.get("/users", (c) => {
      c.body = { page: c.query("page") };
    });
    app.mount("/api", router);
    const res = await app.handle(new Request("http://localhost:3000/api/users?page=2&size=10"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ page: "2" });
    expect(seen[0]).toBe("mounted:/api/users?page=2&size=10");
    expect(seen[1]).toBe("query:2");
    expect(seen[2]).toBe("mounted-after:/api/users?page=2&size=10");
    expect(seen[3]).toBe("upstream-after:/api/users?page=2&size=10");
  });

  it("percent-encoded static segments inside dynamic routes match", async () => {
    const app = new Keala(quiet);
    app.get("/caf%C3%A9/:id", (c) => {
      c.body = { id: c.params?.["id"] };
    });
    const res = await app.handle(new Request("http://localhost:3000/caf%C3%A9/42"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "42" });
  });

  it("unicode route patterns match percent-encoded requests", async () => {
    const app = new Keala(quiet);
    app.get("/café/:id", (c) => {
      c.body = `ok:${c.params?.["id"]}`;
    });
    const res = await app.handle(new Request("http://localhost:3000/caf%C3%A9/7"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok:7");
  });

  it("keeps %2F inside a single param segment (no path splitting)", async () => {
    const app = new Keala(quiet);
    app.get("/files/:name", (c) => {
      c.body = `file:${c.params?.["name"]}`;
    });
    // %2F stays a single segment for matching purposes (no path splitting).
    const res = await app.handle(new Request("http://localhost:3000/files/a%2Fb"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("file:a/b");
  });
});

describe("agent audit: response details", () => {
  it("length setter is a no-op while Transfer-Encoding is set", async () => {
    const c = await probe({ url: "http://localhost:3000/" });
    c.setHeader("Transfer-Encoding", "chunked");
    c.length = 99;
    expect(c.resHeader("Content-Length")).toBe("");
    c.remove("Transfer-Encoding");
    c.length = 99;
    expect(c.resHeader("Content-Length")).toBe("99");
  });
});

describe("agent audit: is() array form (type-is compatibility)", () => {
  it("c.is() accepts a single array of candidate types", async () => {
    const c = await probe({
      url: "http://localhost:3000/",
      headers: { "Content-Type": "application/json" },
    });
    expect(c.is(["json", "html"])).toBe("json");
    expect(c.is(["html", "xml"])).toBe(false);
  });

  it("varargs form is unchanged", async () => {
    const c = await probe({
      url: "http://localhost:3000/",
      headers: { "Content-Type": "text/html" },
    });
    expect(c.is("html", "json")).toBe("html");
  });
});

describe("agent audit: compose next() guard under nesting", () => {
  it("rejects a second next() from a route handler nested in app middleware", async () => {
    const app = new Keala(quiet);
    let message = "";
    app.use(async (_c, next) => {
      try {
        await next();
      } catch (err) {
        message = (err as Error).message;
      }
    });
    app.get("/double", async (_c, next) => {
      await next();
      await next(); // the bug pattern: calling next twice
    });
    await app.handle(new Request("http://localhost:3000/double"));
    expect(message).toBe("next() called multiple times in the same middleware");
  });

  it("still resolves when the same handler serves many sequential requests", async () => {
    const app = new Keala(quiet);
    app.use(async (_c, next) => next());
    app.get("/seq", async (c, next) => {
      await next();
      c.body = "done";
    });
    for (let i = 0; i < 5; i++) {
      const res = await app.handle(new Request("http://localhost:3000/seq"));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("done");
    }
  });
});
