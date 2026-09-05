/**
 * R4.4 contract-coherence review — docs/HOTPATH-R4-4-MIGRATION-LIFECYCLE.md
 * vs implementation (src/core/lifecycle.ts, app.ts, dispatch.ts, adapters).
 *
 * One hypothesis per test (CT-n). Each block comment cites the doc rule and
 * states EXPECTED (per the doc) vs ACTUAL (per code reading); the assertions
 * encode the EXPECTED side, so a failing test = a confirmed contract gap.
 *
 * Findings summary (see review report for the full table):
 * - CT-1  RED  §2.1/§2.2 r9  second signal never force-closes (idempotent
 *         close swallows drain:0).
 * - CT-4  RED  §2.5/§8.2 #6  pooling: a 504-path zombie settling with a
 *         NULL-body response recycles its context.
 * - CT-5  RED  §2.2 r9       closeApp fallback drain timer is unref'd (doc:
 *         "holds the event loop") and not cleared on completion.
 * - CT-6  RED  §2.2 r9       adapter stopGraceful arms the drain timer AFTER
 *         the already-settled finish() — never cleared, ref'd.
 * - CT-9  RED  §2.2 r2/r3    close({drain: 0}) with zero in-flight never
 *         stops the listener.
 * - CT-8  GAP  §4 snippet 1  /healthz "draining" branch unreachable (gate
 *         refuses new probes first — behavior matches §2.2 r1, doc example
 *         implies otherwise).
 */

import { afterAll, describe, expect, it, vi } from "vitest";
import { Keala } from "../../src/core/app.ts";
import type { NodeServerHandle } from "../../src/adapters/node.ts";
import { parseListenArgs } from "../../src/core/listen.ts";
import { startBunServer, type ServeImplementation } from "../../src/adapters/bun.ts";
import type { OverloadReason } from "../../src/types.ts";

const deferred = <T = void>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const wait = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

const liveServers: NodeServerHandle[] = [];
afterAll(() => {
  for (const server of liveServers) server.stop(true);
});

/** Bun-shaped serve mock (same pattern as r4-lifecycle-adapters.test.ts). */
const fakeServe = (): {
  impl: ServeImplementation;
  stopCalls: () => Array<boolean | undefined>;
} => {
  const stops: Array<boolean | undefined> = [];
  const impl: ServeImplementation = (options) => ({
    port: (options["port"] as number) ?? 0,
    hostname: "localhost",
    stop: (closeActive?: boolean) => {
      stops.push(closeActive);
    },
    fetch: async () => new Response("fake"),
    reload: () => {},
  });
  return { impl, stopCalls: () => stops };
};

describe("R4.4 contract coherence (agent-r44)", () => {
  it("CT-7 §4 snippet 1: the K8s example works as written (parse shape, fetch+c.signal, healthz)", async () => {
    // `app.listen(3000, { signals: true })` — the options object in the
    // SECOND position must parse (port + signals), the /api/orders handler
    // must typecheck and cooperate with the deadline via c.signal, and
    // /healthz must answer through the handler. (app.listen itself needs
    // Bun.serve; under the Node test runtime the equivalent parse + handler
    // execution is the verifiable part of the snippet.)
    const parsed = parseListenArgs([3000, { signals: true }]);
    expect(parsed.listen.port).toBe(3000);
    expect(parsed.listen.signals).toBe(true);

    const app = new Keala({
      env: "test",
      requestTimeout: 60, // snippet: 30_000 — lowered for test speed, same shape
      overload: { maxConcurrency: 512 },
    });
    app.get("/api/orders", async (c) => {
      const upstream = await fetch("http://svc-b/quotes", { signal: c.signal });
      return c.json(await upstream.json());
    });
    app.get("/healthz", (c) => c.text(app.isDraining() ? "draining" : "ok"));

    // Fast upstream: the snippet round-trips (signal passed through).
    const fastFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ quotes: [1, 2] }), {
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fastFetch as unknown as typeof fetch);
    try {
      const ok = await app.handle(new Request("http://x/api/orders"));
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ quotes: [1, 2] });
      expect(fastFetch).toHaveBeenCalledExactlyOnceWith(
        "http://svc-b/quotes",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    } finally {
      vi.unstubAllGlobals();
    }

    // Hanging upstream: c.signal carries the deadline — cooperative cancel,
    // the request 504s instead of hanging forever.
    const hangingFetch = ((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", hangingFetch);
    try {
      const dead = await app.handle(new Request("http://x/api/orders"));
      expect(dead.status).toBe(504);
    } finally {
      vi.unstubAllGlobals();
    }

    const health = await app.handle(new Request("http://x/healthz"));
    expect(await health.text()).toBe("ok");
  });

  it("CT-8 §4 snippet 1 (doc gap): the /healthz 'draining' branch is unreachable for NEW probes", async () => {
    // §2.2 r1 says new requests during drain are refused at the admission
    // gate (pre-context 503) — so the documented healthz pattern
    // `c.text(app.isDraining() ? "draining" : "ok")` can never answer
    // "draining" to a probe issued after close(): the gate answers first.
    // Behavior is coherent with r1 (this lock asserts it GREEN); the §4
    // example text is misleading — a doc gap, not a code bug.
    const app = new Keala({ env: "test" });
    app.get("/healthz", (c) => c.text(app.isDraining() ? "draining" : "ok"));
    const before = await app.handle(new Request("http://x/healthz"));
    expect(await before.text()).toBe("ok");
    const closed = app.close({ drain: 200 });
    const probe = await app.handle(new Request("http://x/healthz"));
    expect(probe.status).toBe(503); // gate refusal, handler never runs
    expect(probe.headers.get("connection")).toBe("close");
    await closed;
  });

  it("CT-9 §2.2 r2/r3/r6 + §4 snippet 3: idempotency, drain extremes, CloseStatus — and drain:0 stops an idle listener", async () => {
    // Rule 6: repeat close() returns the SAME promise and ignores the new
    // options (even invalid ones — no re-validation on the repeat path).
    const app = new Keala({ env: "test" });
    const p1 = app.close({ drain: 50 });
    const p2 = app.close({ drain: 9999 });
    const p3 = app.close({ drain: -1 }); // ignored on repeat — must not throw
    expect(p2).toBe(p1);
    expect(p3).toBe(p1);
    await p1;

    // Rule 2: drain:0 with nothing in flight resolves cleanly.
    const empty = new Keala({ env: "test" });
    await expect(empty.close({ drain: 0 })).resolves.toEqual({ timedOut: false, inFlight: 0 });

    // Rule 2: drain: Infinity is accepted (CloseOptions.drain: number) and waits.
    const forever = new Keala({ env: "test" });
    const gate = deferred();
    forever.get("/stuck", () => gate.promise.then(() => undefined));
    const stuckReq = forever.handle(new Request("http://x/stuck"));
    const infClosed = forever.close({ drain: Number.POSITIVE_INFINITY });
    let resolved = false;
    void infClosed.then(() => {
      resolved = true;
    });
    await wait(30);
    expect(resolved).toBe(false); // still waiting — Infinity means wait
    gate.resolve();
    const stuckRes = await stuckReq;
    await stuckRes.text(); // release the drain body-hold
    await expect(infClosed).resolves.toEqual({ timedOut: false, inFlight: 0 });

    // §4 snippet 3: `const status = await app.close({ drain: 10_000 })` —
    // the shape carries { timedOut, inFlight } ("killed" count on timeout).
    const app4 = new Keala({ env: "test" });
    const gate4 = deferred();
    app4.get("/stuck", () => gate4.promise.then(() => undefined));
    const zombie = app4.handle(new Request("http://x/stuck"));
    const status = await app4.close({ drain: 30 });
    expect(status.timedOut).toBe(true);
    expect(status.inFlight).toBe(1);
    gate4.resolve();
    const zombieRes = await zombie;
    await zombieRes.text();

    // HYPOTHESIS (state machine): rule 2/r3 — drain:0 = "立即强停(杀连接)" —
    // must stop the listener even when ZERO requests are in flight.
    // ACTUAL (closeApp): `finish(lc.inFlight > 0)` yields timedOut=false and
    // `if (timedOut) handle?.stop(true)` skips stop entirely — the port stays
    // bound, answering 503s, and the process never exits on its own.
    const { impl, stopCalls } = fakeServe();
    const idle = new Keala({ env: "test" });
    startBunServer(idle, { port: 0 }, undefined, impl);
    await idle.close({ drain: 0 });
    expect(stopCalls()).toEqual([true]); // EXPECTED: force-stop. ACTUAL: [] — never stopped.
  });

  it("CT-10 §2.3 r1/r6: every overload reason is reachable; a full-queue refusal is labeled 'concurrency'", async () => {
    // Rule 6: the handler must see reason ∈ {concurrency, queue, draining}.
    // Doc note: §2.3 r1 does not name the reason for a FULL queue — the
    // implementation answers "concurrency" there (only queue-timeout and
    // queue-disconnect use "queue"). This lock records the actual labeling.
    const reasons: OverloadReason[] = [];
    const handler = (_request: Request, reason: OverloadReason): Response => {
      reasons.push(reason);
      return new Response(`r:${reason}`, { status: 503 });
    };

    const failFast = new Keala({ env: "test", overload: { maxConcurrency: 1, handler } });
    const gate = deferred();
    failFast.get("/w", async () => {
      await gate.promise;
    });
    const a1 = failFast.handle(new Request("http://x/w"));
    const a2 = await failFast.handle(new Request("http://x/w")); // capacity, fail-fast
    expect(a2.status).toBe(503);
    expect(await a2.text()).toBe("r:concurrency");
    gate.resolve();
    await a1;

    const queued = new Keala({
      env: "test",
      overload: { maxConcurrency: 1, maxQueue: 1, queueTimeoutMs: 40, handler },
    });
    const qGate = deferred();
    queued.get("/w", async (c) => {
      await qGate.promise;
      c.body = "ok";
    });
    const q1 = queued.handle(new Request("http://x/w")); // admitted, parks
    const abort = new AbortController();
    const q2 = queued.handle(new Request("http://x/w", { signal: abort.signal })); // queued
    const q3 = await queued.handle(new Request("http://x/w")); // queue FULL → refusal
    expect(q3.status).toBe(503);
    expect(await q3.text()).toBe("r:concurrency"); // the full-queue label (doc ambiguity)
    abort.abort(); // queued client disconnect → "queue" (§2.3 r3)
    expect((await q2).status).toBe(503);
    const q4 = queued.handle(new Request("http://x/w")); // queued again
    expect((await q4).status).toBe(503); // queue timeout (§2.3 r4)
    const q5 = queued.handle(new Request("http://x/w")); // queued — dropped at drain
    const qClosed = queued.close({ drain: 500 });
    expect((await q5).status).toBe(503); // drain start rejects the queue (§2.3 r4)
    const q6 = await queued.handle(new Request("http://x/w")); // gate refusal while draining
    expect(q6.status).toBe(503);
    qGate.resolve();
    expect(await (await q1).text()).toBe("ok");
    await qClosed;

    expect(new Set(reasons)).toEqual(new Set(["concurrency", "queue", "draining"]));
  });

  it("CT-11 §4 snippet 2: the API-gateway overload envelope works as written", async () => {
    // The snippet VERBATIM (256 concurrency, 64 queue, 2s queue timeout) —
    // driven with 256+64+1 concurrent requests so the last one is refused
    // while 256 park and 64 wait in the queue.
    const app = new Keala({
      env: "test",
      overload: {
        maxConcurrency: 256,
        maxQueue: 64,
        queueTimeoutMs: 2_000,
        handler: (_request, reason) =>
          Response.json(
            { error: "overloaded", reason },
            { status: 503, headers: { "retry-after": "1" } },
          ),
      },
    });
    const gate = deferred();
    app.get("/w", async (c) => {
      await gate.promise;
      c.body = "ok";
    });
    const handles = Array.from({ length: 256 + 64 + 1 }, () =>
      app.handle(new Request("http://x/w")),
    );
    const refused = await handles[256 + 64]!; // the 321st: queue full → envelope
    expect(refused.status).toBe(503);
    expect(refused.headers.get("retry-after")).toBe("1");
    expect(await refused.json()).toEqual({ error: "overloaded", reason: "concurrency" });
    gate.resolve();
    expect(await (await handles[0]!).text()).toBe("ok");
    expect((await handles[256]!).status).toBe(200); // first queued request is served
  });

  it("CT-12 §2.5 invariant: app.handle never rejects on any R4.4 rejection path", async () => {
    // Drain refusal, a THROWING custom overload handler, queue timeout and
    // the 504 deadline all settle with Responses — handle never rejects.
    const draining = new Keala({ env: "test" });
    void draining.close({ drain: 100 });
    const drainRefused = await draining.handle(new Request("http://x/"));
    expect(drainRefused.status).toBe(503);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let overloadThrown: Response | undefined;
    try {
      const boom = new Keala({
        env: "test",
        overload: {
          maxConcurrency: 1,
          handler: () => {
            throw new Error("handler bug");
          },
        },
      });
      const gate = deferred();
      boom.get("/w", async () => {
        await gate.promise;
      });
      const first = boom.handle(new Request("http://x/w"));
      overloadThrown = await boom.handle(new Request("http://x/w")); // must not reject
      expect(overloadThrown.status).toBe(503); // assert BEFORE mockRestore
      gate.resolve();
      await first;
    } finally {
      errorSpy.mockRestore();
    }

    const queueApp = new Keala({
      env: "test",
      overload: { maxConcurrency: 1, maxQueue: 1, queueTimeoutMs: 30 },
    });
    const qGate = deferred();
    queueApp.get("/w", async () => {
      await qGate.promise;
    });
    const q1 = queueApp.handle(new Request("http://x/w"));
    const q2 = await queueApp.handle(new Request("http://x/w")); // queue timeout
    expect(q2.status).toBe(503);
    qGate.resolve();
    await q1;

    const timeoutApp = new Keala({ env: "test", requestTimeout: 30 });
    const tGate = deferred();
    timeoutApp.get("/stuck", () => tGate.promise.then(() => undefined));
    const timedOut = await timeoutApp.handle(new Request("http://x/stuck"));
    expect(timedOut.status).toBe(504);
    tGate.resolve();
  });
});
