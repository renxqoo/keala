/**
 * Agent-audit regression locks API: request url/query cache chain,
 * freshness (fresh@0.5.2 semantics), Referrer handling, redirect status
 * classification, emitter edges, router mount/trie encoding, is() array
 * form and the compose next() guard.
 *
 * migration notes:
 *  - One flat Context: no `ctx.request` / `ctx.response` facades; response
 *    headers are read via `c.resHeader`.
 *  - The app exposes onError/off/emit/listenerCount; `once` lives on the
 *    emitter the app is built around, so the once-semantics locks target
 *    createEmitter() directly.
 *  - new Router().use(prefix, mw) koa-mount url-stripping is gone: a
 *    standalone router's middleware prepends to its routes and sees the full
 *    url (route-table merge semantics). The query-visibility intent is kept.
 *  - response.is() no longer exists (type negotiation is request-side);
 *    that case was dropped — see the migration report.
 */

import { describe, expect, it, vi } from "vitest";

import { Honu, Router, isRedirectStatus, type Context } from "../src/index.ts";
import { createEmitter } from "../src/core/emitter.ts";

const quiet = { env: "test" } as const;

/** Drive a request through an app and capture the context for inspection. */
const probe = async (
  init: { url: string; method?: string; headers?: Record<string, string> },
  setup?: (app: InstanceType<typeof Honu>) => void,
): Promise<Context> => {
  let captured: Context | undefined;
  const app = new Honu(quiet);
  app.use(async (c) => {
    captured = c;
    c.body = "done";
  });
  setup?.(app);
  await app.handle(new Request(init.url, init));
  if (captured === undefined) throw new Error("probe middleware did not run");
  return captured;
};

describe("agent audit: request url/query cache chain", () => {
  it("re-assigning url invalidates the parsed query cache", async () => {
    const c = await probe({ url: "http://localhost:3000/old?a=1" });
    expect(c.query).toEqual({ a: "1" }); // build the cache first
    c.url = "/new?b=2";
    expect(c.url).toBe("/new?b=2");
    expect(c.querystring).toBe("b=2");
    expect(c.search).toBe("?b=2");
    expect(c.query).toEqual({ b: "2" });
    expect(c.originalUrl).toBe("/old?a=1");
  });

  it("url rewrites to a query-less target clear the parsed query", async () => {
    const c = await probe({ url: "http://localhost:3000/old?a=1&b=2" });
    expect(c.query).toEqual({ a: "1", b: "2" });
    c.url = "/plain";
    expect(c.querystring).toBe("");
    expect(c.query).toEqual({});
  });

  it("path setter rewrites the pathname while keeping the query string", async () => {
    const c = await probe({ url: "http://localhost:3000/old?a=1&b=2" });
    const before = c.query;
    c.path = "/rewritten";
    expect(c.path).toBe("/rewritten");
    expect(c.url).toBe("/rewritten?a=1&b=2");
    expect(c.querystring).toBe("a=1&b=2");
    expect(c.query).toEqual(before); // same query, recomputed after the rewrite
    expect(c.originalUrl).toBe("/old?a=1&b=2");
  });

  it("path setter works without a query on the bare context", async () => {
    const c = await probe({ url: "http://localhost:3000/a/b" });
    c.path = "/c";
    expect(c.path).toBe("/c");
    expect(c.url).toBe("/c");
    expect(c.querystring).toBe("");
  });
});

describe("agent audit: freshness (fresh@0.5.2 semantics)", () => {
  const freshProbe = async (
    responseSetup: (c: Context) => void,
    headers: Record<string, string>,
  ): Promise<boolean> => {
    let fresh: boolean | undefined;
    const app = new Honu(quiet);
    app.get("/", (c) => {
      c.status = 200;
      responseSetup(c);
      fresh = c.fresh;
      c.body = "x";
    });
    await app.handle(new Request("http://localhost:3000/", { headers }));
    return fresh === true;
  };

  it("Cache-Control: no-cache forces a stale response even when the etag matches", async () => {
    const fresh = await freshProbe(
      (c) => {
        c.etag = "v1";
      },
      { "if-none-match": '"v1"', "cache-control": "no-cache" },
    );
    expect(fresh).toBe(false);
  });

  it("a matching etag is not enough when If-Modified-Since has no validator", async () => {
    const fresh = await freshProbe(
      (c) => {
        c.etag = "v1";
      },
      { "if-none-match": '"v1"', "if-modified-since": "Mon, 01 Jan 2024 00:00:00 GMT" },
    );
    expect(fresh).toBe(false);
  });

  it("a matching etag with an outdated If-Modified-Since is stale (both validators)", async () => {
    const fresh = await freshProbe(
      (c) => {
        c.etag = "v1";
        c.lastModified = new Date(Date.UTC(2025, 0, 1));
      },
      {
        "if-none-match": '"v1"',
        "if-modified-since": "Mon, 01 Jan 2024 00:00:00 GMT", // predates Last-Modified
      },
    );
    expect(fresh).toBe(false);
  });

  it("etag and last-modified both matching is fresh", async () => {
    const fresh = await freshProbe(
      (c) => {
        c.etag = "v1";
        c.lastModified = new Date(Date.UTC(2024, 0, 1));
      },
      {
        "if-none-match": '"v1"',
        "if-modified-since": "Mon, 01 Jan 2024 00:00:00 GMT",
      },
    );
    expect(fresh).toBe(true);
  });

  it("If-None-Match without a response etag never falls back to last-modified", async () => {
    const fresh = await freshProbe(
      (c) => {
        c.lastModified = new Date(Date.UTC(2020, 0, 1));
      },
      {
        "if-none-match": '"unrelated"',
        "if-modified-since": "Wed, 01 Jan 2025 00:00:00 GMT",
      },
    );
    expect(fresh).toBe(false);
  });

  it("If-None-Match: * means fresh with no validators at all", async () => {
    const fresh = await freshProbe(() => {}, { "if-none-match": "*" });
    expect(fresh).toBe(true);
  });
});

describe("agent audit: Referrer alias and back()", () => {
  it("get() reads the Referer header through both spellings", async () => {
    const c = await probe({
      url: "http://localhost:3000/",
      headers: { Referer: "http://localhost:3000/login" },
    });
    expect(c.get("Referrer")).toBe("http://localhost:3000/login");
    expect(c.get("referrer")).toBe("http://localhost:3000/login");
    expect(c.get("Referer")).toBe("http://localhost:3000/login");
  });

  it("back() redirects to a same-origin Referer from a real request", async () => {
    const app = new Honu(quiet);
    app.get("/target", (c) => c.back("/alt"));
    const res = await app.handle(
      new Request("http://example.com:3000/target", {
        headers: { Referer: "http://example.com:3000/login" },
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://example.com:3000/login");
  });

  it('redirect("back") resolves through the Referer header', async () => {
    const app = new Honu(quiet);
    app.get("/", (c) => c.redirect("back"));
    const res = await app.handle(
      new Request("http://example.com/", { headers: { Referer: "/previous" } }),
    );
    expect(res.headers.get("location")).toBe("/previous");
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
    const app = new Honu(quiet);
    app.get("/", (c) => {
      c.status = 304;
      c.redirect("/next");
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/next");
  });

  it("redirect() keeps 305 (a real redirect status)", async () => {
    const app = new Honu(quiet);
    app.get("/", (c) => {
      c.status = 305;
      c.redirect("/proxy");
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(305);
    expect(res.headers.get("location")).toBe("/proxy");
  });

  it("redirect() resets a custom status message when coercing to 302", async () => {
    let message = "";
    const app = new Honu(quiet);
    app.get("/", (c) => {
      c.status = 404;
      c.message = "Custom Phrase";
      c.redirect("/elsewhere");
      message = c.message;
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(302);
    expect(message).toBe("Found");
  });
});

describe("agent audit: emitter once/off edges", () => {
  it("off() with an unknown listener is a no-op and keeps other listeners", () => {
    const app = new Honu(quiet);
    const keep = vi.fn();
    app.onError(keep);
    app.off("error", vi.fn());
    expect(app.listenerCount("error")).toBe(1);
    app.emit("error", new Error("x"));
    expect(keep).toHaveBeenCalledTimes(1);
  });

  it("the disposer returned by once() unsubscribes the wrapper", () => {
    const emitter = createEmitter();
    const spy = vi.fn();
    const dispose = emitter.once("error", spy);
    dispose();
    expect(emitter.emit("error", new Error("x"))).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    expect(emitter.listenerCount("error")).toBe(0);
  });

  it("once() fires exactly once across repeated emits", () => {
    const emitter = createEmitter();
    const spy = vi.fn();
    emitter.once("error", spy);
    emitter.emit("error", new Error("a"));
    emitter.emit("error", new Error("b"));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("re-subscribing after the last off() works on a fresh list", () => {
    const app = new Honu(quiet);
    const first = vi.fn();
    app.onError(first);
    app.off("error", first);
    expect(app.listenerCount("error")).toBe(0);
    const second = vi.fn();
    app.onError(second);
    app.emit("error", new Error("c"));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe("agent audit: router mount and trie encoding", () => {
  it("router.use() middleware keeps the query string visible downstream", async () => {
    const router = new Router();
    const app = new Honu(quiet);
    const seen: string[] = [];
    // Upstream of the mounted router: after next() resolves the url is intact.
    app.use(async (c, next) => {
      await next();
      seen.push(`upstream-after:${c.url}`);
    });
    router.use(async (c, next) => {
      seen.push(`mounted:${c.url}`, `query:${JSON.stringify(c.query)}`);
      await next();
      // route-table merge semantics: no koa-mount url stripping — the
      // mounted subtree still sees the full url.
      seen.push(`mounted-after:${c.url}`);
    });
    router.get("/users", (c) => {
      c.body = { page: c.query["page"] };
    });
    app.mount("/api", router);
    const res = await app.handle(new Request("http://localhost:3000/api/users?page=2&size=10"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ page: "2" });
    expect(seen[0]).toBe("mounted:/api/users?page=2&size=10");
    expect(seen[1]).toBe(`query:${JSON.stringify({ page: "2", size: "10" })}`);
    expect(seen[2]).toBe("mounted-after:/api/users?page=2&size=10");
    expect(seen[3]).toBe("upstream-after:/api/users?page=2&size=10");
  });

  it("percent-encoded static segments inside dynamic routes match", async () => {
    const app = new Honu(quiet);
    app.get("/caf%C3%A9/:id", (c) => {
      c.body = { id: c.params?.["id"] };
    });
    const res = await app.handle(new Request("http://localhost:3000/caf%C3%A9/42"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "42" });
  });

  it("unicode route patterns match percent-encoded requests", async () => {
    const app = new Honu(quiet);
    app.get("/café/:id", (c) => {
      c.body = `ok:${c.params?.["id"]}`;
    });
    const res = await app.handle(new Request("http://localhost:3000/caf%C3%A9/7"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok:7");
  });

  it("keeps %2F inside a single param segment (no path splitting)", async () => {
    const app = new Honu(quiet);
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
    c.set("Transfer-Encoding", "chunked");
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

describe("agent audit: app.onerror contract", () => {
  it("tolerates a null error outside the test env", () => {
    const app = new Honu({ env: "development" });
    expect(() => app.onerror(null as unknown as Error)).not.toThrow();
  });

  it("still forwards real errors to listeners", () => {
    const app = new Honu({ env: "development" });
    const spy = vi.fn();
    app.onError(spy);
    app.onerror(new Error("real"));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("agent audit: compose next() guard under nesting", () => {
  it("rejects a second next() from a route handler nested in app middleware", async () => {
    const app = new Honu(quiet);
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
    const app = new Honu(quiet);
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
