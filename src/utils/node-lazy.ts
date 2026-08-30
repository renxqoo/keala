/**
 * Sync-lazy access to Node built-in modules.
 *
 * Importing the framework must not load any native bridge: `bun-koa` at idle
 * pulls in no crypto/fs bindings until a feature that needs them first runs
 * (~5MB RSS on Bun). Dynamic `import()` cannot serve the synchronous call
 * sites (cookie signing, CSRF issue), so laziness goes through
 * `createRequire` — synchronous and standard on both Bun and Node ESM.
 *
 * The accessor is a single-slot closure: one branch per call after the first,
 * and the module registry does the caching behind `require` regardless.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const lazyModule = <T>(id: string): (() => T) => {
  let cached: T | undefined;
  return () => (cached ??= require(id) as T);
};

/** node:crypto — loaded by the first signed cookie / CSRF token / password verify. */
export const nodeCrypto = lazyModule<typeof import("node:crypto")>("node:crypto");
/** node:fs/promises — loaded by the first serveStatic request. */
export const nodeFsPromises = lazyModule<typeof import("node:fs/promises")>("node:fs/promises");
/** node:path — loaded by the first serveStatic request. */
export const nodePath = lazyModule<typeof import("node:path")>("node:path");
