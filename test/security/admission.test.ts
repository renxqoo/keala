/**
 * Agent security review — R4.4 pre-context admission machinery
 * (branch codex/hotpath-r4-4-lifecycle).
 * Contract: docs/HOTPATH-R4-4-MIGRATION-LIFECYCLE.md §2.2 (drain), §2.3
 * (overload / pre-context rejection), §2.5 (invariants). Every test states
 * an ATTACK and the expectation that must hold. FINDING-marked tests were
 * RED at review time and ship as `it.fails` (desired contract expressed,
 * suite stays green).
 */

import { afterAll, describe, expect, it, vi } from "vitest";

import { Keala } from "../../src/core/app.ts";
import type { NodeServerHandle } from "../../src/adapters/node.ts";

const deferred = <T = void>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const wait = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

/** Count unhandledRejections while armed (zombie/containment checks). */
const unhandledTracker = (): { count: () => number; stop: () => void } => {
  let n = 0;
  const onUnhandled = (): void => {
    n += 1;
  };
  // Cast pattern from agent-r6-prop-invariants-2.test.ts (bun-types narrows
  // the process event map); bound so `this` survives.
  const on = process.on.bind(process) as unknown as (event: string, fn: () => void) => void;
  const off = process.off.bind(process) as unknown as (event: string, fn: () => void) => void;
  on("unhandledRejection", onUnhandled);
  return { count: () => n, stop: () => off("unhandledRejection", onUnhandled) };
};

/** A parked streaming route whose body settles only when the test says so. */
const streamRoute = (app: Keala, gate: Promise<void>): void => {
  app.get("/s", async () => {
    await gate;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("chunk-1;")); // left open
        },
      }),
      { headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  });
};

const liveServers: NodeServerHandle[] = [];
afterAll(() => {
  for (const server of liveServers) server.stop(true);
});

const BUILTIN_503_BODY = "Service Unavailable";

describe("SEC-1: rejection integrity — hostile requests cannot shape the built-in 503", () => {
  // ATTACK: URLs/methods/headers that look like response-control data (header
  // names in the query, encoded CRLF, probe methods) hoping the gate reflects
  // them into the 503's headers or body. EXPECTATION: the built-in rejection
  // is a constant — fixed status, fixed headers, fixed body.
  it("SEC-1a: concurrency refusals carry exactly the fixed header set and body", async () => {
    const marker = `INJECT-${Math.random().toString(36).slice(2)}`;
    const app = new Keala({ env: "test", overload: { maxConcurrency: 1 } });
    const gate = deferred();
    app.get("/work", async () => {
      await gate.promise;
    });
    const first = app.handle(new Request("http://x/work"));
    const hostile = [
      new Request(`http://x/evil?retry-after=999&${marker}=1&connection=keep-alive`),
      new Request(`http://x/ev%0d%0aX-Injected:%20${marker}/p`, { method: "POST", body: marker }),
      new Request(`http://x/${marker}`, { method: "XProbe" }),
    ];
    for (const req of hostile) {
      const res = await app.handle(req);
      expect(res.status).toBe(503);
      expect(Object.fromEntries(res.headers.entries())).toEqual({
        "content-type": "text/plain; charset=utf-8",
        connection: "close",
        "retry-after": "1",
      });
      expect(await res.text()).toBe(BUILTIN_503_BODY);
      const flat = [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
      expect(flat).not.toContain(marker);
      expect(flat).not.toContain("Injected");
    }
    gate.resolve();
    await first;
  });

  it("SEC-1b: drain refusals keep the fixed shape, no Retry-After, no request data", async () => {
    const marker = `DRAIN-${Math.random().toString(36).slice(2)}`;
    const app = new Keala({ env: "test" });
    const gate = deferred();
    app.get("/slow", async () => {
      await gate.promise;
    });
    const inflight = app.handle(new Request("http://x/slow"));
    const closed = app.close({ drain: 2000 });
    const res = await app.handle(
      new Request(`http://x/anything?${marker}=&x=${encodeURIComponent("a\r\nb")}`),
    );
    expect(res.status).toBe(503);
    expect(Object.fromEntries(res.headers.entries())).toEqual({
      "content-type": "text/plain; charset=utf-8",
      connection: "close",
    });
    expect(await res.text()).toBe(BUILTIN_503_BODY);
    gate.resolve();
    await (await inflight).text(); // drain body-hold: consume the victim's body
    await expect(closed).resolves.toEqual({ timedOut: false, inFlight: 0 });
  });

  // ATTACK: a misconfigured overload.handler returning a non-Response could
  // let request-shaped garbage through as the "response". EXPECTATION: only
  // an instanceof Response is honored; anything else falls to the fixed 503.
  it("SEC-1c: an overload.handler returning a non-Response falls back to the fixed built-in", async () => {
    const app = new Keala({
      env: "test",
      overload: { maxConcurrency: 1, handler: () => "busy" as unknown as Response },
    });
    const gate = deferred();
    app.get("/work", async () => {
      await gate.promise;
    });
    const first = app.handle(new Request("http://x/work"));
    const res = await app.handle(new Request("http://x/work"));
    expect(res.status).toBe(503);
    expect(res instanceof Response).toBe(true);
    expect(await res.text()).toBe(BUILTIN_503_BODY);
    gate.resolve();
    await first;
  });
});

describe("SEC-2: admission as a bypass — refusals are pre-context and context-free", () => {
  // ATTACK: a refused request might still execute middleware/route handlers
  // (side effects, chain bypass) or poison the error funnel. EXPECTATION: the
  // pre-context 503 runs NOTHING (docs §2.2 rule 1, §2.5 invariant 3).
  it("SEC-2a: a gate-refused request runs no middleware, handler, notFound or mapper", async () => {
    const counts = { middleware: 0, route: 0, notFound: 0, mapper: 0 };
    const app = new Keala({ env: "test", pooling: true, overload: { maxConcurrency: 1 } });
    app.use((_c, next) => {
      counts.middleware += 1;
      return next();
    });
    app.get("/work", async (c) => {
      counts.route += 1;
      await wait(5);
      c.body = "ok";
    });
    app.notFound(() => {
      counts.notFound += 1;
    });
    app.onError(() => {
      counts.mapper += 1;
      return new Response("mapped");
    });
    const gate = deferred();
    app.get("/gated", async () => {
      await gate.promise;
    });
    const first = app.handle(new Request("http://x/gated"));
    await wait(10); // the ADMITTED request legitimately runs the middleware
    const baseline = { ...counts };
    expect(baseline).toEqual({ middleware: 1, route: 0, notFound: 0, mapper: 0 });
    const refused = await app.handle(new Request("http://x/work"));
    expect(refused.status).toBe(503);
    expect(counts).toEqual(baseline); // the refusal added NOTHING
    gate.resolve();
    await first;
    const served = await app.handle(new Request("http://x/work"));
    expect(served.status).toBe(200);
    expect(counts.route).toBe(1);
    expect(counts.middleware).toBe(2); // gated + served both ran it
  });

  // ATTACK (pooling): during drain a refusal could be built through the error
  // funnel / committed-header fast lane and inherit ANOTHER in-flight
  // request's staged headers (cross-request disclosure). EXPECTATION: the
  // drain 503 is built from constants; staged headers stay on the victim.
  it("SEC-2b: a drain refusal never inherits an in-flight victim's staged headers", async () => {
    const secret = `VICTIM-TOKEN-${Math.random().toString(36).slice(2)}`;
    const app = new Keala({ env: "test", pooling: true });
    const gate = deferred();
    app.get("/victim", async (c) => {
      void c.setHeader("x-victim-token", secret);
      void c.setHeader("content-type", "text/plain; charset=utf-8");
      await gate.promise;
      c.body = "victim-done";
    });
    const victim = app.handle(new Request("http://x/victim"));
    const closed = app.close({ drain: 2000 });
    const refused = await app.handle(new Request("http://x/other"));
    expect(refused.status).toBe(503);
    expect(Object.fromEntries(refused.headers.entries())).toEqual({
      "content-type": "text/plain; charset=utf-8",
      connection: "close",
    });
    const flat = [...refused.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
    expect(flat).not.toContain(secret);
    gate.resolve();
    const victimRes = await victim;
    expect(victimRes.status).toBe(200);
    expect(victimRes.headers.get("x-victim-token")).toBe(secret);
    await victimRes.text(); // drain body-hold
    await expect(closed).resolves.toEqual({ timedOut: false, inFlight: 0 });
  });
});

describe("SEC-3: request.signal trust — aborts are self-scoped, never capacity-corrupting", () => {
  // ATTACK: peer A aborts its own queued request hoping to eject peer B's
  // waiter, free the ADMITTED slot (over-admission) or drive inFlight
  // negative. EXPECTATION: an abort removes only its own waiter; FIFO order,
  // capacity and the counter stay intact.
  it("SEC-3a: aborting a queued request leaves other waiters and the slot untouched", async () => {
    const order: string[] = [];
    let live = 0;
    let peak = 0;
    const app = new Keala({ env: "test", overload: { maxConcurrency: 1, maxQueue: 2 } });
    app.get("/w/:id", async (c) => {
      live += 1;
      peak = Math.max(peak, live);
      order.push(`start:${c.params("id")}`);
      await wait(15);
      live -= 1;
      order.push(`end:${c.params("id")}`);
    });
    const first = app.handle(new Request("http://x/w/0"));
    const controllerA = new AbortController();
    const peerA = app.handle(new Request("http://x/w/a", { signal: controllerA.signal }));
    const peerB = app.handle(new Request("http://x/w/b"));
    await wait(10); // A and B park in the queue
    expect(app.inFlight).toBe(1);
    controllerA.abort(); // A walks away
    const leftA = await peerA;
    expect(leftA.status).toBe(503);
    expect(app.inFlight).toBe(1); // the abort freed NO capacity
    await Promise.all([first, peerB]);
    expect(order).toEqual(["start:0", "end:0", "start:b", "end:b"]); // b served, a never ran
    expect(peak).toBe(1); // no over-admission from the abort
    expect(app.inFlight).toBe(0);
  });
});

describe("SEC-4: queue resource exhaustion — waiter hygiene under flood", () => {
  // ATTACK: flood the queue with requests that all time out, then abort their
  // signals late — looking for waiter slots that never free (queue
  // permanently "full" = remote DoS) or double-leaves that corrupt the queue.
  // EXPECTATION: every timed-out waiter releases its slot, timer and abort
  // listener; the queue accepts new waiters; late aborts are inert.
  it("SEC-4a: a flood of timed-out waiters frees every queue slot; late aborts stay inert", async () => {
    const app = new Keala({
      env: "test",
      overload: { maxConcurrency: 1, maxQueue: 5, queueTimeoutMs: 40 },
    });
    const gate = deferred();
    app.get("/work", async (c) => {
      await gate.promise;
      c.body = "done";
    });
    const tracker = unhandledTracker();
    try {
      const first = app.handle(new Request("http://x/work"));
      const controllers = Array.from({ length: 5 }, () => new AbortController());
      const flood = controllers.map((ctl) =>
        app.handle(new Request("http://x/work", { signal: ctl.signal })),
      );
      const results = await Promise.all(flood);
      expect(results.every((r) => r.status === 503)).toBe(true);
      expect(app.inFlight).toBe(1); // only the admitted request holds capacity
      // The 5 timed-out waiters must have left: a fresh request QUEUES (still
      // pending well before the 40ms timeout) instead of being refused.
      const fresh = app.handle(new Request("http://x/work"));
      const sentinel = Symbol("pending");
      const earlyOutcome = await Promise.race([
        fresh.then(() => "settled" as const),
        wait(12).then(() => sentinel as typeof sentinel),
      ]);
      expect(earlyOutcome).toBe(sentinel);
      for (const ctl of controllers) ctl.abort(); // late aborts: must be inert
      await wait(5);
      gate.resolve();
      const freshRes = await fresh;
      expect(freshRes.status).toBe(200);
      expect(await freshRes.text()).toBe("done");
      await first;
      expect(app.inFlight).toBe(0);
      expect(tracker.count()).toBe(0);
    } finally {
      tracker.stop();
    }
  });
});

describe("SEC-5: drain body-holds — a malicious slow reader cannot wedge shutdown", () => {
  // ATTACK: a peer reads a draining response body infinitely slowly (or
  // never) to hold the drain open forever. EXPECTATION: cancel() releases the
  // hold; close() then settles cleanly.
  it("SEC-5a: consumer cancel() releases the body-hold — close settles {timedOut:false,0}", async () => {
    const app = new Keala({ env: "test" });
    const gate = deferred();
    streamRoute(app, gate.promise);
    const inflight = app.handle(new Request("http://x/s"));
    const closed = app.close({ drain: 1500 });
    gate.resolve();
    await (await inflight).body!.cancel(); // the slow reader changes its mind
    await expect(closed).resolves.toEqual({ timedOut: false, inFlight: 0 });
  });

  // Same attack, but the peer NEVER touches the body again. EXPECTATION: the
  // drain timeout bounds the hold — close() resolves {timedOut:true}.
  it("SEC-5b: a never-read held body is bounded by the drain timeout", async () => {
    const app = new Keala({ env: "test" });
    const gate = deferred();
    streamRoute(app, gate.promise);
    const inflight = app.handle(new Request("http://x/s"));
    const closed = app.close({ drain: 60 });
    gate.resolve();
    const res = await inflight;
    expect(res.body).not.toBeNull(); // held, never pulled
    const status = await closed;
    expect(status.timedOut).toBe(true);
    expect(status.inFlight).toBe(1);
    await res.body!.cancel().catch(() => undefined); // cleanup
  });

  // ATTACK: a handler returns a Response whose body is already locked (a
  // reused Response) during drain — if holdBody waited on it, shutdown hangs.
  // EXPECTATION: loud fallback with an immediate release.
  it("SEC-5c: a locked/reused body during drain releases the hold immediately (no hang)", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const app = new Keala({ env: "test" });
      const gate = deferred();
      app.get("/locked", async () => {
        await gate.promise;
        const reused = new Response("already-consumed-body");
        void reused.body!.getReader(); // lock it — a handler bug
        return reused;
      });
      const inflight = app.handle(new Request("http://x/locked"));
      const closed = app.close({ drain: 1500 });
      gate.resolve();
      const res = await inflight;
      expect(res.status).toBe(200);
      await expect(closed).resolves.toEqual({ timedOut: false, inFlight: 0 });
      expect(consoleError).toHaveBeenCalled(); // loud, not silent
    } finally {
      consoleError.mockRestore();
    }
  });

  // ATTACK: the upstream body ERRORS mid-stream while draining — the hold
  // must not leak. EXPECTATION: the error path releases it.
  it("SEC-5d: an erroring held body releases the hold", async () => {
    const app = new Keala({ env: "test" });
    const gate = deferred();
    app.get("/err", async () => {
      await gate.promise;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new TextEncoder().encode("x"));
            throw new Error("upstream exploded");
          },
        }),
      );
    });
    const inflight = app.handle(new Request("http://x/err"));
    const closed = app.close({ drain: 1500 });
    gate.resolve();
    await expect((await inflight).text()).rejects.toThrow();
    await expect(closed).resolves.toEqual({ timedOut: false, inFlight: 0 });
  });
});
