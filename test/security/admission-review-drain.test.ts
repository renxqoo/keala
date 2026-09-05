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

export const headerValues = (wire: string, name: string): string[] =>
  [...wire.matchAll(new RegExp(`(?:^|\\r\\n)${name}:([^\\r\\n]*)`, "gi"))].map((m) =>
    (m[1] as string).trim(),
  );

const liveServers: NodeServerHandle[] = [];
afterAll(() => {
  for (const server of liveServers) server.stop(true);
});

describe("REVIEW-SEC-17: vanished pipelined peer wedges the drain window open", () => {
  // ATTACK: during drain a hostile client pipelines one request behind an
  // in-flight one, then vanishes. The pipelined ServerResponse never started
  // writing, so Node never emits 'close' for it when the socket dies — the
  // adapter's wireInFlight keeps a phantom count and stopGraceful waits the
  // FULL drain window (default 30s) with nothing alive: every close()/SIGTERM
  // lingers the maximum. The drain timeout is a bound, not a target.
  // EXPECTATION: once the socket is gone and the app counter is 0, close()
  // resolves promptly (well inside the window).
  it.skipIf(typeof Bun !== "undefined")(
    "REVIEW-SEC-17: a vanished pipelined request does not keep close() waiting the full window",
    { timeout: 15_000 },
    async () => {
      const app = new Keala({ env: "test" });
      const gate = deferred();
      app.get("/slow", async (c) => {
        await gate.promise;
        c.body = "DRAIN-FIRST";
      });
      app.get("/fast", (c) => {
        c.body = "never";
      });
      const handle = startNodeServer(app, { port: 0 });
      liveServers.push(handle);
      const server = await handle.ready();
      // socket lifecycle is manual: die mid-drain, then measure close().
      const sock = connect(server.port, "127.0.0.1");
      sock.on("error", () => undefined);
      await new Promise<void>((resolve, reject) => {
        sock.once("connect", resolve);
        sock.once("error", reject);
      });
      sock.setEncoding("latin1");
      let buf = "";
      sock.on("data", (d: string) => {
        buf += d;
      });
      sock.write("GET /slow HTTP/1.1\r\nHost: x\r\n\r\n");
      await wait(60);
      const closed = app.close({ drain: 5000 });
      sock.write("GET /fast HTTP/1.1\r\nHost: x\r\n\r\n"); // pipelined, refused
      await wait(40);
      gate.resolve(); // the real work finishes
      await wait(200); // A's response flushes...
      expect(buf).toContain("DRAIN-FIRST"); // ...and the client vanishes
      sock.destroy();
      const started = Date.now();
      const status = await closed;
      const elapsed = Date.now() - started;
      // HOLE: elapsed ≈ the full 5000ms window (timedOut: true, inFlight: 0 —
      // a phantom wire count, nothing real is in flight).
      expect(elapsed).toBeLessThan(2500);
      expect(status.timedOut).toBe(false);
      expect(app.inFlight).toBe(0);
    },
  );
});

describe("REVIEW-SEC-13: a strategy promise that never resolves", () => {
  // ATTACK: a strategy that forgets to settle parks requests before admission
  // — does anything bound them, or do they hold slots/wire requests forever?
  // EXPECTATION: no capacity slot is taken (inFlight untouched) and the drain
  // window bounds the wire request (stopGraceful force-closes). Note: the
  // request deadline does NOT bound this park — it arms post-admission (by
  // design); only close() bounds it.
  it.skipIf(typeof Bun !== "undefined")(
    "REVIEW-SEC-13: a never-resolving strategy holds no slot and is bounded by close()",
    { timeout: 15_000 },
    async () => {
      const app = new Keala({
        env: "test",
        overload: {
          maxConcurrency: 1,
          strategy: { onSaturated: () => new Promise<Response | null>(() => undefined) },
        },
      });
      const gate = deferred();
      app.get("/hold", async (c) => {
        await gate.promise;
        c.body = "done";
      });
      const handle = startNodeServer(app, { port: 0 });
      liveServers.push(handle);
      const server = await handle.ready();
      const holder = app.handle(new Request("http://x/hold"));
      const tracker = noiseTracker();
      try {
        await wireExchange(
          server.port,
          (write) => {
            write("GET /work HTTP/1.1\r\nHost: x\r\n\r\n"); // parks in the strategy
          },
          80,
        );
        expect(app.inFlight).toBe(1); // only the holder — the parked request took nothing
        const started = Date.now();
        const closed = app.close({ drain: 300 });
        const status = await closed;
        expect(Date.now() - started).toBeLessThan(2000); // bounded by the drain window
        expect(status.timedOut).toBe(true); // the parked wire request strands
        expect(tracker.count()).toBe(0);
      } finally {
        tracker.stop();
        gate.resolve();
        await holder;
      }
    },
  );
});

describe("REVIEW-SEC-14: cached custom rejection Response reused across refusals", () => {
  // ATTACK: an overload.handler that returns ONE cached Response object for
  // every refusal (a natural "constant" optimization). Response bodies are
  // one-shot: after the first wire refusal consumed it, later refusals hand
  // out a disturbed body. EXPECTATION (R4.10 unified-loud contract): the
  // FIRST refusal answers the configured 503 cleanly framed; every REUSE
  // fails loudly through the serve-error path with a framed 500 — exactly
  // what the Bun adapter does. The old Node-only degrade branch answered an
  // UNFRAMED bodiless response that killed the keep-alive socket (R4.10
  // wire capture); build a fresh Response per call.
  it.skipIf(typeof Bun !== "undefined")(
    "REVIEW-SEC-14: a reused handler Response stays a cleanly framed 503 on every refusal",
    { timeout: 15_000 },
    async () => {
      const cached = new Response("CACHED-BUSY-BYTES", {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
      const app = new Keala({
        env: "test",
        overload: { maxConcurrency: 1, handler: () => cached },
      });
      const gate = deferred();
      app.get("/hold", async (c) => {
        await gate.promise;
        c.body = "done";
      });
      const handle = startNodeServer(app, { port: 0 });
      liveServers.push(handle);
      const server = await handle.ready();
      const holder = app.handle(new Request("http://x/hold"));
      try {
        const first = await wireExchange(server.port, (write) => {
          write("GET /one HTTP/1.1\r\nHost: x\r\n\r\n");
        });
        expect(first.startsWith("HTTP/1.1 503")).toBe(true);
        expect(first).toContain("CACHED-BUSY-BYTES");
        expect(statusLines(first)).toHaveLength(1);
        const second = await wireExchange(
          server.port,
          (write) => {
            write("GET /two HTTP/1.1\r\nHost: x\r\n\r\n");
          },
          400,
        );
        // Unified-loud: the disturbed reuse answers a FRAMED 500 through the
        // serve-error path — byte-identical story on Bun, never an unframed
        // bodiless 503 that kills the keep-alive socket.
        expect(second.startsWith("HTTP/1.1 500")).toBe(true);
        expect(second.toLowerCase()).toContain("content-type: text/plain"); // framed envelope
        expect(statusLines(second)).toHaveLength(1); // single, complete response
        expect(second.toLowerCase()).toContain("content-length:"); // delimiter present
      } finally {
        gate.resolve();
        await holder;
      }
    },
  );
});

describe("REVIEW-SEC-15: hostile clients flooding the wire queue, then abandoning", () => {
  // ATTACK: open connections, send requests that park in the admission queue,
  // then destroy the sockets. The waiters must leave via the adapter's
  // disconnect→abort bridge (docs §6 S4: "native 路径排队断开出队") — leaked
  // waiters keep the queue "full" for up to queueTimeoutMs per wave, a
  // renewable remote DoS against every queued client.
  // FINDING: the bridge is severed — admitRequest hands the strategy a
  // MATERIALIZED fetch Request (src/core/lifecycle-admission.ts:80), and the
  // built-in queue arms its abort listener on that Request's inert signal, so
  // source.disconnect() finds _abort never materialized. Eviction falls back
  // to the queueTimeoutMs timer (REVIEW-SEC-15b locks that mitigation).
  it.skipIf(typeof Bun !== "undefined")(
    "REVIEW-SEC-15: abandoned queued sockets free their queue slot on disconnect",
    { timeout: 20_000 },
    async () => {
      const app = new Keala({
        env: "test",
        overload: { maxConcurrency: 1, maxQueue: 2, queueTimeoutMs: 60_000 },
      });
      const gate = deferred();
      app.get("/work", async (c) => {
        await gate.promise;
        c.body = "done";
      });
      const handle = startNodeServer(app, { port: 0 });
      liveServers.push(handle);
      const server = await handle.ready();
      const holder = app.handle(new Request("http://x/work"));
      const tracker = noiseTracker();
      const flood: Socket[] = [];
      try {
        for (let i = 0; i < 2; i += 1) {
          const sock = connect(server.port, "127.0.0.1");
          sock.on("error", () => undefined);
          await new Promise<void>((resolve, reject) => {
            sock.once("connect", resolve);
            sock.once("error", reject);
          });
          sock.write(`GET /work?peer=${i} HTTP/1.1\r\nHost: x\r\n\r\n`);
          flood.push(sock);
        }
        await wait(100); // both are parked in the queue
        for (const sock of flood) sock.destroy();
        await wait(300); // disconnects processed by the adapter
        // The queue must be empty again: a fresh request QUEUES (silence
        // until the holder releases) rather than being refused instantly.
        let freshBuf = "";
        const fresh = connect(server.port, "127.0.0.1");
        fresh.on("error", () => undefined);
        await new Promise<void>((resolve, reject) => {
          fresh.once("connect", resolve);
          fresh.once("error", reject);
        });
        fresh.setEncoding("latin1");
        fresh.on("data", (d: string) => {
          freshBuf += d;
        });
        fresh.write("GET /work HTTP/1.1\r\nHost: x\r\n\r\n");
        await wait(300);
        expect(freshBuf).toBe(""); // HOLE: instant 503 — dead waiters still hold slots
        gate.resolve();
        await wait(200);
        expect(freshBuf.startsWith("HTTP/1.1 200")).toBe(true);
        fresh.destroy();
        await holder;
        expect(app.inFlight).toBe(0);
        expect(tracker.count()).toBe(0);
      } finally {
        tracker.stop();
        gate.resolve();
        for (const sock of flood) sock.destroy();
      }
    },
  );

  // The mitigation boundary of REVIEW-SEC-15's hole: eviction eventually
  // happens via the queueTimeoutMs TIMER, and the resulting 503 answered onto
  // the long-dead socket must stay silent (no unhandledRejection /
  // uncaughtException) and free the slot. This is the DEFENDED half.
  it.skipIf(typeof Bun !== "undefined")(
    "REVIEW-SEC-15b: timer eviction of abandoned waiters is bounded and silent",
    { timeout: 20_000 },
    async () => {
      const app = new Keala({
        env: "test",
        overload: { maxConcurrency: 1, maxQueue: 2, queueTimeoutMs: 150 },
      });
      const gate = deferred();
      app.get("/work", async (c) => {
        await gate.promise;
        c.body = "done";
      });
      const handle = startNodeServer(app, { port: 0 });
      liveServers.push(handle);
      const server = await handle.ready();
      const holder = app.handle(new Request("http://x/work"));
      const tracker = noiseTracker();
      const flood: Socket[] = [];
      try {
        for (let i = 0; i < 2; i += 1) {
          const sock = connect(server.port, "127.0.0.1");
          sock.on("error", () => undefined);
          await new Promise<void>((resolve, reject) => {
            sock.once("connect", resolve);
            sock.once("error", reject);
          });
          sock.write(`GET /work?peer=${i} HTTP/1.1\r\nHost: x\r\n\r\n`);
          flood.push(sock);
        }
        await wait(80);
        for (const sock of flood) sock.destroy();
        await wait(500); // past the 150ms timer: evicted onto dead sockets
        expect(app.inFlight).toBe(1); // capacity untouched throughout
        expect(tracker.count()).toBe(0); // dead-socket writes stayed silent
        // Slots are free again: a fresh request queues (silent) ...
        let freshBuf = "";
        const fresh = connect(server.port, "127.0.0.1");
        fresh.on("error", () => undefined);
        await new Promise<void>((resolve, reject) => {
          fresh.once("connect", resolve);
          fresh.once("error", reject);
        });
        fresh.setEncoding("latin1");
        fresh.on("data", (d: string) => {
          freshBuf += d;
        });
        fresh.write("GET /work HTTP/1.1\r\nHost: x\r\n\r\n");
        await wait(80); // well under the 150ms queue timeout
        expect(freshBuf).toBe("");
        gate.resolve();
        await wait(200);
        expect(freshBuf.startsWith("HTTP/1.1 200")).toBe(true);
        expect(freshBuf).toContain("done");
        fresh.destroy();
        await holder;
        expect(app.inFlight).toBe(0);
      } finally {
        tracker.stop();
        gate.resolve();
        for (const sock of flood) sock.destroy();
      }
    },
  );
});

describe("REVIEW-SEC-16: oversized/slow bodies during drain must not wedge stopGraceful", () => {
  // ATTACK: a client POSTs headers declaring a huge body, dribbles a few
  // bytes and keeps the connection open — the admitted handler parks on the
  // body read forever. An unbounded stopGraceful would hang shutdown.
  // EXPECTATION: close() resolves within the drain window (bounded, timedOut
  // true, the stranded request reported) and the force-closed socket's
  // fallout produces no process noise.
  it.skipIf(typeof Bun !== "undefined")(
    "REVIEW-SEC-16: a stalled upload body keeps close() bounded by its drain window",
    { timeout: 20_000 },
    async () => {
      const app = new Keala({ env: "test" });
      const tracker = noiseTracker();
      app.post("/upload", async (c) => {
        const bytes = await c.raw.arrayBuffer(); // parks — body never completes
        c.body = `got-${bytes.byteLength}`;
      });
      const handle = startNodeServer(app, { port: 0 });
      liveServers.push(handle);
      const server = await handle.ready();
      // Manual socket: the stall must survive past close() (no client-side
      // destroy that would end it early via the disconnect bridge).
      const sock = connect(server.port, "127.0.0.1");
      sock.on("error", () => undefined);
      await new Promise<void>((resolve, reject) => {
        sock.once("connect", resolve);
        sock.once("error", reject);
      });
      sock.write("POST /upload HTTP/1.1\r\nHost: x\r\nContent-Length: 10000\r\n\r\n");
      sock.write("AAAAA"); // 5 of 10000 bytes, then silence
      await wait(100);
      try {
        const started = Date.now();
        const status = await app.close({ drain: 250 });
        expect(Date.now() - started).toBeLessThan(2000); // bounded by drain
        expect(status.timedOut).toBe(true); // the stalled upload strands, reported
        expect(status.inFlight).toBe(1);
        await wait(300); // fallout from the force-closed upload socket
        expect(tracker.count()).toBe(0);
      } finally {
        tracker.stop();
        sock.destroy();
      }
    },
  );
});
