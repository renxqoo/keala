/* eslint-disable max-lines -- one review file per the task mandate (8 concurrency-combination scenarios documented in full; agent is restricted to this single file) */
/**
 * Agent R4.6 HA review — CONCURRENCY COMBINATIONS of the lifecycle machinery
 * (branch codex/r4-6-lifecycle-overload), per
 * docs/HOTPATH-R4-6-LIFECYCLE-DESIGN.md §2.2 (rules) and §8 (seams S1–S5).
 * One scenario per test (REVIEW-HA-1…8). The existing locks
 * (test/agent-r46-ha*.test.ts, test/r4-lifecycle-*.test.ts) verify each
 * mechanism in isolation; these hunt the INTERSECTIONS. FAILING tests are
 * confirmed availability violations; passing tests are resilience locks.
 */

import { connect, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Keala } from "../src/core/app.ts";
import { startNodeServer, type NodeServerHandle } from "../src/adapters/node.ts";
import { createLifecycle, installSignalBridge, releaseInFlight } from "../src/core/lifecycle.ts";
import { admitRequest } from "../src/core/lifecycle-admission.ts";
import { startBunServer, type ServeImplementation } from "../src/index.ts";
import { attachServer } from "../src/core/server-slot.ts";
import type { CloseStatus } from "../src/types.ts";

const deferred = <T = void>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};
const wait = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));
/** Wait-free coordination: poll a predicate, bounded by `ms`. */
const waitFor = async (predicate: () => boolean, ms = 2500, step = 5): Promise<void> => {
  for (let i = 0; i < Math.ceil(ms / step); i++) {
    if (predicate()) return;
    await wait(step);
  }
  throw new Error(`condition not met within ${ms}ms`);
};

const liveServers: NodeServerHandle[] = [];
afterEach(() => {
  for (const server of liveServers.splice(0)) server.stop(true);
});

/** unhandledRejection spy (typing cast per test/r4-lifecycle-timeout.test.ts). */
const trackUnhandled = (): { spy: ReturnType<typeof vi.fn>; off: () => void } => {
  const spy = vi.fn();
  (process.on as unknown as (event: string, fn: (reason: unknown) => void) => void)(
    "unhandledRejection",
    spy,
  );
  return {
    spy,
    off: () => {
      (process.off as unknown as (event: string, fn: (reason: unknown) => void) => void)(
        "unhandledRejection",
        spy,
      );
    },
  };
};

const openSocket = (port: number): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const sock = connect({ host: "127.0.0.1", port });
    sock.once("connect", () => resolve(sock));
    sock.once("error", reject);
  });
const getRequest = (path: string): string =>
  `GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`;

/**
 * Capture the signal bridge's registrations without real signals — the
 * bridge registers PERMANENT listeners via process.on (REVIEW-BUG-1 fix:
 * once-listeners consumed themselves, letting a repeated same-name signal
 * fall to the OS default disposition).
 */
const captureOnce = (): { registered: Array<[string, () => void]>; restore: () => void } => {
  const registered: Array<[string, () => void]> = [];
  const onSpy = vi.spyOn(process, "on").mockImplementation(((
    event: string | symbol,
    handler: () => void,
  ) => {
    if (typeof event === "string") registered.push([event, handler]);
    return process;
  }) as unknown as typeof process.on);
  return { registered, restore: () => onSpy.mockRestore() };
};

/** Count live Timeout handles — a leaked waiter/deadline timer survives here. */
const timeoutHandles = (): number =>
  typeof process.getActiveResourcesInfo === "function"
    ? process.getActiveResourcesInfo().filter((name) => name === "Timeout").length
    : 0;

/** N paced chunks — a slow producer for streamed bodies. */
const chunkedBody = (gap: number, chunk: string, count: number): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  let left = count;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (left === 0) {
        controller.close();
        return;
      }
      left--;
      await wait(gap);
      controller.enqueue(encoder.encode(chunk));
    },
  });
};

const dechunk = (raw: string): string => {
  let out = "";
  let at = 0;
  for (;;) {
    const lineEnd = raw.indexOf("\r\n", at);
    if (lineEnd === -1) return out;
    const size = Number.parseInt(raw.slice(at, lineEnd), 16);
    if (Number.isNaN(size) || size === 0) return out;
    out += raw.slice(lineEnd + 2, lineEnd + 2 + size);
    at = lineEnd + 2 + size + 2;
  }
};

/** Raw-socket HTTP response reader: resolves once the server closes the
 *  connection (all raw requests send `Connection: close`); chunked bodies
 *  are dechunked so streams compare byte-exact. */
const readResponse = (sock: Socket): Promise<{ head: string; body: string }> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const done = (err?: Error): void => {
      sock.off("error", failed);
      sock.off("end", ended);
      if (err) {
        reject(err);
        return;
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      const split = raw.indexOf("\r\n\r\n");
      const head = split === -1 ? raw : raw.slice(0, split);
      const body = split === -1 ? "" : raw.slice(split + 4);
      resolve({ head, body: /^transfer-encoding:\s*chunked/im.test(head) ? dechunk(body) : body });
    };
    const ended = (): void => done();
    const failed = (err: Error): void => done(err);
    sock.on("data", (chunk: Buffer) => chunks.push(chunk));
    sock.once("end", ended);
    sock.once("error", failed);
  });

describe("agent R4.6 HA review: lifecycle concurrency combinations", () => {
  it(
    "REVIEW-HA-1: overload flood — slot hygiene, bounded waiter pool, peak concurrency",
    { timeout: 20_000 },
    async () => {
      // 500-burst vs maxConcurrency=8/maxQueue=16: no counter drift, no lost
      // waiter, peak concurrency capped, pool bounded, no leaked timers.
      const app = new Keala({ env: "test", overload: { maxConcurrency: 8, maxQueue: 16 } });
      let active = 0;
      let peak = 0;
      app.get("/f/:id", async (c) => {
        active++;
        if (active > peak) peak = active;
        await wait(1);
        active--;
        c.body = `f:${c.params?.["id"]}`;
      });
      const results = await Promise.all(
        Array.from({ length: 500 }, (_, i) =>
          app.handle(new Request(`http://x/f/${i}`)).then(async (r) => ({
            status: r.status,
            body: r.status === 200 ? await r.text() : "",
          })),
        ),
      );
      expect(results.filter((r) => r.status === 200)).toHaveLength(24); // 8 slots + 16 queue
      expect(results.filter((r) => r.status === 503)).toHaveLength(476);
      for (let i = 0; i < 500; i++) {
        if (results[i]!.status === 200) expect(results[i]!.body).toBe(`f:${i}`); // byte-correct
      }
      expect(peak).toBeLessThanOrEqual(8); // capacity never oversold
      expect(app.inFlight).toBe(0); // no leaked slot after the flood

      // Unit-level flood on the same config: queue/pool internals visible.
      const lc = createLifecycle({ maxConcurrency: 8, maxQueue: 16 });
      const beforeTimers = timeoutHandles();
      const outcomes = Array.from({ length: 500 }, (_, i) =>
        Promise.resolve(admitRequest(lc, new Request(`http://x/u/${i}`))),
      );
      for (let i = 0; i < 24; i++) releaseInFlight(lc); // 16 transfers, then 8
      const settled = await Promise.all(outcomes);
      expect(settled.filter((r) => r === null)).toHaveLength(24);
      expect(settled.filter((r) => r instanceof Response && r.status === 503)).toHaveLength(476);
      expect(lc.inFlight).toBe(0);
      expect(lc.queue).toHaveLength(0); // queue fully drained
      expect(lc.waiterPool.length).toBeLessThanOrEqual(16); // bounded by maxQueue
      expect(timeoutHandles() - beforeTimers).toBeLessThanOrEqual(2); // no timer leak
    },
  );

  it(
    "REVIEW-HA-2: deadline storm — 200x504 exactly, zombies recycled nothing",
    { timeout: 20_000 },
    async () => {
      // 200 handlers blow requestTimeout=20ms at once: exactly one 504 each,
      // no double release when zombies settle, no zombie context recycled
      // into the 50 later fast requests (pooling app), no timer leak.
      const app = new Keala({ env: "test", pooling: true, requestTimeout: 20 });
      const held: unknown[] = [];
      app.use((c, next) => {
        held.push(c);
        return next();
      });
      const gate = deferred();
      app.get("/z", async (c) => {
        await gate.promise;
        c.body = "late";
      });
      app.get("/f/:id", (c) => {
        c.body = `f:${c.params?.["id"]}`;
      });
      const unhandled = trackUnhandled();
      try {
        const beforeTimers = timeoutHandles();
        const responses = await Promise.all(
          Array.from({ length: 200 }, () => app.handle(new Request("http://x/z"))),
        );
        expect(responses.map((r) => r.status).filter((s) => s === 504)).toHaveLength(200);
        expect(app.inFlight).toBe(0); // capacity freed at 504 time, exactly
        for (const r of responses) await r.text();
        gate.resolve(); // every zombie settles at once, long after its 504
        await wait(40);
        expect(app.inFlight).toBe(0); // no double release from the zombies
        expect(timeoutHandles() - beforeTimers).toBeLessThanOrEqual(3);
        expect(unhandled.spy).not.toHaveBeenCalled();
        const fast = await Promise.all(
          Array.from({ length: 50 }, (_, i) =>
            app.handle(new Request(`http://x/f/${i}`)).then(async (r) => ({
              status: r.status,
              body: await r.text(),
            })),
          ),
        );
        expect(fast.every((r) => r.status === 200)).toBe(true);
        expect(app.inFlight).toBe(0);
        const zombieContexts = new Set(held.slice(0, 200)); // first 200 = zombies
        const fastContexts = held.slice(200);
        expect(fastContexts).toHaveLength(50);
        expect(fastContexts.some((c) => zombieContexts.has(c))).toBe(false); // GC, not pool
      } finally {
        unhandled.off();
      }
    },
  );

  it(
    "REVIEW-HA-3: drain x queue x deadline triple overlap — close resolves, all 200 settle",
    { timeout: 20_000 },
    async () => {
      // close() mid-storm over a saturated queue + deadlined in-flight: the
      // queue drops to 503 "draining", deadlines free the 4 in-flight before
      // the window, close resolves {timedOut:false} inside the window, the
      // counter never goes negative, the gate refuses new work, zombies
      // release nothing later.
      const app = new Keala({
        env: "test",
        overload: {
          maxConcurrency: 4,
          maxQueue: 196,
          handler: (_r, reason) => new Response(`no:${reason}`, { status: 503 }),
        },
        requestTimeout: 25,
      });
      const gate = deferred();
      let entered = 0;
      app.get("/s/:id", async (c) => {
        entered++;
        await gate.promise;
        c.body = "late";
      });
      const unhandled = trackUnhandled();
      try {
        const handles = Array.from({ length: 200 }, (_, i) =>
          app.handle(new Request(`http://x/s/${i}`)).then(async (r) => ({
            status: r.status,
            body: r.status === 503 ? await r.text() : "",
          })),
        );
        await waitFor(() => entered === 4 && app.inFlight === 4); // 4 in, 196 queued
        let minInFlight = app.inFlight;
        const sampler = wait(120).then(() => {
          minInFlight = Math.min(minInFlight, app.inFlight);
        });
        const t0 = Date.now();
        const closed = app.close({ drain: 400 }); // mid-storm
        const results = await Promise.all(handles);
        const status = await closed;
        await sampler;
        expect(results.filter((r) => r.status === 504)).toHaveLength(4); // deadlines won
        expect(results.filter((r) => r.status === 503 && r.body === "no:draining")).toHaveLength(
          196,
        ); // whole queue dropped
        expect(results).toHaveLength(200); // no hung promises
        expect(status).toEqual({ timedOut: false, inFlight: 0 });
        expect(Date.now() - t0).toBeLessThan(390); // BY the deadlines, not the window
        expect(minInFlight).toBeGreaterThanOrEqual(0); // never negative
        expect(app.inFlight).toBe(0);
        for (let i = 0; i < 3; i++) {
          const refused = await app.handle(new Request("http://x/s/late"));
          expect(refused.status).toBe(503);
          expect(await refused.text()).toBe("no:draining"); // gate refuses new work
        }
        gate.resolve(); // zombies settle long after close resolved
        await wait(30);
        expect(app.inFlight).toBe(0); // zombie settlement released nothing twice
        expect(unhandled.spy).not.toHaveBeenCalled();
      } finally {
        unhandled.off();
        gate.resolve();
      }
    },
  );

  it(
    "REVIEW-HA-4: wire disconnect storm during overload+drain — slots return, close completes",
    { timeout: 25_000 },
    async () => {
      // 50 raw sockets destroyed at random phases (pre-handler, mid-handler,
      // mid-queue, mid-stream-body) while overload admission + a drain window
      // run. The sharpest edge: a response settling during drain for a socket
      // that closed EARLIER (zombie-resume) must still return its body-hold
      // slot. Clean clients complete byte-correct during the drain; inFlight
      // returns to EXACTLY 0; close resolves promptly {timedOut:false}.
      const app = new Keala({
        env: "test",
        overload: { maxConcurrency: 12, maxQueue: 32 },
        requestTimeout: 4000, // zombie safety net only; handlers self-bound
      });
      let entered = 0;
      const streamGate = deferred();
      app.get("/fast", (c) => {
        c.body = "fast";
      });
      app.get("/park/:id", async (c) => {
        entered++;
        await wait(600); // settles DURING the drain window
        c.body = `parked:${c.params?.["id"]}`;
      });
      app.get("/short/:id", async (c) => {
        entered++;
        await wait(50); // queued victims: short handlers
        c.body = `short:${c.params?.["id"]}`;
      });
      app.get("/stream/:id", async () => {
        await streamGate.promise; // held until the drain is running
        return new Response(chunkedBody(2, "st;", 40), {
          headers: { "content-type": "text/plain" },
        });
      });
      const server = await startNodeServer(app, { port: 0, hostname: "127.0.0.1" }).ready();
      liveServers.push(server);
      const unhandled = trackUnhandled();
      const sockets: Socket[] = [];
      const track = (sock: Socket): Socket => {
        sockets.push(sock);
        sock.on("error", () => undefined); // RSTs during the storm are expected
        return sock;
      };
      try {
        const sanity = await fetch(`http://127.0.0.1:${server.port}/fast`);
        expect(sanity.status).toBe(200);
        expect(await sanity.text()).toBe("fast");

        // Phase 1 — pre-handler chaos (28; +8 park +4 stream +10 queue = 50).
        for (let i = 0; i < 28; i++) {
          const sock = track(await openSocket(server.port));
          sock.write(getRequest("/fast"));
          await wait(1);
          sock.destroy();
        }
        // Phase 2 — mid-handler: 8 admitted /park zombies; destroy 4 while
        // their handlers are parked (socket close fires long before the
        // response exists). The other 4 stay clean.
        const parkVictims: Socket[] = [];
        const parkClean: Array<Promise<{ head: string; body: string }>> = [];
        for (let i = 0; i < 8; i++) {
          const sock = track(await openSocket(server.port));
          const response = readResponse(sock);
          sock.write(getRequest(`/park/${i}`));
          if (i % 2 === 0) parkVictims.push(sock);
          else parkClean.push(response);
        }
        await waitFor(() => entered === 8 && app.inFlight === 8);
        await wait(20);
        for (const sock of parkVictims) sock.destroy();
        // Phase 3 — streams admitted before close (capacity 12: 8 park + 4).
        const streamSockets: Socket[] = [];
        const streamReads: Array<Promise<{ head: string; body: string }>> = [];
        const sawBytes = [false, false, false, false];
        for (let i = 0; i < 4; i++) {
          const sock = track(await openSocket(server.port));
          const index = i;
          sock.on("data", () => {
            sawBytes[index] = true;
          });
          streamReads.push(readResponse(sock));
          streamSockets.push(sock);
          sock.write(getRequest(`/stream/${i}`));
        }
        await waitFor(() => app.inFlight === 12); // streams admitted, parked
        // Phase 4 — mid-queue: capacity full, these 10 queue, then die.
        for (let i = 0; i < 10; i++) {
          const sock = track(await openSocket(server.port));
          sock.write(getRequest(`/short/${i}`));
        }
        await wait(30); // parked in the queue
        for (const sock of sockets.slice(-10)) sock.destroy();
        // Phase 5 — drain mid-storm: queue dropped; streams settle DURING
        // drain (body-hold territory); 3 die mid-body, 1 stays clean.
        const t0 = Date.now();
        const closed = app.close({ drain: 1500 });
        streamGate.resolve();
        await waitFor(() => sawBytes.every(Boolean)); // bodies flowing
        await wait(10);
        for (const sock of streamSockets.slice(0, 3)) sock.destroy();
        const parks = await Promise.all(parkClean);
        for (let i = 0; i < 4; i++) {
          expect(parks[i]!.head).toMatch(/^HTTP\/1\.1 200/);
          expect(parks[i]!.body).toBe(`parked:${i * 2 + 1}`); // byte-correct
        }
        const stream = await streamReads[3]!;
        expect(stream.head).toMatch(/^HTTP\/1\.1 200/);
        expect(stream.body).toBe("st;".repeat(40)); // byte-correct through the hold
        // THE hygiene assertion: every slot returns — including the holds of
        // sockets that closed before their response existed.
        await waitFor(() => app.inFlight === 0, 2200);
        const status = await closed;
        expect(status).toEqual({ timedOut: false, inFlight: 0 });
        expect(Date.now() - t0).toBeLessThan(2200); // prompt, not window-burning
        expect(app.inFlight).toBe(0);
        expect(unhandled.spy).not.toHaveBeenCalled();
        await expect(fetch(`http://127.0.0.1:${server.port}/fast`)).rejects.toThrow(); // dead
      } finally {
        unhandled.off();
        streamGate.resolve();
        for (const sock of sockets) sock.destroy();
      }
    },
  );

  it(
    "REVIEW-HA-5: double SIGTERM under load — forced close terminates, status honest",
    { timeout: 15_000 },
    async () => {
      // The bridge's second signal escalates to force (§2.2 r9) while 100
      // requests are in flight: close idempotency must not swallow it, the
      // status must report honestly, and the zombies must settle cleanly.
      const { registered, restore } = captureOnce();
      const gate = deferred();
      const unhandled = trackUnhandled();
      try {
        const app = new Keala({ env: "test" });
        app.get("/stuck", async (c) => {
          await gate.promise;
          c.body = "late";
        });
        const zombieHandles = Array.from({ length: 100 }, () =>
          app.handle(new Request("http://x/stuck")),
        );
        expect(app.inFlight).toBe(100);
        installSignalBridge(app);
        const fire = registered.find(([event]) => event === "SIGTERM")?.[1];
        expect(fire).toBeDefined();
        fire!(); // SIGTERM #1 — graceful drain, default 30s window
        fire!(); // SIGTERM #2 — documented FORCE close
        let hung = false;
        const status = await Promise.race([
          app.close(),
          wait(1200).then(() => {
            hung = true;
            return undefined as CloseStatus | undefined;
          }),
        ]);
        expect(hung).toBe(false); // the escalation terminated the close
        expect(status).toEqual({ timedOut: true, inFlight: 100 }); // honest report
        expect(app.isDraining()).toBe(true);
        gate.resolve(); // all 100 zombies settle long after the force
        const responses = await Promise.all(zombieHandles);
        for (const r of responses) await r.text(); // consume held bodies
        expect(app.inFlight).toBe(0); // every hold returned its slot
        expect(unhandled.spy).not.toHaveBeenCalled(); // zombies contained
        await expect(app.close()).resolves.toBe(status); // still memoized
      } finally {
        unhandled.off();
        restore();
        gate.resolve();
      }
    },
  );

  it(
    "REVIEW-HA-6: WS 1001 evacuation under load — 100 sockets, hostile ones contained",
    { timeout: 10_000 },
    async () => {
      // At websocket scale the drain's courtesy close(1001) sweep must not
      // double-notify, skip sockets after a hostile close() throws, or hang.
      let wsHandlers: Record<string, (ws: unknown, ...rest: unknown[]) => void> = {};
      const impl: ServeImplementation = (options) => {
        wsHandlers = options["websocket"] as typeof wsHandlers;
        return {
          port: 0,
          hostname: "localhost",
          stop: () => {},
          fetch: async () => new Response("fake"),
          reload: () => {},
        };
      };
      const app = new Keala({ env: "test" });
      app.ws("/socket", { open: () => {}, close: () => {} });
      const handle = startBunServer(app, { port: 0 }, undefined, impl);
      const ws = wsHandlers;
      const wsKey = [...app.wsRoutes.keys()][0]!;
      const closeCalls: Array<[number, string | undefined]> = [];
      let hostile = 0;
      const sockets = Array.from({ length: 100 }, (_, i) => ({
        data: { wsKey },
        close(code?: number, reason?: string) {
          closeCalls.push([code ?? -1, reason]);
          if (i % 10 === 9) {
            hostile++;
            throw new Error("already dead");
          }
        },
      }));
      for (const socket of sockets) ws.open?.(socket); // all tracked
      expect(closeCalls).toHaveLength(0); // pre-drain: nobody bothered
      const status = await app.close({ drain: 300 }); // through the server slot
      expect(closeCalls).toHaveLength(100); // exactly once each — no skips
      for (const call of closeCalls) expect(call).toEqual([1001, "server shutting down"]);
      expect(hostile).toBe(10); // the hostile ones did not block the sweep
      expect(status).toEqual({ timedOut: false, inFlight: 0 });
      expect(handle.stopGraceful).toBeTypeOf("function");
    },
  );

  it(
    "REVIEW-HA-7: pooling x drain x streaming soak — byte-correct, close clean, late writes throw",
    { timeout: 25_000 },
    async () => {
      // 300 mixed requests (fast/streaming/slow) on a pooling app with
      // close() at the midpoint: drain holds wrapping retired contexts must
      // not corrupt recycling (late writes land as THROWS) or truncate
      // bodies; close resolves {timedOut:false} once every hold released.
      const app = new Keala({
        env: "test",
        pooling: true,
        overload: { maxConcurrency: 16, maxQueue: 64 },
      });
      const held: unknown[] = [];
      app.use((c, next) => {
        held.push(c); // admission order == dispatch order (synchronous serve)
        return next();
      });
      const slowGate = deferred();
      app.get("/fast/:id", (c) => {
        c.body = `fast:${c.params?.["id"]}`;
      });
      app.get("/slow/:id", async (c) => {
        await slowGate.promise;
        c.body = `slow:${c.params?.["id"]}`;
      });
      app.get("/stream/:id", (c) =>
        Promise.resolve(
          new Response(chunkedBody(1, `s${c.params?.["id"]};`, 24), {
            headers: { "content-type": "text/plain" },
          }),
        ),
      );
      const unhandled = trackUnhandled();
      try {
        const handles = Array.from({ length: 300 }, (_, i) => {
          const kind = i % 3;
          const route = kind === 0 ? "fast" : kind === 1 ? "stream" : "slow";
          return app.handle(new Request(`http://x/${route}/${i}`));
        });
        await wait(10); // admission settles: 16 running, 64 queued, rest refused
        const closed = app.close({ drain: 4000 }); // midpoint
        await wait(10);
        slowGate.resolve(); // slow handlers settle during drain
        const responses = await Promise.all(handles);
        const results = responses.map((r, i) => ({ i, r }));
        const served = results.filter(({ r }) => r.status === 200);
        const refused = results.filter(({ r }) => r.status === 503);
        expect(served.length).toBeGreaterThanOrEqual(16); // full capacity ran
        expect(served.length + refused.length).toBe(300); // nothing else leaked out
        const firstRefused = results.findIndex(({ r }) => r.status === 503);
        for (const { r } of results.slice(firstRefused)) {
          expect(r.status).toBe(503); // admission is a prefix: no 503 -> 200
        }
        expect(held.length).toBe(served.length); // refusals made no context
        // Refused bodies first, then served ones IN ORDER: the last-consumed
        // 200 retires its context last (nothing re-acquires it afterwards).
        for (const { r } of refused) await r.text();
        for (const { i, r } of served) {
          const kind = i % 3;
          const expected =
            kind === 0 ? `fast:${i}` : kind === 1 ? `s${i};`.repeat(24) : `slow:${i}`;
          expect(await r.text()).toBe(expected); // byte-correct through holds
        }
        const status = await closed;
        expect(status).toEqual({ timedOut: false, inFlight: 0 }); // holds released
        expect(app.inFlight).toBe(0);
        const lastCtx = held[held.length - 1]!;
        expect(() => {
          (lastCtx as unknown as { status: number }).status = 500;
        }).toThrow(/retired/); // late write THROWS, never silently mutates
        expect(unhandled.spy).not.toHaveBeenCalled();
      } finally {
        unhandled.off();
        slowGate.resolve();
      }
    },
  );

  it(
    "REVIEW-HA-8: escalation storm — 10 concurrent close() calls, one force effect",
    { timeout: 15_000 },
    async () => {
      // Ten close() calls race with mixed drain values (0 and large) while a
      // request is stuck: one memoized promise (one CloseStatus identity),
      // exactly one stopGraceful + one observable force-stop, termination
      // within the escalation (<< the 8s window), honest status.
      const app = new Keala({ env: "test" });
      const gate = deferred();
      app.get("/stuck", async (c) => {
        await gate.promise;
        c.body = "late";
      });
      const server = await startNodeServer(app, { port: 0, hostname: "127.0.0.1" }).ready();
      liveServers.push(server);
      // Wrap the registered handle to count observable escalation effects on
      // the REAL adapter (delegated untouched).
      let gracefulStops = 0;
      let forceStops = 0;
      attachServer(app, {
        stop: (closeActive?: boolean) => {
          if (closeActive) forceStops++;
          server.stop(closeActive);
        },
        stopGraceful: (options) => {
          gracefulStops++;
          return server.stopGraceful(options);
        },
      });
      const unhandled = trackUnhandled();
      let sock: Socket | undefined;
      try {
        sock = await openSocket(server.port);
        sock.on("error", () => undefined);
        sock.write(getRequest("/stuck"));
        await waitFor(() => app.inFlight === 1);
        const t0 = Date.now();
        const calls: Array<Promise<CloseStatus>> = [];
        for (let i = 0; i < 10; i++) {
          calls.push(
            app.close(i === 0 ? { drain: 8000 } : i % 2 === 0 ? { drain: 0 } : { drain: 6000 }),
          );
        }
        expect(new Set(calls).size).toBe(1); // one memoized close promise
        let hung = false;
        const status = await Promise.race([
          calls[0]!,
          wait(1500).then(() => {
            hung = true;
            return undefined as CloseStatus | undefined;
          }),
        ]);
        expect(hung).toBe(false); // escalated, not the 8s window
        expect(Date.now() - t0).toBeLessThan(1500);
        expect(status).toEqual({ timedOut: true, inFlight: 1 }); // honest
        expect(gracefulStops).toBe(1); // exactly one stopGraceful
        expect(forceStops).toBe(1); // exactly one observable force-stop
        await expect(app.close({ drain: 0 })).resolves.toBe(status); // inert after
        expect(forceStops).toBe(1); // no re-escalation
        expect(app.inFlight).toBeGreaterThanOrEqual(0); // never negative
        gate.resolve();
        await wait(50);
        expect(unhandled.spy).not.toHaveBeenCalled();
        await expect(fetch(`http://127.0.0.1:${server.port}/stuck`)).rejects.toThrow(); // dead
      } finally {
        unhandled.off();
        gate.resolve();
        sock?.destroy();
      }
    },
  );
});
