/**
 * R4.6 behavior locks: graceful drain (`app.close`).
 *
 * Contract (docs/HOTPATH-R4-6-LIFECYCLE-DESIGN.md §2.2):
 * - draining refuses NEW requests pre-context (503 + connection: close —
 *   never reaches the error funnel);
 * - in-flight requests complete; close() resolves {timedOut:false};
 * - drain:0 forces immediately; a stuck request past the window reports
 *   {timedOut:true, inFlight};
 * - responses settling DURING drain hold their slot until the body is
 *   consumed (stream completion, not settle time);
 * - idempotent close; listen() after close throws; isDraining/inFlight.
 *
 * Seam red tests (IMPLEMENTATION §4): S2 drain×bytes / drain×cleanupUnread /
 * post-force wire zero; S3 holdBody×committed-headers.
 */

import { afterAll, describe, expect, it, vi } from "vitest";
import { Keala } from "../../src/core/app.ts";
import { startNodeServer, type NodeServerHandle } from "../../src/adapters/node.ts";
import { streamText } from "../../src/helpers/streams.ts";
import { readBodyLimited } from "../../src/plugins/body-parser.ts";
import type { Context } from "../../src/core/context/context.ts";

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

describe("R4.6 drain: handle mode (no server)", () => {
  it("lets in-flight requests complete, then resolves {timedOut:false}", async () => {
    const app = new Keala({ env: "test" });
    const gate = deferred();
    app.get("/slow", async (c) => {
      await gate.promise;
      return c.text("done");
    });

    const inflight = app.handle(new Request("http://x/slow"));
    expect(app.inFlight).toBe(1);
    expect(app.isDraining()).toBe(false);

    const closed = app.close({ drain: 2000 });
    expect(app.isDraining()).toBe(true);
    // New requests are refused at the gate — pre-context.
    const refused = await app.handle(new Request("http://x/slow"));
    expect(refused.status).toBe(503);
    expect(refused.headers.get("connection")).toBe("close");
    expect(refused.headers.get("retry-after")).toBeNull();

    gate.resolve();
    expect(await (await inflight).text()).toBe("done");
    await expect(closed).resolves.toEqual({ timedOut: false, inFlight: 0 });
    expect(app.inFlight).toBe(0);
  });

  it("refused requests never reach the error funnel (pre-context)", async () => {
    const app = new Keala({ env: "test" });
    const mapper = vi.fn(() => new Response("mapper"));
    app.onError(mapper);
    void app.close({ drain: 50 });
    await app.handle(new Request("http://x/anything"));
    expect(mapper).not.toHaveBeenCalled();
  });

  it("drain:0 force-closes immediately, reporting the stranded request", async () => {
    const app = new Keala({ env: "test" });
    const gate = deferred();
    app.get("/stuck", () => gate.promise.then(() => undefined));
    void app.handle(new Request("http://x/stuck"));
    const status = await app.close({ drain: 0 });
    expect(status).toEqual({ timedOut: true, inFlight: 1 });
    gate.resolve();
  });

  it("a stuck request past the drain window reports {timedOut:true, inFlight:1}", async () => {
    const app = new Keala({ env: "test" });
    const gate = deferred();
    app.get("/stuck", () => gate.promise.then(() => undefined));
    void app.handle(new Request("http://x/stuck"));
    const status = await app.close({ drain: 40 });
    expect(status.timedOut).toBe(true);
    expect(status.inFlight).toBe(1);
    gate.resolve();
  });

  it("close() is idempotent — the same promise object comes back", async () => {
    const app = new Keala({ env: "test" });
    const first = app.close({ drain: 50 });
    const second = app.close({ drain: 9999 });
    expect(second).toBe(first);
    await first;
  });

  it("listen() after close() throws, isDraining never regresses", async () => {
    const app = new Keala({ env: "test" });
    await app.close({ drain: 10 });
    expect(app.isDraining()).toBe(true);
    expect(() => app.listen(0)).toThrow(/shutting down/);
  });

  it("a response settling during drain holds its slot until the body is consumed", async () => {
    const app = new Keala({ env: "test" });
    const gate = deferred();
    app.get("/stream", async (c) => {
      // Park until drain started, THEN settle with a streaming body — the
      // settle-time wrap must hold the slot for the body's lifetime.
      await gate.promise;
      return streamText(c, async (w) => {
        for (let i = 0; i < 5; i++) {
          await wait(15);
          w.write(`chunk-${i};`);
        }
      });
    });

    // The handler parks synchronously at its first await inside handle().
    const inflight = app.handle(new Request("http://x/stream"));
    expect(app.inFlight).toBe(1);
    const closed = app.close({ drain: 3000 });
    gate.resolve();
    const response = await inflight;
    expect(app.isDraining()).toBe(true);
    // Body not yet consumed: the hold keeps the drain open.
    await wait(30);
    let resolved = false;
    void closed.then(() => {
      resolved = true;
    });
    expect(resolved).toBe(false);
    const text = await response.text();
    expect(text).toContain("chunk-4;");
    await expect(closed).resolves.toEqual({ timedOut: false, inFlight: 0 });
  });

  it("a reused (locked-body) Response during drain fails loud and does not hang the drain", async () => {
    const app = new Keala({ env: "test" });
    const gate = deferred();
    app.get("/reused", async () => {
      await gate.promise;
      const reused = new Response("only-once");
      await reused.text(); // consumes the body — the stream is now locked/used
      return reused;
    });
    const inflight = app.handle(new Request("http://x/reused"));
    const closed = app.close({ drain: 500 });
    gate.resolve();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await inflight;
    errorSpy.mockRestore();
    expect(response.status).toBe(200); // the Response passes through
    await expect(closed).resolves.toEqual({ timedOut: false, inFlight: 0 });
  });

  it("a stream erroring mid-hold releases the slot (drain still completes)", async () => {
    const app = new Keala({ env: "test" });
    const gate = deferred();
    app.get("/broken", async (c) => {
      await gate.promise;
      return streamText(c, async (w) => {
        w.write("partial");
        throw new Error("producer died");
      });
    });
    const inflight = app.handle(new Request("http://x/broken"));
    const closed = app.close({ drain: 1000 });
    gate.resolve();
    const response = await inflight;
    await expect(response.text()).rejects.toThrow();
    await expect(closed).resolves.toEqual({ timedOut: false, inFlight: 0 });
  });

  it("a consumer cancelling the held body releases the slot", async () => {
    const app = new Keala({ env: "test" });
    const gate = deferred();
    app.get("/stream", async (c) => {
      await gate.promise;
      return streamText(c, async (w) => {
        for (let i = 0; i < 20; i++) {
          await wait(10);
          w.write("x");
        }
      });
    });
    const inflight = app.handle(new Request("http://x/stream"));
    const closed = app.close({ drain: 1000 });
    gate.resolve();
    const response = await inflight;
    await response.body!.cancel(); // consumer walks away mid-hold
    await expect(closed).resolves.toEqual({ timedOut: false, inFlight: 0 });
  });

  it("close() validates the drain option loudly", async () => {
    const app = new Keala({ env: "test" });
    expect(() => app.close({ drain: -1 })).toThrow(TypeError);
    expect(() => app.close({ drain: Number.NaN })).toThrow(TypeError);
    await app.close({ drain: 10 });
  });
});

describe("R4.6 drain: Node adapter (wire truth)", () => {
  it.skipIf(typeof Bun !== "undefined")(
    "drains a slow request under real HTTP, then stops accepting",
    async () => {
      const app = new Keala({ env: "test" });
      const gate = deferred();
      app.get("/slow", async (c) => {
        await gate.promise;
        return c.text("wire-done");
      });
      const server = await startNodeServer(app, { port: 0, hostname: "127.0.0.1" }).ready();
      liveServers.push(server);
      const base = `http://127.0.0.1:${server.port}`;

      const inflight = fetch(`${base}/slow`);
      await wait(20); // let the request arrive and hold the gate
      const closed = app.close({ drain: 2000 });
      gate.resolve();
      const response = await inflight;
      expect(await response.text()).toBe("wire-done");
      await expect(closed).resolves.toEqual({ timedOut: false, inFlight: 0 });
      // After close resolves the listener is gone — new connections fail clean.
      let refused = false;
      try {
        await fetch(`${base}/slow`);
      } catch {
        refused = true;
      }
      expect(refused).toBe(true);
    },
  );

  it("close waits for wire completion, not handler settle (streaming body)", async () => {
    const app = new Keala({ env: "test" });
    app.get("/stream", (c) => {
      // Handler settles at once; the body flushes for ~120ms.
      return streamText(c, async (w) => {
        for (let i = 0; i < 6; i++) {
          await wait(20);
          w.write(`s${i};`);
        }
      });
    });
    const server = await startNodeServer(app, { port: 0, hostname: "127.0.0.1" }).ready();
    liveServers.push(server);
    const base = `http://127.0.0.1:${server.port}`;

    const inflight = fetch(`${base}/stream`);
    const response = await inflight; // headers arrived — handler long settled
    let resolved = false;
    const closed = app.close({ drain: 3000 });
    void closed.then(() => {
      resolved = true;
    });
    await wait(60); // mid-stream: app counter is 0, wire is not
    expect(resolved).toBe(false);
    const text = await response.text();
    expect(text).toContain("s5;");
    await expect(closed).resolves.toEqual({ timedOut: false, inFlight: 0 });
  });

  it.skipIf(typeof Bun !== "undefined")(
    "a BUSY socket is spared by the idle sweep; its response carries connection: close (drain policy)",
    async () => {
      const app = new Keala({ env: "test" });
      const gate = deferred();
      app.get("/hold", async (c) => {
        await gate.promise;
        return c.text("held-ok");
      });
      const server = await startNodeServer(app, { port: 0, hostname: "127.0.0.1" }).ready();
      liveServers.push(server);

      const inflight = fetch(`http://127.0.0.1:${server.port}/hold`);
      await wait(30); // the request parks: its socket is BUSY (in-flight)
      expect(app.inFlight).toBe(1);
      const closed = app.close({ drain: 2000 }); // idle sweep runs here
      gate.resolve();
      const response = await inflight; // completes — the sweep spared the busy socket
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("held-ok");
      // Written during drain: the keep-alive policy flips to close so the
      // socket tears down instead of lingering past shutdown.
      expect(response.headers.get("connection")).toBe("close");
      await closed;
    },
  );

  it("pooling apps drain normally (contexts recycle through the drain window)", async () => {
    const app = new Keala({ env: "test", pooling: true });
    const gate = deferred();
    app.get("/slow", async (c) => {
      await gate.promise;
      return c.text("pooled-done");
    });
    const server = await startNodeServer(app, { port: 0, hostname: "127.0.0.1" }).ready();
    liveServers.push(server);
    const inflight = fetch(`http://127.0.0.1:${server.port}/slow`);
    await wait(20);
    const closed = app.close({ drain: 2000 });
    gate.resolve();
    expect(await (await inflight).text()).toBe("pooled-done");
    await expect(closed).resolves.toEqual({ timedOut: false, inFlight: 0 });
  });
});

describe("R4.6 drain: handlers observe draining (query-only readiness)", () => {
  it("handlers can observe draining via isDraining (query-only readiness)", async () => {
    const app = new Keala({ env: "test" });
    const seen: boolean[] = [];
    const gate = deferred();
    app.get("/probe", async (c: Context) => {
      await gate.promise;
      seen.push(app.isDraining());
      return c.text("probed");
    });
    const inflight = app.handle(new Request("http://x/probe"));
    const closed = app.close({ drain: 1000 });
    gate.resolve();
    const response = await inflight;
    expect(seen).toEqual([true]);
    // A bodied response settling during drain holds its slot until the
    // body is consumed — read it so the drain can complete.
    expect(await response.text()).toBe("probed");
    await closed;
  });
});

describe("R4.6 seam red tests: S2 drain × node transport, S3 hold × committed headers", () => {
  it("S2: a handler awaiting bounded body bytes through the drain window completes clean", async () => {
    const app = new Keala({ env: "test" });
    const gate = deferred();
    app.post("/echo", async (c) => {
      // Bounded read through the native source's bytes(limit) — S2: the
      // read is in flight when stopGraceful begins; it must finish, not
      // wedge the drain or leak the connection.
      const raw = await readBodyLimited(c, 1024 * 1024);
      await gate.promise;
      return c.text(new TextDecoder().decode(raw));
    });
    const server = await startNodeServer(app, { port: 0, hostname: "127.0.0.1" }).ready();
    liveServers.push(server);
    const base = `http://127.0.0.1:${server.port}`;

    const inflight = fetch(`${base}/echo`, {
      method: "POST",
      body: "payload",
    });
    await wait(30); // the body read parks at the gate
    const closed = app.close({ drain: 2000 });
    gate.resolve();
    const response = await inflight;
    expect(await response.text()).toBe("payload");
    await expect(closed).resolves.toEqual({ timedOut: false, inFlight: 0 });
  });

  it("S2: an unread request body is cleaned up during drain (keep-alive stays parseable)", async () => {
    const app = new Keala({ env: "test" });
    const gate = deferred();
    app.post("/ignore", async (c) => {
      await gate.promise;
      return c.text("ignored-body");
    });
    const server = await startNodeServer(app, { port: 0, hostname: "127.0.0.1" }).ready();
    liveServers.push(server);
    const base = `http://127.0.0.1:${server.port}`;

    const inflight = fetch(`${base}/ignore`, {
      method: "POST",
      body: "never-read",
    });
    await wait(30);
    const closed = app.close({ drain: 2000 });
    gate.resolve();
    const response = await inflight;
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ignored-body");
    await expect(closed).resolves.toEqual({ timedOut: false, inFlight: 0 });
  });

  // Node-host only: the forced-close wire-zero contract is node:http's
  // close/connection-refusal timing; under a Bun-hosted vitest the node:http
  // shim diverges (verified failing on the lifecycle branch itself).
  it.skipIf(typeof Bun !== "undefined")(
    "S2: a forced close past the drain window refuses new connections (wire zero)",
    async () => {
      const app = new Keala({ env: "test" });
      const gate = deferred();
      app.get("/stuck", async () => {
        await gate.promise;
        return new Response("late");
      });
      const server = await startNodeServer(app, { port: 0, hostname: "127.0.0.1" }).ready();
      liveServers.push(server);
      const base = `http://127.0.0.1:${server.port}`;

      const inflight = fetch(`${base}/stuck`).catch((error) => {
        // The parked request dies with the force-closed socket — observe it
        // here so the rejection never escapes as an unhandled error.
        void error;
        return new Response("died", { status: 503 });
      });
      await wait(30);
      const closed = app.close({ drain: 60 }); // window expires → force
      const status = await closed;
      expect(status.timedOut).toBe(true);
      expect(status.inFlight).toBe(1);
      // The wire was force-cleared: new connections refuse.
      let refused = false;
      try {
        await fetch(`${base}/stuck`);
      } catch {
        refused = true;
      }
      expect(refused).toBe(true);
      await inflight; // already observed — dies with the force-closed socket
      gate.resolve();
    },
  );

  it("S3: a committed Response with late-mutated headers holds through drain without double-writing", async () => {
    const app = new Keala({ env: "test" });
    const gate = deferred();
    app.use(async (c, next) => {
      await next();
      // Post-commit header writes ride the committed fast lane (R4.1): the
      // settle-time drain-hold must carry them EXACTLY once into the wrap.
      c.setHeader("X-Late", "drain");
    });
    app.get("/committed", async () => {
      await gate.promise;
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            for (let i = 0; i < 3; i++) {
              await wait(15);
              controller.enqueue(new TextEncoder().encode(`h${i};`));
            }
            controller.close();
          },
        }),
        { headers: { "x-base": "one", "content-type": "text/plain" } },
      );
    });
    const inflight = app.handle(new Request("http://x/committed"));
    expect(app.inFlight).toBe(1);
    const closed = app.close({ drain: 3000 });
    gate.resolve();
    const response = await inflight;
    // Hold keeps the drain open until the stream is consumed.
    await wait(30);
    let resolved = false;
    void closed.then(() => {
      resolved = true;
    });
    expect(resolved).toBe(false);
    expect(response.headers.get("x-late")).toBe("drain");
    expect(response.headers.get("x-base")).toBe("one");
    const text = await response.text();
    expect(text).toBe("h0;h1;h2;");
    await expect(closed).resolves.toEqual({ timedOut: false, inFlight: 0 });
  });
});
