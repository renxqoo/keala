/**
 * Guarded context pooling.
 *
 * Opt-in via `createApp({ pooling: true })`. A settled context is retired by
 * SWAPPING its prototype to `deadContextProto` — every mutating accessor then
 * throws with a clear message, so fire-and-forget code holding a retired
 * context cannot silently corrupt the next request. The live prototype is
 * restored on reset, and the whole guard costs the hot path nothing (the
 * check IS the prototype).
 *
 * Guarantee boundary: object identity cannot carry generations. The guard
 * covers the window from retirement until the object's next acquire — writes
 * in that window throw. Once the object is live again for a NEW request, a
 * stale reference held by older user code (e.g. captured in a timer) is
 * indistinguishable from the new owner's own writes; only a per-request proxy
 * could separate them, and that would cost more than pooling saves. The
 * framework covers what it CAN observe: registered floating `next()` branches
 * (see core/branches.ts) hold off recycling until they settle. Retaining a
 * context past its request's lifetime is unsupported on every path.
 */

import type { Application } from "../app.ts";
import type { Context } from "./context.ts";
import { resetContext } from "./context.ts";
import { drainBranches } from "../branches.ts";

const RETIRED = "context retired: do not retain contexts past the request lifetime";

/**
 * Build the retired surface for one app's contexts. WRITE-ONLY guard: reads
 * chain to the app's LIVE prototype (post-request telemetry keeps working,
 * including `app.decorate()` members — the guard must chain to the app's own
 * derived proto, not the shared base); every mutation path throws, so
 * retained contexts can never corrupt the next request.
 */
/** First getter for `key` on the prototype CHAIN (the live accessors live on
 *  the shared base; decorate() may override them higher up). */
const getterOnChain = (proto: object, key: string): (() => unknown) | undefined => {
  for (let at: object | null = proto; at !== null; at = Object.getPrototypeOf(at)) {
    const get = Object.getOwnPropertyDescriptor(at, key)?.get;
    if (get !== undefined) return get;
  }
  return undefined;
};

export const deadProtoFor = (liveProto: object): object => {
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
    // live getter explicitly so post-request reads still work.
    const liveGet = getterOnChain(liveProto, key);
    descriptors[key] = {
      ...(liveGet !== undefined ? { get: liveGet } : {}),
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
  return Object.defineProperties(Object.create(liveProto), descriptors);
};

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
  const deadProto: object = deadProtoFor(liveProto);
  return {
    acquire(): Context | undefined {
      const c = pool.pop();
      if (c === undefined) return undefined;
      Object.setPrototypeOf(c, liveProto);
      return c;
    },
    release(c: Context): void {
      if (pool.length >= POOL_MAX) return;
      Object.setPrototypeOf(c, deadProto);
      pool.push(c);
    },
    get size(): number {
      return pool.length;
    },
    // app is captured for future cross-app assertions; pooling is per-app.
    ...(app ? {} : {}),
  } as ContextPool;
};

/**
 * Retire `c` into the pool as soon as its response is SAFE to recycle.
 * Null-body responses retire at once; bodied ones only once the consumer
 * finishes (or cancels): the body is consumed AFTER handle() returns, and
 * anything it captured (stream callbacks, onStreamError) must keep reading
 * THIS request's context — recycling earlier leaks the next request's data
 * into in-flight bodies. Registered floating branches hold off the final
 * release until they settle. The wrapper observes completion pull-based, so
 * backpressure passes through and nothing is buffered; a consumer that
 * abandons the body without cancelling simply never returns the context.
 */
export const retireWithBody = (pool: ContextPool, c: Context, value: Response): Response => {
  let retired = false;
  const retire = (): void => {
    if (retired) return;
    retired = true;
    // A still-running floating branch owns this context's state — release
    // only once it can no longer mutate.
    const drain = drainBranches(c);
    if (drain === null) pool.release(c);
    else void drain.then(() => pool.release(c));
  };
  const body = value.body;
  if (body === null) {
    retire();
    return value;
  }
  // Evolving let: the reader type differs across the DOM/Bun stream libs —
  // inferring from the assignment keeps both happy.
  let reader;
  try {
    reader = body.getReader();
  } catch {
    // A body-locked Response is a handler bug — but the never-reject contract
    // on app.handle is absolute: recycle the context and answer a plain 500
    // instead of throwing out of (or rejecting) the handler pipeline.
    retire();
    return new Response("Internal Server Error", {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  return new Response(
    new ReadableStream({
      async pull(controller) {
        try {
          const { done, value: chunk } = await reader.read();
          if (done) {
            controller.close();
            retire();
            return;
          }
          controller.enqueue(chunk);
        } catch (err) {
          retire();
          controller.error(err);
        }
      },
      cancel(reason) {
        void reader.cancel(reason).catch(() => undefined);
        retire();
      },
    }),
    { status: value.status, statusText: value.statusText, headers: value.headers },
  );
};

export { resetContext };
