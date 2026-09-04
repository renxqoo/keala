/**
 * The 0.7 native-API contract (docs/KEALA-NATIVE-API.md §10):
 *  - the request is read-only (every former koa rewriter is gone);
 *  - the commit contract (post-commit body/status throw, header writers
 *    decorate the committed Response);
 *  - 405/501 answer with Allow and an empty body;
 *  - the context's public surface IS the §8 quick reference — nothing
 *    beyond it ships.
 */

import { describe, expect, it } from "vitest";

import { Keala } from "../src/index.ts";
import {
  baseContextProto,
  CONTEXT_SLOT_KEYS,
  createContext,
  type Context,
} from "../src/core/context/context.ts";
import { secureHeaders } from "../src/middleware/headers.ts";

const quiet = { env: "test" } as const;
const request = (path = "/"): Request => new Request(`http://localhost${path}`);

describe("0.7: the request is read-only", () => {
  it("every former rewriter throws on assignment", () => {
    const app = new Keala(quiet);
    let ctx: Context | undefined;
    app.use((c) => {
      ctx = c;
      c.body = "ok";
    });
    void app.handle(request());
    const c = ctx as unknown as Record<string, unknown>;
    for (const key of ["url", "path", "search", "querystring"]) {
      expect(() => {
        "use strict";
        c[key] = "/rewritten";
      }).toThrow(TypeError);
    }
  });

  it("the deleted koa accessors are absent from the surface", () => {
    const app = new Keala(quiet);
    const c = createContext(app, baseContextProto, request(), undefined);
    for (const key of [
      "message",
      "fresh",
      "stale",
      "vary",
      "back",
      "subdomains",
      "ips",
      "hostname",
      "charset",
      "reqType",
      "originalUrl",
      "acceptsCharsets",
      "acceptsLanguages",
      "toJSON",
      "headerSent",
      "set",
    ]) {
      expect((c as unknown as Record<string, unknown>)[key]).toBeUndefined();
      expect(key in baseContextProto).toBe(false);
    }
  });
});

describe("0.7: commit contract", () => {
  it("post-commit header writers still decorate the committed Response", async () => {
    const app = new Keala({ env: "production" });
    app.use(async (c, next) => {
      await next();
      c.type = "application/custom";
      c.length = 7;
      c.etag = "v1";
      c.lastModified = new Date(Date.UTC(2026, 8, 4));
      c.attachment("report.pdf", { type: "inline" });
      c.append("X-Extra", "one");
      c.remove("X-Extra");
    });
    app.get("/", (c) => c.text("payload"));

    const res = await app.handle(request());
    expect(res.headers.get("content-type")).toBe("application/custom");
    expect(res.headers.get("content-length")).toBe("7");
    expect(res.headers.get("etag")).toBe('"v1"');
    expect(res.headers.get("last-modified")).toBe("Fri, 04 Sep 2026 00:00:00 GMT");
    expect(res.headers.get("content-disposition")).toBe('inline; filename="report.pdf"');
    expect(res.headers.get("x-extra")).toBe(null);
    expect(await res.text()).toBe("payload");
  });

  it("secureHeaders survive an outer middleware throwing after a commit", async () => {
    const app = new Keala({ env: "production" });
    app.use(secureHeaders());
    app.use(async (c, next) => {
      await next();
      c.setHeader("X-Outer", "ran");
      throw new Error("late failure");
    });
    app.get("/", (c) => c.text("committed"));

    const res = await app.handle(request());
    expect(res.status).toBe(500);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });
});

describe("0.7: synthesized method answers are bodiless", () => {
  it("405 answers with Allow and an empty body", async () => {
    const app = new Keala(quiet);
    app.get("/only", (c) => c.text("get"));
    const res = await app.handle(new Request("http://localhost/only", { method: "POST" }));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("HEAD, GET");
    expect(await res.text()).toBe("");
  });

  it("501 answers with Allow and an empty body for unknown methods", async () => {
    const app = new Keala(quiet);
    app.get("/only", (c) => c.text("get"));
    // MKCOL: outside keala's known-method list on both runtimes (Bun's
    // Request constructor normalizes non-allowlisted methods like "FANCY"
    // to GET, which would quietly test the GET handler instead).
    const res = await app.handle(new Request("http://localhost/only", { method: "MKCOL" }));
    expect(res.status).toBe(501);
    expect(res.headers.get("allow")).toBe("HEAD, GET");
    expect(await res.text()).toBe("");
  });
});

describe("0.7: the context surface is the §8 quick reference", () => {
  it("baseContextProto carries exactly the public API plus internal slots", () => {
    const internal = new Set([
      ...CONTEXT_SLOT_KEYS,
      "appValue",
      "appSettings",
      "rawRequest",
      "runtimeValue",
    ]);
    const expected = [
      // request (read-only)
      "raw",
      "signal",
      "method",
      "url",
      "path",
      "querystring",
      "search",
      "query",
      "queries",
      "URL",
      "headers",
      "runtime",
      "header",
      "get",
      "host",
      "protocol",
      "secure",
      "ip",
      "origin",
      "href",
      "idempotent",
      "reqLength",
      "is",
      "accepts",
      "acceptsEncodings",
      // response (staged pre-commit, decorating post-commit)
      "res",
      "status",
      "body",
      "type",
      "length",
      "etag",
      "lastModified",
      "setHeader",
      "append",
      "remove",
      "has",
      "resHeader",
      "attachment",
      "redirect",
      "text",
      "json",
      "html",
      // core
      "app",
      "routerAllowed",
      "state",
      "cookies",
      "throw",
      "assert",
    ].sort();
    const surface = Object.getOwnPropertyNames(baseContextProto)
      .filter((key) => !internal.has(key))
      .sort();
    expect(surface).toEqual(expected);
  });
});
