/**
 * Entry-surface contract: the ROOT entry is the core only; middleware comes
 * from the `bun-koa/middleware` aggregate (or per-file subpaths). These locks
 * keep the split honest — a middleware re-export sneaking back into the root
 * barrel would silently re-add its idle-memory cost for every importer.
 */

import { describe, expect, it } from "vitest";

import * as core from "../src/index.ts";
import * as middleware from "../src/middleware/index.ts";

const CORE_EXPORTS = new Set([
  "createApp",
  "createRouter",
  "compose",
  "direct",
  "NOOP_TAIL",
  "createContext",
  "resetContext",
  "baseContextProto",
  "signCookie",
  "unsignCookie",
  "parseCookies",
  "serializeCookie",
  "createError",
  "isHttpError",
  "normalizeError",
  "isEmptyStatus",
  "isRedirectStatus",
  "isValidErrorStatus",
  "statusMessage",
  "startBunServer",
  "compilePattern",
]);

const MIDDLEWARE_FACTORIES = [
  "basicAuth",
  "bearerAuth",
  "cache",
  "cors",
  "csrf",
  "csrfToken",
  "csrfTokenGuard",
  "etag",
  "compress",
  "secureHeaders",
  "requestId",
  "timing",
  "logger",
  "bodyLimit",
  "timeout",
  "serveStatic",
  "validator",
];

describe("entry surface", () => {
  it("the root barrel exports exactly the core surface", () => {
    const names = Object.keys(core).sort();
    expect(names).toEqual([...CORE_EXPORTS].sort());
  });

  it("the root barrel leaks no middleware/plugins/helpers", () => {
    for (const name of [
      ...MIDDLEWARE_FACTORIES,
      "createBodyParser",
      "streamSSE",
      "hashPassword",
      "html",
    ]) {
      expect((core as Record<string, unknown>)[name]).toBeUndefined();
    }
  });

  it("the middleware aggregate exports every pipeline factory", () => {
    for (const name of MIDDLEWARE_FACTORIES) {
      expect(typeof (middleware as Record<string, unknown>)[name]).toBe("function");
    }
  });

  it("every middleware factory is a factory: it returns a function", () => {
    const args: Record<string, unknown[]> = {
      cors: [{}],
      csrf: [{}],
      etag: [{}],
      compress: [{}],
      bodyLimit: [1024],
      secureHeaders: [{}],
    };
    const factories = middleware as unknown as Record<
      string,
      undefined | ((...a: unknown[]) => unknown)
    >;
    for (const name of Object.keys(args)) {
      const factory = factories[name]?.(...(args[name] as unknown[]));
      expect(typeof factory).toBe("function");
    }
  });
});
