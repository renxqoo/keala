/**
 * Agent R4.4 HA/resilience review — production failure modes under shutdown
 * and overload (branch codex/hotpath-r4-4-lifecycle). One hypothesis per test
 * (HA-1 … HA-12); each comment states the failure mode + resilience
 * expectation. FAILING tests are the findings (CONFIRMED-RED — they assert
 * the documented contract, docs/HOTPATH-R4-4-MIGRATION-LIFECYCLE.md §2.2/
 * §2.3/§2.4); passing tests lock behavior test/r4-lifecycle-*.test.ts miss.
 */

import { spawn } from "node:child_process";
import { connect, type Socket } from "node:net";
import { existsSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
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

/** Slow-pull body: every pull stays parked `gap` ms before yielding a chunk. */
const slowBody = (gap: number, chunk: string): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      await wait(gap);
      controller.enqueue(encoder.encode(chunk));
    },
  });
};

describe("agent R4.4 HA review: shutdown and overload failure modes", () => {
  it(
    "HA-1: cancelling a drain-held body mid-pull keeps inFlight at exactly 0",
    { timeout: 10_000 },
    async () => {
      // Failure mode: a client disconnects mid-stream while a drain body-hold
      // wraps the response; holdBody's cancel() releases the slot, but a pull
      // parked on the slow producer settles afterwards through the error path
      // and releases a SECOND time — the counter goes negative. One release per hold.
      const app = new Keala({ env: "test" });
      const gate = deferred();
      app.get("/stream", async () => {
        await gate.promise;
        return new Response(slowBody(40, "chunk;"), { headers: { "content-type": "text/plain" } });
      });
      const inflight = app.handle(new Request("http://x/stream"));
      const closed = app.close({ drain: 800 });
      gate.resolve(); // settles DURING drain -> the body gets held
      const response = await inflight;
      expect(app.isDraining()).toBe(true);
      const reader = response.body!.getReader();
      await reader.read(); // first chunk consumed
      void reader.read(); // demand -> a wrapper pull parks on the 40ms producer
      await wait(5); // the pull is now mid-flight inside the hold
      await reader.cancel("client walked away");
      const status = await closed;
      await wait(20); // let the parked pull settle through the wrapper
      expect(status).toEqual({ timedOut: false, inFlight: 0 });
      expect(app.inFlight).toBe(0); // CONFIRMED-RED: -1 today (double release)
    },
  );

  it(
    "HA-2: wire disconnect mid-stream during drain — close() fast, inFlight truthful",
    { timeout: 15_000 },
    async () => {
      // Failure mode: during drain a held body is pipelined to a client that
      // walks away mid-stream; HA-1's double release fires on the wire path and
      // the ops-facing CloseStatus reports a negative kill count.
      // Expectation: prompt {timedOut:false, inFlight:0}.
      const app = new Keala({ env: "test" });
      const gate = deferred();
      app.get("/stream", async () => {
        await gate.promise;
        return new Response(slowBody(30, "s;"), { headers: { "content-type": "text/plain" } });
      });
      const server = await startNodeServer(app, { port: 0, hostname: "127.0.0.1" }).ready();
      liveServers.push(server);
      let sock: Socket | undefined;
      try {
        sock = await openSocket(server.port);
        sock.on("error", () => undefined);
        sock.write("GET /stream HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
        await wait(30); // the request arrived; the handler parks on the gate
        const t0 = Date.now();
        const closed = app.close({ drain: 1200 });
        gate.resolve(); // settles during drain -> body hold wraps the stream
        await wait(120); // headers + chunks flowing; pulls parked on the producer
        sock.destroy(); // the client walks away mid-stream
        const status = await closed;
        expect(status.timedOut).toBe(false); // both truths settled — no full window
        expect(status.inFlight).toBe(0); // CONFIRMED-RED: -1 today
        expect(app.inFlight).toBe(0); // CONFIRMED-RED: -1 today
        expect(Date.now() - t0).toBeLessThan(1000);
      } finally {
        sock?.destroy();
      }
    },
  );

  it.skipIf(typeof Bun !== "undefined")(
    "HA-6: stuck handler + hostile wire — drain timeout force-closes, bounded",
    { timeout: 15_000 },
    async () => {
      // Failure mode: a hung handler plus garbage on the wire during shutdown.
      // Expectation: close({drain:150}) resolves in ~150ms with {timedOut:true,
      // inFlight:1}, the listener is gone; close() must never hang.
      const app = new Keala({ env: "test" });
      const gate = deferred();
      app.get("/stuck", () => gate.promise.then(() => undefined));
      const server = await startNodeServer(app, { port: 0, hostname: "127.0.0.1" }).ready();
      liveServers.push(server);
      let garbage: Socket | undefined;
      let sock: Socket | undefined;
      try {
        // Hostile wire first: malformed request line -> clientError 400, dropped.
        garbage = await openSocket(server.port);
        garbage.on("error", () => undefined);
        garbage.write("THIS IS NOT HTTP AT ALL\r\n\r\n");
        await wait(30);
        garbage.destroy();
        sock = await openSocket(server.port);
        sock.on("error", () => undefined);
        sock.write("GET /stuck HTTP/1.1\r\nHost: x\r\n\r\n");
        await wait(40);
        expect(app.inFlight).toBe(1);
        const t0 = Date.now();
        const status = await app.close({ drain: 150 });
        const elapsed = Date.now() - t0;
        expect(status).toEqual({ timedOut: true, inFlight: 1 });
        expect(elapsed).toBeGreaterThanOrEqual(140);
        expect(elapsed).toBeLessThan(1500);
        // Listener gone — new connections are refused, close() truly stopped it.
        await expect(fetch(`http://127.0.0.1:${server.port}/stuck`)).rejects.toThrow();
      } finally {
        garbage?.destroy();
        sock?.destroy();
        gate.resolve(); // let the zombie settle eventually
      }
    },
  );

  // Node-host only: the eval-child dance (--input-type=module -e with
  // relative dist imports) misbehaves when vitest itself runs under Bun.
  // scripts/drain-verify.ts covers natural exit for BOTH runtimes.
  it.skipIf(
    typeof Bun !== "undefined" || !existsSync(new URL("../../dist/core/app.js", import.meta.url)),
  )(
    "HA-7: a child exits NATURALLY after a forced drain (no leftover loop handles)",
    { timeout: 20_000 },
    async () => {
      // Failure mode: after a forced drain (timeout branch), a leftover
      // timer/socket could keep the process alive — K8s would then SIGKILL it
      // mid-bookkeeping. Expectation: once close() resolves, node exits 0
      // naturally (no process.exit() anywhere). Requires `npm run build`
      // (the child imports ./dist) — CI builds before the suites.
      const childCode = `
import { Keala } from "./dist/core/app.js";
import { startNodeServer } from "./dist/adapters/node.js";
const app = new Keala({ env: "test" });
const never = new Promise(() => {});
app.get("/stuck", () => never.then(() => undefined));
const s = await startNodeServer(app, { port: 0, hostname: "127.0.0.1" }).ready();
process.stdout.write("LISTENING " + s.port + "\\n");
process.on("SIGTERM", () => {
  void app.close({ drain: 250 }).then((x) => {
    process.stdout.write("CLOSED " + JSON.stringify(x) + "\\n");
  });
});
`;
      // The eval-child must run under node: --input-type=module -e is node's CLI,
      // and process.execPath under a Bun-hosted vitest is bun.
      const childBin = process.execPath.includes("bun") ? "node" : process.execPath;
      const child = spawn(childBin, ["--input-type=module", "-e", childCode], {
        cwd: process.cwd(),
      });
      let out = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        out += chunk.toString("utf8");
      });
      child.stderr?.on("data", () => undefined);
      let sock: Socket | undefined;
      try {
        // Poll the child's stdout until a regex matches (bounded by `ms`).
        const waitFor = async (re: RegExp, ms: number): Promise<string> => {
          for (let i = 0; i < ms / 10; i++) {
            const match = re.exec(out);
            if (match !== null) return match[1]!;
            await wait(10);
          }
          throw new Error(`child never matched ${re.source}: ${out}`);
        };
        const port = Number(await waitFor(/LISTENING (\d+)/, 8000));
        sock = await openSocket(port);
        sock.on("error", () => undefined);
        sock.write("GET /stuck HTTP/1.1\r\nHost: x\r\n\r\n");
        await wait(50); // the request is parked server-side
        const t0 = Date.now();
        child.kill("SIGTERM");
        const closedLine = await waitFor(/CLOSED (\{.*\})/, 8000);
        const code = await new Promise<number | null>((res) => {
          // The child may exit between the CLOSED poll and this listener attach.
          if (child.exitCode !== null || child.signalCode !== null) res(child.exitCode);
          else child.once("exit", res);
        });
        expect(closedLine).toContain('"timedOut":true'); // force path taken, reported
        expect(closedLine).toContain('"inFlight":1'); // ops sees the killed request
        expect(code).toBe(0); // natural exit — no forced process.exit anywhere
        expect(Date.now() - t0).toBeLessThan(5000); // ~250ms drain, not a hang
      } finally {
        if (sock !== undefined) sock.destroy();
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    },
  );

  it(
    "HA-5: a completed close() makes the app inert; a forced-close zombie never crashes later",
    { timeout: 10_000 },
    async () => {
      // Failure mode: some path resurrects a closed app, or a zombie settling
      // after a drain:0 force-close surfaces as an unhandledRejection.
      // Expectation: closed means closed — 503 forever (via overload.handler
      // when registered), listen() throws, same settled close promise.
      const closedApp = new Keala({
        env: "test",
        overload: {
          maxConcurrency: 8,
          handler: (_r, reason) => new Response(`gate:${reason}`, { status: 503 }),
        },
      });
      closedApp.get("/x", (c) => c.text("x"));
      const first = await closedApp.close({ drain: 10 });
      expect(first).toEqual({ timedOut: false, inFlight: 0 });
      for (let i = 0; i < 3; i++) {
        const refused = await closedApp.handle(new Request("http://x/x"));
        expect(refused.status).toBe(503);
        expect(await refused.text()).toBe("gate:draining");
      }
      expect(closedApp.inFlight).toBe(0); // refusals never take a slot
      expect(() => closedApp.listen(0)).toThrow(/shutting down/);
      const again = closedApp.close();
      await expect(again).resolves.toEqual(first);
      expect(closedApp.close()).toBe(again); // still the same memoized promise
      // Forced close (drain: 0) with a zombie that settles afterwards.
      const forcedApp = new Keala({ env: "test" });
      const gate = deferred();
      forcedApp.get("/z", () => gate.promise.then(() => undefined));
      const zombie = forcedApp.handle(new Request("http://x/z"));
      const forcedStatus = await forcedApp.close({ drain: 0 });
      expect(forcedStatus).toEqual({ timedOut: true, inFlight: 1 });
      const unhandled = trackUnhandled();
      try {
        gate.resolve(); // the zombie settles long after the force-close
        const late = await zombie;
        await late.text(); // consume the (held) body so the slot returns
        expect(forcedApp.inFlight).toBe(0);
        await wait(10);
        expect(unhandled.spy).not.toHaveBeenCalled(); // no zombie explosion
      } finally {
        unhandled.off();
      }
      const stillRefused = await forcedApp.handle(new Request("http://x/z"));
      expect(stillRefused.status).toBe(503); // no resurrection
    },
  );
});
