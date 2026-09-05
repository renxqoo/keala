/**
 * SECURITY review — R4.6 lifecycle (branch codex/r4-6-lifecycle-overload).
 * Contract: docs/HOTPATH-R4-6-LIFECYCLE-DESIGN.md §2.2 (rules/invariants)
 * and §7.3 (hot-path forbidden actions). Companion to
 * test/agent-r46-security{,-2}.test.ts — this file hunts what those locks
 * MISS (strategy garbage, wire-level queue abandon, cached rejection
 * Responses, drain races, deadline storms, signal cross-talk).
 *
 * Every test states an ATTACK and the expectation that must hold.
 * FAILING tests = holes confirmed (left failing, clearly named):
 *   - REVIEW-SEC-3 (strategy returning garbage synchronously throws out of app.handle)
 *   - REVIEW-SEC-4 (strategy resolving undefined rides through as the "response")
 *   - REVIEW-SEC-15 (abandoned wire queue entries hold their slot until the timer)
 */

/* eslint-disable max-lines -- one review file per the task mandate (18 security probes; the review agent is restricted to this single file) */

import { afterAll, describe, expect, it } from "vitest";
import { connect, type Socket } from "node:net";

import { Keala } from "../../src/core/app.ts";
import { startNodeServer, type NodeServerHandle } from "../../src/adapters/node.ts";

const deferred = <T = void>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const wait = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

/**
 * Count unhandledRejection AND uncaughtException while armed. Post-destroy
 * wire writes (abandoned sockets, force-closed drains) are the classic
 * source; counting keeps the worker alive so the finding is attributable.
 */
const noiseTracker = (): { count: () => number; stop: () => void } => {
  let n = 0;
  const bump = (): void => {
    n += 1;
  };
  const on = process.on.bind(process) as unknown as (event: string, fn: () => void) => void;
  const off = process.off.bind(process) as unknown as (event: string, fn: () => void) => void;
  on("unhandledRejection", bump);
  on("uncaughtException", bump);
  return {
    count: () => n,
    stop: () => {
      off("unhandledRejection", bump);
      off("uncaughtException", bump);
    },
  };
};

/** Wire-level exchange (pattern from agent-r46-security-2.test.ts). */
const wireExchange = async (
  port: number,
  script: (write: (chunk: string) => void) => Promise<void> | void,
  quietMs = 250,
): Promise<string> => {
  const sock: Socket = connect(port, "127.0.0.1");
  // Server-side force closes (drain escalation, connection: close) can RST a
  // still-open client socket; swallow so the test observes the wire, not a crash.
  sock.on("error", () => undefined);
  let buf = "";
  await new Promise<void>((resolve, reject) => {
    sock.once("connect", resolve);
    sock.once("error", reject);
  });
  sock.setEncoding("latin1");
  sock.on("data", (d: string) => {
    buf += d;
  });
  await script((chunk: string) => sock.write(chunk));
  await wait(quietMs);
  sock.destroy();
  return buf;
};

const statusLines = (wire: string): string[] =>
  [...wire.matchAll(/HTTP\/1\.1 (\d{3})/g)].map((m) => m[1] as string);

const headerValues = (wire: string, name: string): string[] =>
  [...wire.matchAll(new RegExp(`(?:^|\\r\\n)${name}:([^\\r\\n]*)`, "gi"))].map((m) =>
    (m[1] as string).trim(),
  );

const liveServers: NodeServerHandle[] = [];
afterAll(() => {
  for (const server of liveServers) server.stop(true);
});

describe("REVIEW-SEC-7: queue entries for requests whose signal already aborted", () => {
  // ATTACK: flood with requests that are ALREADY aborted when they reach the
  // gate — a buggy arm() would park dead weight in the queue, permanently
  // consuming maxQueue slots (remote DoS with a handful of dead requests).
  // EXPECTATION: an already-aborted request is answered 503 immediately and
  // never takes a queue slot; a fresh request still queues.
  it("REVIEW-SEC-7: an already-aborted request never occupies a queue slot", async () => {
    const app = new Keala({
      env: "test",
      overload: { maxConcurrency: 1, maxQueue: 2, queueTimeoutMs: 5000 },
    });
    const gate = deferred();
    app.get("/hold", async (c) => {
      await gate.promise;
      c.body = "done";
    });
    const holder = app.handle(new Request("http://x/hold"));
    const dead1 = new AbortController();
    const dead2 = new AbortController();
    dead1.abort();
    dead2.abort();
    const started = Date.now();
    const dead = await Promise.all([
      app.handle(new Request("http://x/hold", { signal: dead1.signal })),
      app.handle(new Request("http://x/hold", { signal: dead2.signal })),
    ]);
    expect(Date.now() - started).toBeLessThan(1000); // answered now, not at 5s
    expect(dead.every((r) => r.status === 503)).toBe(true);
    expect(app.inFlight).toBe(1);
    // Both dead requests left the queue: a fresh request QUEUES (pending
    // until the holder releases) instead of being fail-fast refused.
    const fresh = app.handle(new Request("http://x/hold"));
    const sentinel = Symbol("pending");
    const early = await Promise.race([
      fresh.then(() => "settled" as const),
      wait(60).then(() => sentinel as typeof sentinel),
    ]);
    expect(early).toBe(sentinel);
    gate.resolve();
    const freshRes = await fresh;
    expect(freshRes.status).toBe(200);
    expect(await freshRes.text()).toBe("done");
    await holder;
    expect(app.inFlight).toBe(0);
  });
});

describe("REVIEW-SEC-8: queueTimeoutMs boundary values", () => {
  // ATTACK: degenerate configuration values at the admission boundary.
  // EXPECTATION: 0 (and negatives) are rejected at construction; 1ms parks
  // and evicts cleanly (counter intact, healthy service afterwards). The
  // slots-freed proof lives in REVIEW-SEC-7 (the sentinel method needs a
  // timeout window larger than the probe).
  it("REVIEW-SEC-8: queueTimeoutMs 0 throws at construction; 1ms evicts cleanly", async () => {
    expect(
      () =>
        new Keala({
          env: "test",
          overload: { maxConcurrency: 1, maxQueue: 1, queueTimeoutMs: 0 },
        }),
    ).toThrow(TypeError);
    const app = new Keala({
      env: "test",
      overload: { maxConcurrency: 1, maxQueue: 2, queueTimeoutMs: 1 },
    });
    const gate = deferred();
    app.get("/hold", async (c) => {
      await gate.promise;
      c.body = "done";
    });
    const holder = app.handle(new Request("http://x/hold"));
    const flood = [0, 1].map((i) => app.handle(new Request(`http://x/hold-x-${i}`)));
    const results = await Promise.all(flood); // 1ms waiters: evicted fast
    expect(results.every((r) => r.status === 503)).toBe(true);
    expect(app.inFlight).toBe(1); // only the holder — evictions took nothing
    gate.resolve();
    await holder;
    const late = await app.handle(new Request("http://x/hold"));
    expect(late.status).toBe(200);
    expect(await late.text()).toBe("done");
    expect(app.inFlight).toBe(0);
  });
});

describe("REVIEW-SEC-9: deadline zombie — pooling state must not leak", () => {
  // ATTACK: a deadline zombie's context carries request-scoped state
  // (c.state.secret); if the late settle retired it into the pool, the NEXT
  // request would inherit another request's data (cross-request disclosure).
  // EXPECTATION: deadlineAnswered contexts go to GC, never the pool.
  it("REVIEW-SEC-9: a 504 zombie's c.state never reaches the next request", async () => {
    const marker = `ZS-${Math.random().toString(36).slice(2)}`;
    const app = new Keala({ env: "test", pooling: true, requestTimeout: 40 });
    const gate = deferred();
    app.get("/zombie", async (c) => {
      c.state.secret = marker;
      await gate.promise;
      c.body = "late"; // harmless write after the 504
    });
    app.get("/probe", (c) => {
      c.body = `keys=${Object.keys(c.state).toSorted().join(",")}`;
    });
    const zombie = await app.handle(new Request("http://x/zombie"));
    expect(zombie.status).toBe(504);
    expect(app.inFlight).toBe(0);
    gate.resolve();
    await wait(30);
    const probe = await app.handle(new Request("http://x/probe"));
    expect(probe.status).toBe(200);
    expect(await probe.text()).toBe("keys=");
    expect(app.inFlight).toBe(0);
  });
});

describe("REVIEW-SEC-10: requestTimeout 1ms storm", () => {
  // ATTACK: 1000 concurrent requests against a 1ms deadline — a per-request
  // race/timer bug (double settle, double release, escaping rejection) turns
  // into a flood of process-level noise and a corrupted counter.
  // EXPECTATION: exactly one 504 per request, no unhandledRejection, no
  // uncaughtException, counter exactly 0 at the end (docs §2.3 table).
  it(
    "REVIEW-SEC-10: 1000 requests under a 1ms deadline yield one 504 each and a clean counter",
    { timeout: 30_000 },
    async () => {
      const app = new Keala({ env: "test", pooling: true, requestTimeout: 1 });
      const gate = deferred();
      app.get("/hang", async (c) => {
        await gate.promise;
        c.body = "late";
      });
      const tracker = noiseTracker();
      try {
        const all = Array.from({ length: 1000 }, (_, i) =>
          app.handle(new Request(`http://x/hang?i=${i}`)),
        );
        const results = await Promise.all(all);
        expect(results).toHaveLength(1000);
        expect(results.every((r) => r instanceof Response && r.status === 504)).toBe(true);
        expect(app.inFlight).toBe(0);
        gate.resolve(); // wake 1000 zombies at once
        await wait(150);
        expect(tracker.count()).toBe(0);
        expect(app.inFlight).toBe(0);
      } finally {
        tracker.stop();
      }
    },
  );
});

describe("REVIEW-SEC-11: deadline zombie must not write a second response on the wire", () => {
  // ATTACK: the zombie handler settles AFTER the 504 went out; a second write
  // on the keep-alive socket would desync any client/proxy parser (response
  // misattribution). EXPECTATION: exactly one response ever hits the wire.
  it.skipIf(typeof Bun !== "undefined")(
    "REVIEW-SEC-11: wire shows exactly one 504; the zombie's late body never reaches the socket",
    { timeout: 15_000 },
    async () => {
      const app = new Keala({ env: "test", requestTimeout: 120 });
      app.get("/zombie", async (c) => {
        await wait(450);
        c.body = "ZOMBIE-LATE-BYTES";
      });
      const handle = startNodeServer(app, { port: 0 });
      liveServers.push(handle);
      const server = await handle.ready();
      const wire = await wireExchange(
        server.port,
        (write) => {
          write("GET /zombie HTTP/1.1\r\nHost: x\r\n\r\n");
        },
        800, // well past the zombie's 450ms settle
      );
      expect(wire.startsWith("HTTP/1.1 504")).toBe(true);
      expect(statusLines(wire)).toEqual(["504"]);
      expect(wire).not.toContain("ZOMBIE-LATE-BYTES");
      expect(app.inFlight).toBe(0);
    },
  );
});

describe("REVIEW-SEC-12: pipelined requests racing drain start", () => {
  // ATTACK: request A is admitted and slow; drain starts; request B arrives
  // on the SAME keep-alive connection and is refused. If B's instant 503
  // overtook A's response, a pipelining client would misattribute bodies.
  // EXPECTATION (node semantics, same shape SEC-6a locked): A's close-marked
  // response ends the socket, so B is never answered — the wire holds exactly
  // ONE complete response, in request order, with no misattributed or partial
  // fragments of B (complements SEC-7a, which raced the overload gate).
  it.skipIf(typeof Bun !== "undefined")(
    "REVIEW-SEC-12: drain-start race keeps the wire ordered — one complete response, no misattribution",
    { timeout: 15_000 },
    async () => {
      const app = new Keala({ env: "test" });
      const gate = deferred();
      app.get("/slow", async (c) => {
        await gate.promise;
        c.body = "DRAIN-FIRST";
      });
      app.get("/fast", (c) => {
        c.body = "DRAIN-SECOND";
      });
      const handle = startNodeServer(app, { port: 0 });
      liveServers.push(handle);
      const server = await handle.ready();
      let closed: Promise<{ timedOut: boolean; inFlight: number }> | null = null;
      try {
        const wire = await wireExchange(
          server.port,
          async (write) => {
            write("GET /slow HTTP/1.1\r\nHost: x\r\n\r\n"); // admitted pre-drain
            await wait(60);
            closed = app.close({ drain: 5000 }); // drain starts here
            write("GET /fast HTTP/1.1\r\nHost: x\r\n\r\n"); // refused: draining
            await wait(30);
            gate.resolve();
          },
          400,
        );
        // A's response is the only one on the wire, complete and first.
        expect(statusLines(wire)).toEqual(["200"]);
        expect(wire.indexOf("DRAIN-FIRST")).toBeGreaterThan(-1);
        expect(wire.endsWith("0\r\n\r\n")).toBe(true); // cleanly terminated (chunked)
        expect(wire).not.toContain("DRAIN-SECOND"); // B never ran
        expect(wire.match(/HTTP\/1\.1/g)?.length).toBe(1); // no partial 503 fragment
        expect(headerValues(wire, "connection").map((v) => v.toLowerCase())).toEqual(["close"]);
        expect(wire.toLowerCase()).not.toContain("keep-alive");
      } finally {
        gate.resolve();
      }
      await closed;
    },
  );
});
