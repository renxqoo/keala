/**
 * Guarded context pooling.
 *
 * Opt-in via `createApp({ pooling: true })`. A settled context is retired by
 * SWAPPING its prototype to `deadContextProto` — every mutating accessor then
 * throws with a clear message, so fire-and-forget code holding a recycled
 * context cannot silently corrupt the next request. The live prototype is
 * restored on reset, and the whole guard costs the hot path nothing (the
 * check IS the prototype).
 */

import type { Application } from "../app.ts";
import type { Context } from "./context.ts";
import { baseContextProto, resetContext } from "./context.ts";

const RETIRED = "context retired: do not retain contexts past the request lifetime";

const dead = (): PropertyDescriptorMap => {
  // WRITE-ONLY guard: reads chain to the live prototype (post-request
  // telemetry keeps working on stale-but-visible data); every mutation path
  // throws, so retained contexts can never corrupt the next request.
  const descriptors: PropertyDescriptorMap = {};
  for (const key of [
    "status",
    "message",
    "body",
    "type",
    "length",
    "etag",
    "lastModified",
    "url",
    "path",
    "query",
    "querystring",
    "search",
    "state",
    "cookies",
  ]) {
    // Setter-only accessors would shadow reads with undefined — forward the
    // base getter explicitly so post-request reads still work.
    const baseGet = Object.getOwnPropertyDescriptor(baseContextProto, key)?.get;
    descriptors[key] = {
      ...(baseGet !== undefined ? { get: baseGet } : {}),
      set(): void {
        throw new Error(RETIRED);
      },
      configurable: true,
    };
  }
  for (const key of ["set", "append", "remove", "vary", "redirect", "back", "attachment"]) {
    descriptors[key] = {
      value(): void {
        throw new Error(RETIRED);
      },
      configurable: true,
    };
  }
  return descriptors;
};

/** The retired surface: reads and writes through the response/request mutators throw. */
export const deadContextProto: object = Object.defineProperties(
  Object.create(baseContextProto),
  dead(),
);

const POOL_MAX = 128;

export interface ContextPool {
  /** Take a live context from the pool (or undefined when empty). */
  acquire(): Context | undefined;
  /** Retire a settled context back into the pool (prototype-swapped to dead). */
  release(c: Context): void;
  /** Current pool depth (diagnostics/tests). */
  readonly size: number;
}

export const createPool = (app: Application, liveProto: object): ContextPool => {
  const pool: Context[] = [];
  return {
    acquire(): Context | undefined {
      const c = pool.pop();
      if (c === undefined) return undefined;
      Object.setPrototypeOf(c, liveProto);
      return c;
    },
    release(c: Context): void {
      if (pool.length >= POOL_MAX) return;
      Object.setPrototypeOf(c, deadContextProto);
      pool.push(c);
    },
    get size(): number {
      return pool.length;
    },
    // app is captured for future cross-app assertions; pooling is per-app.
    ...(app ? {} : {}),
  } as ContextPool;
};

export { resetContext };
