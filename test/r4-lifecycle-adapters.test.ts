/**
 * R4.6 behavior locks: adapter-level graceful stop + the signal bridge.
 *
 * The Bun adapter is exercised through the injectable serve implementation
 * (the real-runtime equivalents live in scripts/drain-verify.ts): stop
 * ordering, the ws 1001 courtesy close, and onSettled wiring. The signal
 * bridge is exercised through a mocked process.once capture.
 */

import { describe, expect, it, vi } from "vitest";
import { Keala, startBunServer, type ServeImplementation } from "../src/index.ts";
import { closeApp, createLifecycle, installSignalBridge, releaseInFlight } from "../src/core/lifecycle.ts";
import { listen as listenNode, startNodeServer } from "../src/adapters/node.ts";

interface FakeWs {
  close(code?: number, reason?: string): void;
}

/** Bun-shaped serve mock: captures the websocket handlers + stop calls. */
const fakeServe = (): {
  impl: ServeImplementation;
  stopCalls: () => Array<boolean | undefined>;
  wsConfig: () => Record<string, (ws: unknown, ...rest: unknown[]) => void>;
} => {
  const stops: Array<boolean | undefined> = [];
  let wsHandlers: Record<string, (ws: unknown, ...rest: unknown[]) => void> = {};
  const impl: ServeImplementation = (options) => {
    wsHandlers = options["websocket"] as typeof wsHandlers;
    return {
      port: (options["port"] as number) ?? 0,
      hostname: "localhost",
      stop: (closeActive?: boolean) => {
        stops.push(closeActive);
      },
      fetch: async () => new Response("fake"),
      reload: () => {},
    };
  };
  return { impl, stopCalls: () => stops, wsConfig: () => wsHandlers };
};

describe("R4.6 Bun adapter: stopGraceful", () => {
  it("stops accepting at once, closes tracked ws sockets with 1001, and resolves once the app settles", async () => {
    const app = new Keala({ env: "test" });
    const { impl, stopCalls, wsConfig } = fakeServe();
    const handle = startBunServer(app, { port: 0 }, undefined, impl);
    expect(typeof handle.stopGraceful).toBe("function");

    // One live socket tracked through open; a second already closed.
    const close = vi.fn();
    const live: FakeWs = { close };
    const dead: FakeWs = { close: vi.fn() };
    const ws = wsConfig();
    ws.open?.(live);
    ws.open?.(dead);
    ws.close?.(dead, 1000, "bye");
    expect(close).not.toHaveBeenCalled(); // pre-drain: untouched

    let settleApp: (() => void) | undefined;
    const done = handle.stopGraceful!({
      drain: 500,
      onSettled: (callback) => {
        settleApp = callback;
        return false; // not settled yet
      },
    });
    // Accepting stopped immediately (no force flag); the live socket got the
    // courtesy 1001, the closed one is not bothered again.
    expect(stopCalls()).toEqual([undefined]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith(1001, "server shutting down");
    settleApp?.();
    await expect(done).resolves.toEqual({ timedOut: false });
    expect(stopCalls()).toEqual([undefined]); // no force on the clean path
  });

  it("force-closes (stop(true)) when the drain window expires", async () => {
    const app = new Keala({ env: "test" });
    const { impl, stopCalls } = fakeServe();
    const handle = startBunServer(app, { port: 0 }, undefined, impl);
    const done = handle.stopGraceful!({
      drain: 20,
      onSettled: () => false, // never settles
    });
    await expect(done).resolves.toEqual({ timedOut: true });
    expect(stopCalls()).toEqual([undefined, true]);
  });

  it("message/drain/error ws events dispatch through the handlers (and a dead socket's close in stopGraceful is swallowed)", async () => {
    const app = new Keala({ env: "test" });
    const { impl, wsConfig } = fakeServe();
    const seen: string[] = [];
    app.ws("/socket", {
      open: () => {
        seen.push("open");
      },
      message: () => {
        seen.push("message");
      },
      close: () => {
        seen.push("close");
      },
      drain: () => {
        seen.push("drain");
      },
      error: () => {
        seen.push("error");
      },
    });
    // The serve mock captures the websocket config WITHOUT wiring wsRoutes;
    // attach the registrations the adapter reads (startBunServer is what a
    // real listen does — here we exercise the captured handler map directly).
    const handle = startBunServer(app, { port: 0 }, undefined, impl);
    const ws = wsConfig();
    const wsKey = [...app.wsRoutes.keys()][0]!;
    const socket = { data: { wsKey } };
    const hostile: FakeWs = {
      close() {
        throw new Error("already dead");
      },
    };
    ws.open?.(socket);
    ws.message?.(socket, "hello");
    ws.drain?.(socket);
    ws.error?.(socket, new Error("boom"));
    ws.close?.(socket, 1000, "done");
    // Handlers dispatch through the microtask queue — observe after a tick.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(seen.toSorted()).toEqual(["close", "drain", "error", "message", "open"]);
    // A socket that throws on close(1001) must not break the drain.
    ws.open?.(hostile);
    await expect(handle.stopGraceful!({ drain: 50, onSettled: () => true })).resolves.toEqual({
      timedOut: false,
    });
  });

  it("an already-settled app resolves without waiting", async () => {
    const app = new Keala({ env: "test" });
    const { impl } = fakeServe();
    const handle = startBunServer(app, { port: 0 }, undefined, impl);
    await expect(handle.stopGraceful!({ drain: 500, onSettled: () => true })).resolves.toEqual({
      timedOut: false,
    });
  });

  it("app.close() reaches the adapter's stopGraceful through the server slot", async () => {
    const app = new Keala({ env: "test" });
    const { impl } = fakeServe();
    startBunServer(app, { port: 0 }, undefined, impl);
    const status = await app.close({ drain: 200 });
    expect(status).toEqual({ timedOut: false, inFlight: 0 });
  });
});

describe("R4.6 signal bridge (listen signals: true)", () => {
  it("SIGTERM/SIGINT handlers drain via app.close(); a second signal force-closes", async () => {
    const registered: Array<[string, () => void]> = [];
    // The bridge registers PERMANENT listeners (REVIEW-BUG-1 fix).
    const onSpy = vi.spyOn(process, "on").mockImplementation(
      ((event: string | symbol, handler: () => void) => {
        if (typeof event === "string") registered.push([event, handler]);
        return process;
      }) as unknown as typeof process.on,
    );
    try {
      const app = new Keala({ env: "test" });
      installSignalBridge(app);
      expect(registered.map(([event]) => event).toSorted()).toEqual(["SIGINT", "SIGTERM"]);

      const [term] = registered.find(([event]) => event === "SIGTERM") ?? [];
      expect(term).toBeDefined();
      const handler = registered[0]![1];
      handler(); // first signal: drain with the default window
      expect(app.isDraining()).toBe(true);
      handler(); // second signal: force
      await app.close(); // idempotent — returns the already-running close
    } finally {
      onSpy.mockRestore();
    }
  });

  it("the Node listen() options form registers the bridge and the server slot", async () => {
    const registered: string[] = [];
    const onSpy = vi.spyOn(process, "on").mockImplementation((event: string | symbol) => {
      if (typeof event === "string") registered.push(event);
      return process;
    });
    let closedViaSlot = false;
    try {
      const app = new Keala({ env: "test" });
      app.get("/x", (c) => {
        c.body = "x";
      });
      const server = await listenNode(app, {
        port: 0,
        hostname: "127.0.0.1",
        signals: true,
      }).ready();
      expect(registered.toSorted()).toEqual(["SIGINT", "SIGTERM"]);
      // close() flows through the attached handle: wire truth resolves it.
      const closed = app.close({ drain: 2000 });
      closedViaSlot = true;
      await closed;
      server.stop(true);
    } finally {
      onSpy.mockRestore();
    }
    expect(closedViaSlot).toBe(true);
  });

  it("startNodeServer without signals does NOT register handlers", async () => {
    const once = vi.spyOn(process, "once").mockImplementation(() => process);
    const onProbe = vi.spyOn(process, "on").mockImplementation(() => process);
    try {
      const app = new Keala({ env: "test" });
      app.get("/x", (c) => {
        c.body = "x";
      });
      const server = await startNodeServer(app, { port: 0, hostname: "127.0.0.1" }).ready();
      expect(once).not.toHaveBeenCalled();
      // process.on fires for unrelated listeners; the bridge specifically
      // must not arm signal handlers.
      const signalEvents = onProbe.mock.calls
        .map(([event]) => String(event))
        .filter((event) => event === "SIGTERM" || event === "SIGINT");
      expect(signalEvents).toHaveLength(0);
      server.stop(true);
    } finally {
      once.mockRestore();
      onProbe.mockRestore();
    }
  });
});

describe("R4.6 closeApp containment paths", () => {
  it("a rejecting stopGraceful forces close instead of hanging it", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const lc = createLifecycle(undefined);
    lc.inFlight = 2; // stranded work so the force branch reports it
    const handle = {
      stop: () => {},
      stopGraceful: () => Promise.reject(new Error("adapter bug")),
    };
    try {
      const status = await closeApp(lc, handle, { drain: 500 });
      expect(status).toEqual({ timedOut: true, inFlight: 2 });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("drain:0 with a server handle force-stops it immediately", async () => {
    const lc = createLifecycle(undefined);
    lc.inFlight = 1;
    const stops: Array<boolean | undefined> = [];
    const handle = {
      stop: (closeActive?: boolean) => stops.push(closeActive),
    };
    const status = await closeApp(lc, handle, { drain: 0 });
    expect(status).toEqual({ timedOut: true, inFlight: 1 });
    expect(stops).toEqual([true]);
  });

  it("a throwing raw stop() in fallback mode does not break close", async () => {
    const lc = createLifecycle(undefined);
    const handle = {
      stop: () => {
        throw new Error("already dead");
      },
    };
    await expect(closeApp(lc, handle, { drain: 50 })).resolves.toEqual({
      timedOut: false,
      inFlight: 0,
    });
  });

  it("drain: Infinity in fallback mode waits for the counter (no timer)", async () => {
    const lc = createLifecycle(undefined);
    lc.inFlight = 1;
    const closed = closeApp(lc, undefined, { drain: Number.POSITIVE_INFINITY });
    releaseInFlight(lc); // the stranded request settles
    await expect(closed).resolves.toEqual({ timedOut: false, inFlight: 0 });
  });
});
