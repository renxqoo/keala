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

import {
  Keala,
  Router,
  createError,
  isRedirectStatus,
  normalizeError,
  type Context,
} from "../../src/index.ts";
import { charsetFromContentType, expandContentType } from "../../src/utils/mime.ts";

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
    expect(c.header("Referrer")).toBe("http://localhost:3000/login");
    expect(c.header("referrer")).toBe("http://localhost:3000/login");
    expect(c.header("Referer")).toBe("http://localhost:3000/login");
  });
});

describe("agent audit: redirect status classification (statuses.redirect)", () => {
  it("the redirect class is exactly 300/301/302/303/305/307/308", () => {
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
      return c.redirect("/next");
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/next");
  });

  it("redirect() honors an explicit 305 code (a real redirect status)", async () => {
    const app = new Keala(quiet);
    app.get("/", (c) => {
      return c.redirect("/proxy", 305);
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
      c.body = { id: c.params("id") };
    });
    const res = await app.handle(new Request("http://localhost:3000/caf%C3%A9/42"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "42" });
  });

  it("unicode route patterns match percent-encoded requests", async () => {
    const app = new Keala(quiet);
    app.get("/café/:id", (c) => {
      c.body = `ok:${c.params("id")}`;
    });
    const res = await app.handle(new Request("http://localhost:3000/caf%C3%A9/7"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok:7");
  });

  it("keeps %2F inside a single param segment (no path splitting)", async () => {
    const app = new Keala(quiet);
    app.get("/files/:name", (c) => {
      c.body = `file:${c.params("name")}`;
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

/**
 * Round-7 public-surface audit — CONFIRMED RED tests only.
 *
 * Scope: exported HTTP helpers, app decoration/events, MIME parsing and
 * standalone core contracts. No implementation changes live in this file.
 */

const request = (path = "/"): Request => new Request(`http://localhost:3000${path}`);

describe("R7-SURFACE-1 [HIGH] decorate preserves ordinary service objects", () => {
  it("does not reinterpret every object with a get() method as a property descriptor", async () => {
    const app = new Keala(quiet);
    const repository = {
      get(key: string) {
        return `record:${key}`;
      },
    };
    app.decorate("repository", repository);

    let observed: unknown;
    app.get("/", (c) => {
      observed = (c as unknown as { repository: unknown }).repository;
      c.body = "ok";
    });
    const response = await app.handle(request());

    // Public contract: decorate(key, value) installs VALUE. Expected: the
    // repository object itself. Actual: the `{ get }` shape is treated as an
    // accessor descriptor, so repository.get runs with the Context as `this`
    // and no key; the decorated value becomes "record:undefined".
    // Root cause: src/core/context/decorate.ts:38-49.
    expect(response.status).toBe(200);
    expect(observed).toBe(repository);
    expect((observed as typeof repository).get("user-1")).toBe("record:user-1");
  });
});

describe("R7-SURFACE-2 [MEDIUM] non-Error throwables are always normalizable", () => {
  it.each([
    ["bigint", 1n],
    [
      "circular object",
      (() => {
        const value: { self?: unknown } = {};
        value.self = value;
        return value;
      })(),
    ],
  ])("normalizes a %s without throwing from the error path", (_label, thrown) => {
    // Expected: normalizeError fulfills its documented total-function
    // contract and returns an Error whose cause is the original throwable.
    // Actual: JSON.stringify throws for BigInt and circular structures.
    // Root cause: src/http/errors.ts:147-150.
    const normalized = normalizeError(thrown);
    expect(normalized).toBeInstanceOf(Error);
    expect(normalized.cause).toBe(thrown);
  });

  it("delivers a BigInt throwable to the public app error listener", async () => {
    const app = new Keala(quiet);
    let heard: Error | undefined;
    app.onError((error) => {
      heard = error;
    });
    app.get("/", () => {
      throw 1n;
    });
    const response = await app.handle(request());

    // R4.3 contract: the mapper ALWAYS receives an HttpError — the BigInt
    // normalizes (cause chain preserved) and wraps as an unexposed 500.
    expect(response.status).toBe(500);
    expect(heard).toBeInstanceOf(Error);
    expect((heard as { status?: number }).status).toBe(500);
    expect((heard as { cause?: unknown }).cause).toBe(1n);
  });
});

describe("R7-SURFACE-3 [MEDIUM] HttpError status aliases stay coherent", () => {
  it("does not let arbitrary props overwrite statusCode independently", () => {
    // statusCode is documented as an alias of status. Expected: both remain
    // 404, as in http-errors. Actual: the generic props-copy loop excludes
    // `status` but not `statusCode`, producing an internally inconsistent
    // public HttpError.
    // Root cause: src/http/errors.ts:121-132.
    const error = createError(404, { statusCode: 503 });
    expect(error.status).toBe(404);
  });
});

describe("R7-SURFACE-5 [MEDIUM] onError validates listeners at subscription time", () => {
  it("rejects a non-function instead of poisoning a later error emission", () => {
    const app = new Keala(quiet);

    // Every other registration API validates callable inputs eagerly.
    // Expected: setup-time TypeError. Actual: emitter.add stores null and a
    // later error path fails while trying to invoke it.
    // Root cause: src/core/app.ts:479-481 + src/core/emitter.ts:16-19.
    expect(() => app.onError(null as never)).toThrow(TypeError);
  });
});

describe("R7-SURFACE-6 [MEDIUM] Content-Type quoted-pairs do not break parameter parsing", () => {
  it("ignores a semicolon after an escaped quote inside another parameter", () => {
    const contentType = 'text/plain; note="a\\\";charset=decoy"; charset=utf-8';

    // RFC quoted-string permits quoted-pair (`\"`). Expected: the semicolon
    // remains inside note and the real charset after its closing quote wins.
    // Actual: every quote toggles state, including escaped quotes, so the
    // decoy is split out and returned as the charset.
    // Root cause: src/utils/mime.ts:170-181.
    expect(charsetFromContentType(contentType)).toBe("utf-8");
  });
});

describe("R7-SURFACE-7 [LOW] Content-Type extension expansion is case-insensitive", () => {
  it.each(["HTML", ".HTML", "Json", "TXT"])("keeps the default charset for %s", (value) => {
    // MIME extensions are case-insensitive. Expected: the same result as the
    // lowercase shorthand, including its default UTF-8 charset. Actual: the
    // direct map misses and the extension fallback returns a bare media type.
    // Root cause: src/utils/mime.ts:126-134.
    expect(expandContentType(value)).toBe(expandContentType(value.toLowerCase()));
  });
});
