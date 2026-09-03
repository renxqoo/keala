/**
 * R4.6 behavior locks: overload admission (`new Keala({ overload })`).
 *
 * Contract (docs/HOTPATH-R4-6-LIFECYCLE-DESIGN.md §2.2):
 * - beyond maxConcurrency: queued (FIFO, up to maxQueue) or refused with
 *   503 + Retry-After (never Retry-After while draining);
 * - queued requests leave on: slot transfer, queue timeout, client
 *   disconnect (fetch AND native — S4), drain start;
 * - admission is pre-context — the error funnel/mapper never sees refusals;
 * - capacity releases at settlement (settle boundary), slot transfer keeps
 *   the counter stable.
 *
 * Upgrade locks: U1 (strategy injection) and U3 (waiter pool — steady-state
 * queue churn constructs zero waiters).
 */

import { afterAll, describe, expect, it, vi } from "vitest";
import net from "node:net";
import { Keala } from "../src/core/app.ts";
import { startNodeServer, type NodeServerHandle } from "../src/adapters/node.ts";
import { createLifecycle, releaseInFlight } from "../src/core/lifecycle.ts";
import { admitRequest, waiterPoolStats } from "../src/core/lifecycle-admission.ts";

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

describe("R4.6 overload: fail-fast (default maxQueue 0)", () => {
  it("serves the first, refuses the second with 503 + Retry-After + connection: close", async () => {
    const app = new Keala({ env: "test", overload: { maxConcurrency: 1 } });
    const gate = deferred();
    app.get("/work", async (c) => {
      await gate.promise;
      c.body = "first";
    });

    const first: Promise<Response> = app.handle(new Request("http://x/work"));
    const second = await app.handle(new Request("http://x/work"));
    expect(second.status).toBe(503);
    expect(second.headers.get("retry-after")).toBe("1");
    expect(second.headers.get("connection")).toBe("close");
    expect(await second.text()).toBe("Service Unavailable");

    gate.resolve();
    expect(await (await first).text()).toBe("first");
    expect(app.inFlight).toBe(0);
  });

  it("capacity releases at settlement — sequential requests never queue", async () => {
    const app = new Keala({ env: "test", overload: { maxConcurrency: 1 } });
    app.get("/n", (c) => {
      c.body = "ok";
    });
    for (let i = 0; i < 5; i++) {
      const res = await app.handle(new Request("http://x/n"));
      expect(res.status).toBe(200);
    }
    expect(app.inFlight).toBe(0);
  });

  it("retryAfterSeconds: 0 omits the header", async () => {
    const app = new Keala({
      env: "test",
      overload: { maxConcurrency: 1, retryAfterSeconds: 0 },
    });
    const gate = deferred();
    app.get("/work", async () => {
      await gate.promise;
    });
    const first = app.handle(new Request("http://x/work"));
    const second = await app.handle(new Request("http://x/work"));
    expect(second.headers.get("retry-after")).toBeNull();
    gate.resolve();
    await first;
  });

  it("refusals never reach the error funnel (pre-context)", async () => {
    const app = new Keala({ env: "test", overload: { maxConcurrency: 1 } });
    const mapper = vi.fn();
    app.onError(mapper);
    const gate = deferred();
    app.get("/work", async () => {
      await gate.promise;
    });
    const first = app.handle(new Request("http://x/work"));
    await app.handle(new Request("http://x/work"));
    expect(mapper).not.toHaveBeenCalled();
    gate.resolve();
    await first;
  });

  it("handler customizes the rejection, sees the reason, and its bugs fall back loudly", async () => {
    const reasons: string[] = [];
    const app = new Keala({
      env: "test",
      overload: {
        maxConcurrency: 1,
        handler: (request, reason) => {
          reasons.push(reason);
          if (request.url.includes("boom")) throw new Error("handler bug");
          return new Response(`busy:${reason}`, { status: 503, headers: { "x-overload": "1" } });
        },
      },
    });
    const gate = deferred();
    app.get("/work", async () => {
      await gate.promise;
    });
    const first = app.handle(new Request("http://x/work"));
    const second = await app.handle(new Request("http://x/work"));
    expect(second.status).toBe(503);
    expect(await second.text()).toBe("busy:concurrency");
    expect(second.headers.get("x-overload")).toBe("1");
    expect(reasons).toEqual(["concurrency"]);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const third = await app.handle(new Request("http://x/boom"));
    errorSpy.mockRestore();
    expect(third.status).toBe(503); // built-in fallback, admission never dies
    expect(await third.text()).toBe("Service Unavailable");
    gate.resolve();
    await first;
  });
});

describe("R4.6 overload: queue (opt-in maxQueue)", () => {
  it("FIFO: queued requests run in order once slots free", async () => {
    const app = new Keala({ env: "test", overload: { maxConcurrency: 1, maxQueue: 2 } });
    const order: string[] = [];
    const gates = [deferred(), deferred(), deferred()];
    app.get("/work/:id", async (c) => {
      order.push(`start:${c.params?.["id"]}`);
      await (gates[Number(c.params?.["id"])] ?? gates[0]!).promise;
      order.push(`end:${c.params?.["id"]}`);
    });
    const handles: Promise<Response>[] = [0, 1, 2].map((i) =>
      app.handle(new Request(`http://x/work/${i}`)),
    );
    await wait(10); // 0 admitted; 1, 2 queued
    expect(app.inFlight).toBe(1);
    gates[0]!.resolve();
    await wait(10); // 0 settles, slot transfers to 1
    expect(order).toEqual(["start:0", "end:0", "start:1"]);
    gates[1]!.resolve();
    await wait(10);
    gates[2]!.resolve();
    await Promise.all(handles);
    expect(order).toEqual(["start:0", "end:0", "start:1", "end:1", "start:2", "end:2"]);
    expect(app.inFlight).toBe(0);
  });

  it("a full queue refuses with the same 503 shape", async () => {
    const app = new Keala({ env: "test", overload: { maxConcurrency: 1, maxQueue: 1 } });
    const gate = deferred();
    app.get("/work", async () => {
      await gate.promise;
    });
    const first = app.handle(new Request("http://x/work"));
    const queued: Promise<Response> = app.handle(new Request("http://x/work"));
    const refused = await app.handle(new Request("http://x/work"));
    expect(refused.status).toBe(503);
    gate.resolve();
    await Promise.all([first, queued]);
  });

  it("queue timeout rejects the waiter with 503", async () => {
    const app = new Keala({
      env: "test",
      overload: { maxConcurrency: 1, maxQueue: 1, queueTimeoutMs: 30 },
    });
    const gate = deferred();
    app.get("/work", async (c) => {
      await gate.promise;
      c.body = "done";
    });
    const first = app.handle(new Request("http://x/work"));
    const queued: Promise<Response> = app.handle(new Request("http://x/work"));
    const timedOut = await queued;
    expect(timedOut.status).toBe(503);
    gate.resolve();
    expect(await (await first).text()).toBe("done");
  });

  it("a queued request whose client disconnects leaves the queue (503, slot freed)", async () => {
    const app = new Keala({ env: "test", overload: { maxConcurrency: 1, maxQueue: 2 } });
    const gate = deferred();
    app.get("/work", async (c) => {
      await gate.promise;
      c.body = "done";
    });
    const first = app.handle(new Request("http://x/work"));
    const abort = new AbortController();
    // Parks in the queue (not awaited — it settles when the client leaves).
    const gone = app.handle(new Request("http://x/work", { signal: abort.signal }));
    abort.abort();
    const left = await gone;
    expect(left.status).toBe(503);
    // The queue must be empty now: the next request takes the freed spot.
    const nextQueued = app.handle(new Request("http://x/work"));
    gate.resolve();
    await Promise.all([first, nextQueued]);
    expect(app.inFlight).toBe(0);
  });

  it("S4: a NATIVE queued request whose client disconnects leaves the queue (real socket)", async () => {
    const app = new Keala({ env: "test", overload: { maxConcurrency: 1, maxQueue: 2 } });
    const gate = deferred();
    app.get("/work", async (c) => {
      await gate.promise;
      c.body = "served";
    });
    const server = await startNodeServer(app, { port: 0, hostname: "127.0.0.1" }).ready();
    liveServers.push(server);

    // A: admitted, parks on the gate.
    const a = fetch(`http://127.0.0.1:${server.port}/work`);
    await wait(30);
    expect(app.inFlight).toBe(1);

    // B: raw socket, queued, then the client walks away mid-queue. The
    // adapter's disconnect detection must drive the native abort channel
    // (S4) — B leaves the queue, freeing its queue slot.
    const socket = net.connect(server.port, "127.0.0.1");
    socket.write(`GET /work HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\n\r\n`);
    await wait(40);
    socket.destroy();
    await wait(40);

    // C: takes the queue spot B vacated.
    const c = fetch(`http://127.0.0.1:${server.port}/work`);
    await wait(20);
    gate.resolve();
    expect((await a).status).toBe(200);
    expect((await c).status).toBe(200);
    expect(app.inFlight).toBe(0);
  });

  it("drain start rejects the whole queue; in-flight keeps running", async () => {
    const app = new Keala({ env: "test", overload: { maxConcurrency: 1, maxQueue: 2 } });
    const gate = deferred();
    app.get("/work", async (c) => {
      await gate.promise;
      c.body = "drained";
    });
    const first = app.handle(new Request("http://x/work"));
    const queued: Promise<Response> = app.handle(new Request("http://x/work"));
    const closed = app.close({ drain: 1500 });
    const queuedResult = await queued;
    expect(queuedResult.status).toBe(503);
    expect(queuedResult.headers.get("retry-after")).toBeNull(); // draining: no Retry-After
    gate.resolve();
    expect(await (await first).text()).toBe("drained");
    await closed;
  });

  it("slot transfer does not over-admit: capacity stays at maxConcurrency", async () => {
    let peak = 0;
    let live = 0;
    const app = new Keala({ env: "test", overload: { maxConcurrency: 2, maxQueue: 8 } });
    app.get("/work", async (c) => {
      live++;
      peak = Math.max(peak, live);
      await wait(10);
      live--;
      c.body = "ok";
    });
    const handles: Promise<Response>[] = Array.from({ length: 12 }, () =>
      app.handle(new Request("http://x/work")),
    );
    const results = await Promise.all(handles);
    // 2 admitted + 8 queued = 10 served; the last 2 arrive at a full queue.
    expect(results.filter((r) => r.status === 200)).toHaveLength(10);
    expect(results.filter((r) => r.status === 503)).toHaveLength(2);
    expect(peak).toBeLessThanOrEqual(2);
    expect(app.inFlight).toBe(0);
  });
});

describe("R4.6 overload: pre-aborted and malformed queue entries", () => {
  it("a request whose client is ALREADY gone never enters the queue (503)", async () => {
    const app = new Keala({ env: "test", overload: { maxConcurrency: 1, maxQueue: 2 } });
    const gate = deferred();
    app.get("/work", async () => {
      await gate.promise;
    });
    const first: Promise<Response> = app.handle(new Request("http://x/work"));
    const abort = new AbortController();
    abort.abort(); // gone before issuance
    const refused = await app.handle(new Request("http://x/work", { signal: abort.signal }));
    expect(refused.status).toBe(503);
    gate.resolve();
    await first;
  });

  it("overload options must be an object; retryAfterSeconds must be an integer", () => {
    expect(() => new Keala({ overload: "nope" as never })).toThrow(TypeError);
    expect(() => new Keala({ overload: { maxConcurrency: 1, retryAfterSeconds: 1.5 } })).toThrow(
      TypeError,
    );
    expect(() => new Keala({ overload: { maxConcurrency: 1, retryAfterSeconds: -1 } })).toThrow(
      TypeError,
    );
    expect(
      () => new Keala({ overload: { maxConcurrency: 1, retryAfterSeconds: 2 } }),
    ).not.toThrow();
  });

  it("rejects non-positive concurrency, bad queue shapes, non-function handlers/strategies", () => {
    expect(() => new Keala({ overload: { maxConcurrency: 0 } })).toThrow(TypeError);
    expect(() => new Keala({ overload: { maxConcurrency: 1.5 } })).toThrow(TypeError);
    expect(
      () => new Keala({ overload: { maxQueue: 1 } as never }), // infinite concurrency + queue
    ).toThrow(/finite/);
    expect(() => new Keala({ overload: { maxConcurrency: 1, maxQueue: -1 } })).toThrow(TypeError);
    expect(() => new Keala({ overload: { maxConcurrency: 1, handler: "nope" as never } })).toThrow(
      TypeError,
    );
    expect(() => new Keala({ overload: { maxConcurrency: 1, strategy: {} as never } })).toThrow(
      /onSaturated/,
    );
  });
});

describe("R4.6 upgrade U1: AdmissionStrategy injection", () => {
  it("an injected strategy replaces the saturated path; null admits through the gate", async () => {
    const seen: string[] = [];
    const app = new Keala({
      env: "test",
      overload: {
        maxConcurrency: 1,
        strategy: {
          // Priority-style steal: a request carrying the header jumps the
          // built-in fail-fast and gets admitted synchronously.
          onSaturated: (state, request) => {
            seen.push(`${state.inFlight}:${request.url}`);
            if (request.headers.get("x-priority") === "high") return null;
            return new Response("low-priority-refused", { status: 503 });
          },
        },
      },
    });
    const gate = deferred();
    app.get("/work", async (c) => {
      await gate.promise;
      c.body = "done";
    });
    const first = app.handle(new Request("http://x/work")); // admitted
    await wait(10);
    // Saturated: high priority admits (2 in flight — the strategy said so),
    // low priority gets the custom refusal.
    const high = app.handle(new Request("http://x/work", { headers: { "x-priority": "high" } }));
    expect(app.inFlight).toBe(2);
    const low = await app.handle(new Request("http://x/work"));
    expect(low.status).toBe(503);
    expect(await low.text()).toBe("low-priority-refused");
    gate.resolve();
    expect((await first).status).toBe(200);
    expect((await high).status).toBe(200);
    expect(seen).toEqual(["1:http://x/work", "2:http://x/work"]);
  });

  it("an async strategy is awaited; a null resolution holds a real slot", async () => {
    const app = new Keala({
      env: "test",
      overload: {
        maxConcurrency: 1,
        strategy: {
          onSaturated: (_state, request) =>
            wait(10).then(() =>
              request.url.includes("wait") ? null : new Response("no", { status: 503 }),
            ),
        },
      },
    });
    const gateA = deferred();
    const gateB = deferred();
    app.get("/work", async (c) => {
      await gateA.promise;
      c.body = "a";
    });
    app.get("/wait", async (c) => {
      await gateB.promise;
      c.body = "b";
    });
    const first = app.handle(new Request("http://x/work"));
    await wait(10);
    const second = app.handle(new Request("http://x/wait"));
    await wait(20); // the strategy's own wait resolves, then the gate admits
    expect(app.inFlight).toBe(2); // BOTH hold real slots — no phantom release
    gateA.resolve();
    gateB.resolve();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect(await (await first).text()).toBe("a");
    expect(await (await second).text()).toBe("b");
  });

  it("implicit selection stays r4-4-equal: maxQueue picks queue, otherwise fail-fast", () => {
    const queued = createLifecycle({ maxConcurrency: 2, maxQueue: 4 });
    expect(queued.overload?.maxConcurrency).toBe(2);
    expect(queued.overload?.maxQueue).toBe(4);
    expect(typeof queued.overload?.strategy.onSaturated).toBe("function");
    const fast = createLifecycle({ maxConcurrency: 2 });
    expect(fast.overload?.maxQueue).toBe(0);
    const unconfigured = createLifecycle(undefined);
    expect(unconfigured.overload).toBeNull();
  });
});

describe("R4.6 upgrade U3: waiter pool (steady-state zero construction)", () => {
  it("1000 admit/leave cycles through the pool construct zero new waiters", async () => {
    const lc = createLifecycle({ maxConcurrency: 1, maxQueue: 1, queueTimeoutMs: 10_000 });
    // Warm the pool: one full cycle constructs (and recycles) the slot.
    const warm = admitRequest(lc, new Request("http://x/a"));
    const queued = admitRequest(lc, new Request("http://x/b"));
    expect(queued).toBeInstanceOf(Promise);
    releaseInFlight(lc); // slot transfer: queued waiter admits
    await Promise.all([warm, queued].map((p) => Promise.resolve(p)));
    expect(lc.inFlight).toBe(1);
    releaseInFlight(lc);
    expect(lc.waiterPool.length).toBe(1);

    const before = waiterPoolStats().constructed;
    for (let i = 0; i < 1000; i++) {
      const admit = admitRequest(lc, new Request(`http://x/${i}`));
      const park = admitRequest(lc, new Request(`http://x/${i}-q`)) as Promise<Response | null>;
      releaseInFlight(lc); // admit settles, transfer wakes the queue head
      releaseInFlight(lc);
      await Promise.all([Promise.resolve(admit), park]);
    }
    expect(lc.inFlight).toBe(0);
    expect(waiterPoolStats().constructed).toBe(before); // zero new waiters
  });

  it("a waiter settling twice (timeout after drain-drop) stays inert", async () => {
    const lc = createLifecycle({ maxConcurrency: 1, maxQueue: 1, queueTimeoutMs: 30 });
    const first = admitRequest(lc, new Request("http://x/a"));
    const queuedPromise = admitRequest(lc, new Request("http://x/b")) as Promise<Response | null>;
    // Drain-clears the queue (drop) while the timeout is armed.
    const drained = lc.queue.splice(0);
    for (const waiter of drained) waiter.drop("draining");
    const result = await queuedPromise;
    expect((result as Response).status).toBe(503);
    await wait(60); // the armed timeout fires into the settled guard
    expect(lc.inFlight).toBe(1);
    releaseInFlight(lc);
    await Promise.resolve(first);
  });
});
