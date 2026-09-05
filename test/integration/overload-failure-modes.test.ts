/**
 * Agent R4.4 HA/resilience review — production failure modes under shutdown
 * and overload (branch codex/hotpath-r4-4-lifecycle). One hypothesis per test
 * (HA-1 … HA-12); each comment states the failure mode + resilience
 * expectation. FAILING tests are the findings (CONFIRMED-RED — they assert
 * the documented contract, docs/HOTPATH-R4-4-MIGRATION-LIFECYCLE.md §2.2/
 * §2.3/§2.4); passing tests lock behavior test/r4-lifecycle-*.test.ts miss.
 */

import { connect, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Keala } from "../../src/core/app.ts";
import { installSignalBridge } from "../../src/core/lifecycle.ts";
import { startNodeServer, type NodeServerHandle } from "../../src/adapters/node.ts";
import { startBunServer, type ServeImplementation } from "../../src/index.ts";
import type { CloseStatus } from "../../src/types.ts";

const deferred = <T = void>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};
const wait = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

/** Real HTTP servers started in-process — force-stopped after each test. */
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

/** Raw TCP socket, connected; post-connect errors are the caller's business. */
const openSocket = (port: number): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const sock = connect({ host: "127.0.0.1", port });
    sock.once("connect", () => resolve(sock));
    sock.once("error", reject);
  });

/** Capture the signal bridge's registrations without real signals — the
 * bridge registers PERMANENT listeners via process.on (REVIEW-BUG-1 fix). */
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

/** Count live Timeout handles — a leaked deadline timer survives here. */
const timeoutHandles = (): number =>
  typeof process.getActiveResourcesInfo === "function"
    ? process.getActiveResourcesInfo().filter((name) => name === "Timeout").length
    : 0;

describe("agent R4.4 HA review: shutdown and overload failure modes", () => {
  it(
    "HA-8: overload flood — zero slot leaks, strict FIFO, healthy afterwards",
    { timeout: 15_000 },
    async () => {
      // Failure mode: under sustained load the admission counter drifts (a
      // leaked slot, a lost waiter) — later shutdowns hang or the queue
      // reorders. Expectation: every request settles once, served requests
      // start in strict issuance order, inFlight returns to exactly 0.
      const app = new Keala({ env: "test", overload: { maxConcurrency: 1, maxQueue: 128 } });
      const startOrder: number[] = [];
      app.get("/f/:id", async (c) => {
        const id = Number(c.params("id"));
        startOrder.push(id);
        await wait(1);
        return c.text(String(id));
      });
      const handles = Array.from({ length: 300 }, (_, i) =>
        app
          .handle(new Request(`http://x/f/${i}`))
          .then(async (r) => ({ status: r.status, body: r.status === 200 ? await r.text() : "" })),
      );
      const results = await Promise.all(handles);
      expect(results.filter((r) => r.status === 200)).toHaveLength(129); // 1 slot + 128 queue
      expect(results.filter((r) => r.status === 503)).toHaveLength(171); // rest fail fast
      expect(startOrder).toEqual(Array.from({ length: 129 }, (_, i) => i)); // strict FIFO
      expect(app.inFlight).toBe(0); // no leaked slot after the flood
      // Still healthy: a follow-up wave serves normally.
      const secondWave = await Promise.all(
        Array.from({ length: 20 }, () => app.handle(new Request("http://x/f/999"))),
      );
      expect(secondWave.every((r) => r.status === 200)).toBe(true);
      expect(app.inFlight).toBe(0);
    },
  );

  it(
    "HA-9: deadline storm — exactly one 504 each, exact counter, no timer leaks",
    { timeout: 15_000 },
    async () => {
      // Failure mode: dozens of concurrent handlers blow the deadline at once —
      // a double release, a lost 504, or a leaked setTimeout per zombie would
      // corrupt capacity. Expectation: exactly 60x504, inFlight === 0 right
      // after the 504s AND after the zombies settle; Timeout count not grown.
      const app = new Keala({ env: "test", requestTimeout: 25 });
      const gates = Array.from({ length: 60 }, () => deferred());
      let next = 0;
      app.get("/z", () => gates[next++]!.promise.then(() => undefined));
      const unhandled = trackUnhandled();
      try {
        const beforeTimers = timeoutHandles();
        const handles = Array.from({ length: 60 }, () => app.handle(new Request("http://x/z")));
        const responses = await Promise.all(handles);
        const statuses = responses.map((r) => r.status);
        expect(statuses.filter((s) => s === 504)).toHaveLength(60); // exactly one 504 each
        expect(app.inFlight).toBe(0); // capacity freed at 504 time, exactly
        for (const r of responses) await r.text();
        for (const gate of gates) gate.resolve(); // zombies settle late
        await wait(60);
        expect(app.inFlight).toBe(0); // no double release from the zombies
        expect(timeoutHandles() - beforeTimers).toBeLessThanOrEqual(3); // a leak would be +60
        expect(unhandled.spy).not.toHaveBeenCalled();
      } finally {
        unhandled.off();
      }
    },
  );

  it(
    "HA-10: the abort bridge never fires after response finish (writableEnded guard)",
    { timeout: 10_000 },
    async () => {
      // Failure mode: Node's res 'close' also fires after a normal finish
      // (Connection: close teardown); an unguarded bridge would abort c.signal
      // for every completed response and cancel innocent upstream work.
      // Expectation: close-after-finish must NOT abort the bridged signal.
      const app = new Keala({ env: "test" });
      let signalSeen: AbortSignal | undefined;
      app.get("/done", async (c) => {
        signalSeen = c.signal;
        return c.text("done");
      });
      const server = await startNodeServer(app, { port: 0, hostname: "127.0.0.1" }).ready();
      liveServers.push(server);
      let sock: Socket | undefined;
      try {
        sock = await openSocket(server.port);
        sock.on("error", () => undefined);
        sock.on("data", () => undefined); // flowing mode — 'end' needs consumption
        const finished = new Promise<void>((resolve) => sock!.once("end", resolve));
        sock.write("GET /done HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
        await finished; // response finished AND the socket closed after finish
        await wait(50);
        expect(signalSeen?.aborted).toBe(false); // the guard holds
      } finally {
        sock?.destroy();
      }
    },
  );

  it(
    "HA-3: double SIGTERM force-closes a hung drain (idempotency must not swallow it)",
    { timeout: 15_000 },
    async () => {
      // Failure mode: ops hammers SIGTERM on a hung drain. Contract §2.2 r9:
      // the SECOND signal force-closes ({drain: 0}); closeApp memoizes the
      // first close, so the second close({drain:0}) is silently swallowed —
      // the process hangs for the full default window.
      const { registered, restore } = captureOnce();
      const gate = deferred();
      let stuckHandle: Promise<Response> | undefined;
      try {
        const app = new Keala({ env: "test" });
        app.get("/stuck", () => gate.promise.then(() => undefined));
        stuckHandle = app.handle(new Request("http://x/stuck"));
        installSignalBridge(app);
        const fire = registered.find(([event]) => event === "SIGTERM")?.[1];
        expect(fire).toBeDefined();
        fire!(); // SIGTERM #1 — graceful drain (default window)
        fire!(); // SIGTERM #2 — documented FORCE close
        let hung = false;
        const status = await Promise.race([
          app.close(),
          wait(1200).then(() => {
            hung = true;
            return undefined as CloseStatus | undefined;
          }),
        ]);
        expect(hung).toBe(false); // CONFIRMED-RED: the force never happens
        expect(status?.timedOut).toBe(true);
        expect(status?.inFlight).toBe(1);
      } finally {
        restore();
        gate.resolve(); // let the memoized close settle for hygiene
        await stuckHandle?.then((r) => r.text()).catch(() => undefined);
      }
    },
  );

  it(
    "HA-4: SIGTERM after a completed drain is an idempotent no-op",
    { timeout: 10_000 },
    async () => {
      // Failure mode: a stray/delayed signal hits an app whose close() already
      // resolved — a second close attempt could throw or restart drain
      // bookkeeping. Expectation: the second call returns the same settled
      // promise, no throw, draining never regresses.
      const { registered, restore } = captureOnce();
      try {
        const app = new Keala({ env: "test" });
        app.get("/x", (c) => {
          return c.text("x");
        });
        installSignalBridge(app);
        const fire = registered.find(([event]) => event === "SIGTERM")?.[1];
        expect(fire).toBeDefined();
        fire!(); // SIGTERM #1 — no in-flight work, resolves at once
        const first = await app.close();
        expect(first).toEqual({ timedOut: false, inFlight: 0 });
        fire!(); // SIGTERM #2 lands long after completion
        await expect(app.close()).resolves.toBe(first); // same promise, settled
        expect(app.isDraining()).toBe(true); // sticky, never regresses
        expect(() => fire!()).not.toThrow();
      } finally {
        restore();
      }
    },
  );

  it(
    "HA-11: signals:true coexists with the user's own SIGTERM handler",
    { timeout: 10_000 },
    async () => {
      // Failure mode: the bridge monopolizes SIGTERM (on-style stacking or
      // replacing the user's handler) — custom shutdown cleanup (flush, audit)
      // would be skipped. Expectation: process.once registration (no leak
      // across repeated signals); a user handler alongside still runs.
      const { registered, restore } = captureOnce();
      try {
        const app = new Keala({ env: "test" });
        app.get("/x", (c) => {
          return c.text("x");
        });
        installSignalBridge(app);
        expect(registered.map(([event]) => event).toSorted()).toEqual(["SIGINT", "SIGTERM"]);
        let userSaw = 0;
        for (const [event, bridgeHandler] of registered) {
          if (event === "SIGTERM") {
            userSaw++; // Node runs every listener: user first…
            bridgeHandler(); // …then the bridge
          }
        }
        expect(userSaw).toBe(1);
        expect(app.isDraining()).toBe(true);
        const status = await app.close();
        expect(status).toEqual({ timedOut: false, inFlight: 0 });
        for (const [, bridgeHandler] of registered) {
          expect(() => bridgeHandler()).not.toThrow(); // extra signals: inert
        }
        await expect(app.close()).resolves.toEqual(status);
      } finally {
        restore();
      }
    },
  );

  it(
    "HA-12: ws drain 1001 to every socket; hostile socket and throwing close handler contained",
    { timeout: 10_000 },
    async () => {
      // Failure mode: during drain one dead socket throws on close(1001) and a
      // user ws close handler throws when the courtesy close lands — either
      // could abort the loop or become an unhandledRejection (a process killer
      // under Bun.serve). Expectation: every socket still gets its 1001, the
      // drain completes, the throw is contained via the console fallback.
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
      const app = new Keala({ env: "production" }); // production: the fallback logs
      app.ws("/socket", {
        close: () => {
          throw new Error("user close handler exploded");
        },
      });
      const handle = startBunServer(app, { port: 0 }, undefined, impl);
      const ws = wsHandlers;
      const wsKey = [...app.wsRoutes.keys()][0]!;
      const closeCalls: string[] = [];
      const socketOf = (mark: string, hostile: boolean): unknown => ({
        data: { wsKey },
        close(code?: number) {
          closeCalls.push(hostile ? `${mark}:throw` : `${mark}:${code}`);
          if (hostile) throw new Error("already dead");
        },
      });
      const [a, b, c] = [socketOf("a", false), socketOf("b", true), socketOf("c", false)];
      ws.open?.(a);
      ws.open?.(b);
      ws.open?.(c);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const unhandled = trackUnhandled();
      try {
        await expect(handle.stopGraceful!({ drain: 100, onSettled: () => true })).resolves.toEqual({
          timedOut: false,
        });
        // Every tracked socket got the 1001 attempt — the hostile one did not
        // stop the loop.
        expect(closeCalls).toEqual(["a:1001", "b:throw", "c:1001"]);
        ws.close?.(a, 1001, "server shutting down"); // Bun notifies; user throws
        await wait(10);
        expect(errorSpy).toHaveBeenCalled(); // routed to the fallback, logged
        expect(unhandled.spy).not.toHaveBeenCalled(); // contained, not exploded
      } finally {
        unhandled.off();
        errorSpy.mockRestore();
      }
    },
  );
});
