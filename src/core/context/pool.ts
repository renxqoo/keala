/**
 * Guarded context pooling.
 *
 * Opt-in via `new Keala({ pooling: true })`. A settled context is retired by
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
 * (see core/branches.ts) hold off recycling until they settle — compose
 * registers BOTH floating shapes (sync return-after-next and an async
 * handler settling before its floated next(), HA-1). Retaining a context
 * past its request's lifetime through any other escape hatch (a raw timer
 * capture that never touched next()) is still unsupported.
 *
 * PERF-1 cost profile (measured @ review-0.6.2, bench-zz paired medians,
 * 64 conns / 5s / 5 rounds): the recycle surcharge on the plain /text hot
 * path is ~11.7% median (unpooled 191,603 rps vs pooled 171,533 rps; raw
 * user-built Responses are 3.1x off — but that leg is dominated by the
 * consumption-tracking body wrapper, not by the slots below). Components:
 * sweepForeignKeys' full Reflect.ownKeys scan (~641ns), the two
 * setPrototypeOf swaps release/acquire perform (~422ns) and
 * clearRequestSlots' 30 sentinel re-assignments (~398ns). The sweep cannot
 * be safely skipped: a handler's plain `c.x = 1` write on a live-proto
 * context is un-interceptable, so any "no foreign keys seen" flag would be
 * a guess — only a per-request proxy could observe those writes, and that
 * costs more than pooling saves. The prototype swaps ARE the write guard;
 * removing either opens the retirement window. Applicability: pooling is
 * for allocation-heavy/streaming workloads where GC pressure dominates —
 * on the steady /text shape the recycle bookkeeping costs more than the
 * allocation it saves. release() early-exits a full pool before swapping.
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
    "body",
    "type",
    "length",
    "etag",
    "lastModified",
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
  for (const key of ["setHeader", "append", "remove", "redirect", "attachment"]) {
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
  // DEAD-12: `app` stays in the exported signature for future cross-app
  // assertions; pooling is per-app by construction (each app builds its own
  // pool). Reference it so the parameter is not dead weight.
  void app;
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
  } as ContextPool;
};

/**
 * Retire `c` into the pool as soon as its response is SAFE to recycle.
 *
 * Three body kinds, three retire times. Null bodies retire at once.
 * Framework-built snapshot bodies (string/bytes/JSON text/Blob — the
 * `directBodyResponseValue` identity) retire at once too, UNWRAPPED: an
 * immutable snapshot cannot reference this context, and passing it through
 * the wrapper below would both destroy Bun's serve-time string MIME
 * inference (the client gets no content-type) and force both adapters off
 * their direct-write paths. Everything else — stream bodies, user-built
 * Responses of unknown body kind — retires only once the consumer finishes
 * or cancels: the body is consumed AFTER handle() returns, and anything it
 * captured (stream callbacks, onStreamError) must keep reading THIS
 * request's context — recycling earlier leaks the next request's data into
 * in-flight bodies. Registered floating branches hold off the final
 * release until they settle. The wrapper observes completion pull-based, so
 * backpressure passes through and nothing is buffered; a consumer that
 * abandons the body without cancelling simply never returns the context.
 *
 * Consequence of the unknown-kind bucket: a user's bare
 * `new Response(string)` (committed, return-style, or from a notFound
 * handler) is wrapped under pooling, and on Bun that costs its implicit
 * text/plain — the same documented limitation `rebuildCommitted` carries.
 * Set an explicit content-type or use the sugar helpers.
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
  // Snapshot-body fast path: the response was framework-built from a
  // string/bytes/JSON text/Blob that cannot reference this context, so it
  // retires NOW, unwrapped. The identity check deliberately precedes any
  // `.body` access — reading a real Bun Response's body destroys the
  // serve-time string MIME inference this path exists to preserve, and the
  // wrapper it would trigger costs every direct-write fast path the adapters
  // have (the first pooling A/B matrix measured 4.2x Bun / 2.4x Node
  // regressions from wrapping alone).
  if (c.directBodyResponseValue === value) {
    retire();
    return value;
  }
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
    // A body-locked Response is a handler bug — typically an error mapper
    // returning a cached/reused Response whose stream was consumed by an
    // earlier request. The never-reject contract on app.handle is absolute
    // (recycle the context, answer a plain 500), but the swap must be LOUD:
    // silent 500s hide exactly the bugs this catches.
    console.error(
      "\n  response body was locked or unreadable at retirement — a handler or error mapper returned a reused Response\n",
    );
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
