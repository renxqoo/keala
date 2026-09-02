/**
 * agent-r44 bug hunt: R4.4 lifecycle / overload / deadline machinery.
 *
 * One test per defect hypothesis (FINDING-N). Each comment states: the
 * defect, the contract line it violates (docs/HOTPATH-R4-4-MIGRATION-
 * LIFECYCLE.md), and the failing observable. A FAILING test = confirmed
 * defect (kept red); a PASSING test = hypothesis disproved, kept as a
 * VERIFIED-OK regression lock.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { Keala } from "../src/core/app.ts";
import { startNodeServer, type NodeServerHandle } from "../src/adapters/node.ts";

const deferred = <T = void>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const wait = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

const liveServers: NodeServerHandle[] = [];
afterEach(() => {
  for (const server of liveServers.splice(0)) server.stop(true);
});

describe("agent-r44 bug hunt: FINDING-1 over the real wire", () => {
  it(
    "FINDING-13: a client disconnecting mid-body during a real Node drain drives the counter negative",
    { timeout: 10_000 },
    async () => {
      // Same defect as FINDING-1, end to end: the Node adapter pipes the
      // drain-held wrapper with pipeline(Readable.fromWeb(res.body), out); a
      // client that walks away mid-body cancels that web stream with a pull
      // in flight — the exact double-release shape.
      // CONTRACT: §2.2 rule 4 / §2.5 — `app.inFlight` is the ops-visible
      // admitted-minus-settled count; a drain that included a mid-body client
      // disconnect must leave it at 0, not -1.
      // OBSERVABLE: app.inFlight === -1 after the disconnect (expected 0).
      // STATUS: CONFIRMED-RED — observed -1 over a real 127.0.0.1 connection.
      const app = new Keala({ env: "test" });
      const gate = deferred();
      const never = deferred();
      let sent = false;
      const encoder = new TextEncoder();
      app.get("/stream", () =>
        gate.promise.then(
          () =>
            new Response(
              new ReadableStream<Uint8Array>({
                async pull(controller) {
                  if (!sent) {
                    sent = true;
                    controller.enqueue(encoder.encode("chunk0"));
                    return;
                  }
                  await never.promise;
                  controller.close();
                },
              }),
            ),
        ),
      );
      const server = await startNodeServer(app, { port: 0, hostname: "127.0.0.1" }).ready();
      liveServers.push(server);
      const base = `http://127.0.0.1:${server.port}`;

      const inflight = fetch(`${base}/stream`);
      await wait(40); // the request parks on the gate (in-flight)
      expect(app.inFlight).toBe(1);
      const closed = app.close({ drain: 3000 });
      gate.resolve(); // the handler settles DURING drain -> body-hold engaged
      const response = await inflight;
      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(first.done).toBe(false);
      await wait(15); // let the adapter's pipeline park a pull on the hold
      await reader.cancel(); // the client disconnects mid-body
      await wait(60);
      expect(app.inFlight).toBe(0); // PREDICTED ACTUAL: -1 (double release)
      await closed;
    },
  );
});

describe("agent-r44 bug hunt: stopGraceful timer lifecycle (locus contrast)", () => {
  it(
    "FINDING-14: the CORE close path on an already-settled app arms no timer (contrast to the adapters)",
    { timeout: 8000 },
    async () => {
      // Locus check for FINDING-5/6: closeApp's embedded path returns BEFORE
      // arming its timer when the counter is already zero, so only the
      // adapters leak. VERIFIED-OK lock isolating the defect's location.
      const app = new Keala({ env: "test" });
      app.get("/x", (c) => {
        c.body = "x";
      });
      await app.handle(new Request("http://x/x"));
      vi.useFakeTimers();
      try {
        expect(vi.getTimerCount()).toBe(0);
        const closed = app.close({ drain: 60_000 });
        await expect(closed).resolves.toEqual({ timedOut: false, inFlight: 0 });
        expect(vi.getTimerCount()).toBe(0); // core path is clean
      } finally {
        vi.useRealTimers();
      }
    },
  );
});

describe("agent-r44 bug hunt: Node wire accounting (VERIFIED-OK lock)", () => {
  it(
    "FINDING-12: a keep-alive burst then close() resolves clean — finish+close events count each response once",
    { timeout: 8000 },
    async () => {
      // HYPOTHESIS: wireInFlight double-decrements or leaks per response
      // (finish AND close both fire), so close() on a Node server that just
      // served traffic would hang to the drain timeout.
      // CONTRACT: §2.2 rule 7 — 停机等待 = 应用计数 ∧ wire 计数双清零.
      // RESULT: VERIFIED-OK if green (wireDone guard + onWire decrement
      // balance exactly). STATUS: VERIFIED-OK (green).
      const app = new Keala({ env: "test" });
      app.get("/n", (c) => {
        c.body = "ok";
      });
      const server = await startNodeServer(app, { port: 0, hostname: "127.0.0.1" }).ready();
      liveServers.push(server);
      const base = `http://127.0.0.1:${server.port}`;
      for (let i = 0; i < 6; i++) {
        const response = await fetch(`${base}/n`);
        expect(await response.text()).toBe("ok");
      }
      const status = await app.close({ drain: 1500 });
      expect(status).toEqual({ timedOut: false, inFlight: 0 });
    },
  );
});
