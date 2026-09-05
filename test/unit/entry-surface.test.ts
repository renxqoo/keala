/**
 * Entry-surface contract: the ROOT entry carries the app surface (core, the
 * body plugin, in-handler helpers) while middleware stays at the
 * `keala/middleware` aggregate and the Node adapter at `keala/node`.
 * These locks keep the split honest — middleware sneaking back into the root
 * barrel would re-add its idle-memory cost for every importer.
 */

import { describe, expect, it } from "vitest";

import * as root from "../../src/index.ts";
import * as middleware from "../../src/middleware/index.ts";

const ROOT_EXPORTS = new Set([
  // core
  "Keala",
  "Router",
  "compose",
  "direct",
  "NOOP_TAIL",
  "createMiddleware",
  "createContext",
  "resetContext",
  "baseContextProto",
  "signCookie",
  "unsignCookie",
  "parseCookies",
  "serializeCookie",
  "createError",
  "isHttpError",
  "noOpFor",
  "normalizeError",
  "isEmptyStatus",
  "isRedirectStatus",
  "isValidErrorStatus",
  "statusMessage",
  "startBunServer",
  "compilePattern",
  // R4.6 lifecycle admission strategies (U1)
  "failFastAdmission",
  "queueAdmission",
  // HTTP/fs safety primitives (DOGFOOD-R1 C2 — consumers build file-backed
  // tiers without re-implementing serveStatic's inline semantics)
  "weakEtag",
  "isNotModified",
  "resolveRelativeSegments",
  "isWithinRoot",
  "findSymlink",
  // plugin (the body reader)
  "createBodyParser",
  "bodyOf",
  "readBodyLimited",
  // helpers (in-handler utilities)
  "stream",
  "streamText",
  "streamSSE",
  "disableIdleTimeout",
  "html",
  "raw",
  "escapeHtml",
  "hashPassword",
  "verifyPassword",
  "bunPasswordHasher",
  "pbkdf2PasswordHasher",
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
  it("the root barrel exports exactly the app surface", () => {
    const names = Object.keys(root).sort();
    expect(names).toEqual([...ROOT_EXPORTS].sort());
  });

  it("the root barrel leaks no middleware", () => {
    for (const name of MIDDLEWARE_FACTORIES) {
      expect((root as Record<string, unknown>)[name]).toBeUndefined();
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
