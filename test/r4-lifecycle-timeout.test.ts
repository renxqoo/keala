/**
 * R4.6 behavior locks: request deadline (`requestTimeout`) and `c.signal`.
 *
 * Contract (docs/HOTPATH-R4-6-LIFECYCLE-DESIGN.md §2.2 deadline rules):
 * - deadline fires before settlement → `c.signal` aborts with a TimeoutError
 *   reason, the capacity slot frees immediately, and a 504 answers THROUGH
 *   THE ERROR FUNNEL (the mapper can restyle it);
 * - fast requests are unaffected (race won by settlement, timer cleared);
 * - the zombie handler's late settlement is contained: no unhandled
 *   rejection, no second response, no double release, no pool recycling
 *   of the zombie's context;
 * - `c.signal` composes the client-disconnect channel (fetch signal ∨ the
 *   native adapter's S4 bridge) with the deadline; lazy — untouched
 *   requests never materialize a controller.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { Keala } from "../src/core/app.ts";
import { startNodeServer } from "../src/adapters/node.ts";
import type { NodeServerHandle } from "../src/adapters/node.ts";
import { streamText } from "../src/helpers/streams.ts";

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

describe("R4.6 deadline: 504 through the funnel", () => {
  it("a stuck handler answers 504 with the deadline message", async () => {
    const app = new Keala({ env: "test", requestTimeout: 40 });
    const gate = deferred();
    app.get("/stuck", () => gate.promise.then(() => undefined));

    const response = await app.handle(new Request("http://x/stuck"));
    expect(response.status).toBe(504);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe("request deadline exceeded");
    // Capacity freed at 504 time — the zombie does not hold a slot.
    expect(app.inFlight).toBe(0);
    gate.resolve();
    await wait(5); // zombie settles; containment, no double release
    expect(app.inFlight).toBe(0);
  });

  it("the error mapper can restyle the 504 (single customization point)", async () => {
    const app = new Keala({ env: "test", requestTimeout: 40 });
    app.onError((error) => {
      expect(error.status).toBe(504);
      return Response.json({ error: "deadline", message: error.message }, { status: 504 });
    });
    const gate = deferred();
    app.get("/stuck", () => gate.promise.then(() => undefined));
    const response = await app.handle(new Request("http://x/stuck"));
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({
      error: "deadline",
      message: "request deadline exceeded",
    });
    gate.resolve();
  });

  it("fast requests win the race (no 504, no leaked timer)", async () => {
    const app = new Keala({ env: "test", requestTimeout: 2000 });
    app.get("/fast", (c) => {
      c.body = "fast-ok";
    });
    const response = await app.handle(new Request("http://x/fast"));
    expect(await response.text()).toBe("fast-ok");
    expect(app.inFlight).toBe(0);
  });

  it("a deadline won against a streaming body still answers 504 (the body never streams)", async () => {
    const app = new Keala({ env: "test", requestTimeout: 40 });
    const gate = deferred();
    app.get("/stuck", async (c) => {
      await gate.promise;
      return streamText(c, async (w) => {
        w.write("never");
      });
    });
    const response = await app.handle(new Request("http://x/stuck"));
    expect(response.status).toBe(504);
    gate.resolve();
    await wait(5);
  });

  it("pooling apps: the 504 path never recycles the zombie's context, and later requests are clean", async () => {
    const app = new Keala({ env: "test", pooling: true, requestTimeout: 40 });
    const gate = deferred();
    app.get("/stuck", () => gate.promise.then(() => undefined));
    app.get("/ok", (c) => {
      c.body = "still-ok";
    });
    const dead = await app.handle(new Request("http://x/stuck"));
    expect(dead.status).toBe(504);
    const next = await app.handle(new Request("http://x/ok"));
    expect(await next.text()).toBe("still-ok");
    gate.resolve();
    await wait(5);
    const after = await app.handle(new Request("http://x/ok"));
    expect(await after.text()).toBe("still-ok");
  });

  it("the zombie's late settlement never becomes an unhandled rejection", async () => {
    const onUnhandled = vi.fn();
    (process.on as unknown as (event: string, fn: (reason: unknown) => void) => void)(
      "unhandledRejection",
      onUnhandled,
    );
    const app = new Keala({ env: "test", requestTimeout: 30 });
    const gate = deferred();
    app.get("/zombie", () => gate.promise.then(() => undefined));
    const response = await app.handle(new Request("http://x/zombie"));
    expect(response.status).toBe(504);
    gate.resolve();
    await wait(30);
    (process.off as unknown as (event: string, fn: (reason: unknown) => void) => void)(
      "unhandledRejection",
      onUnhandled,
    );
    expect(onUnhandled).not.toHaveBeenCalled();
  });

  it("requestTimeout validation is loud at setup", () => {
    expect(() => new Keala({ requestTimeout: -1 })).toThrow(TypeError);
    expect(() => new Keala({ requestTimeout: Number.POSITIVE_INFINITY })).toThrow(TypeError);
    expect(() => new Keala({ requestTimeout: Number.NaN })).toThrow(TypeError);
    expect(() => new Keala({ requestTimeout: 0 })).not.toThrow(); // 0 = off
  });

  it("a deadline zombie settling DURING drain releases nothing twice", async () => {
    const app = new Keala({ env: "test", requestTimeout: 40 });
    const gate = deferred();
    app.get("/stuck", () =>
      gate.promise.then(() => new Response("late-body", { headers: { "content-type": "text/plain" } })),
    );
    const inflight = app.handle(new Request("http://x/stuck"));
    const closed = app.close({ drain: 3000 });
    const response = await inflight;
    expect(response.status).toBe(504);
    expect(app.inFlight).toBe(0); // freed by the deadline, not held by drain
    gate.resolve(); // zombie settles with a bodied response mid-drain
    await wait(10);
    await expect(closed).resolves.toEqual({ timedOut: false, inFlight: 0 });
  });
});

describe("R4.6 c.signal: cooperative cancellation", () => {
  it("aborts with a TimeoutError reason when the deadline fires", async () => {
    const app = new Keala({ env: "test", requestTimeout: 40 });
    const gate = deferred();
    let observed: AbortSignal | undefined;
    app.get("/watch", async (c) => {
      observed = c.signal;
      await gate.promise;
    });
    const response = await app.handle(new Request("http://x/watch"));
    expect(response.status).toBe(504);
    expect(observed?.aborted).toBe(true);
    const reason = observed?.reason as DOMException;
    expect(reason?.name).toBe("TimeoutError");
    gate.resolve();
  });

  it("composes the raw request signal: client disconnect aborts c.signal", async () => {
    const app = new Keala({ env: "test" });
    const abort = new AbortController();
    const gate = deferred();
    let observed: AbortSignal | undefined;
    app.get("/watch", async (c) => {
      observed = c.signal;
      await gate.promise;
      c.body = "done";
    });
    const inflight = app.handle(new Request("http://x/watch", { signal: abort.signal }));
    await wait(5);
    expect(observed?.aborted).toBe(false);
    abort.abort(new Error("client went away"));
    await wait(5);
    expect(observed?.aborted).toBe(true);
    gate.resolve();
    expect(await (await inflight).text()).toBe("done");
  });

  it("reading c.signal AFTER the deadline still yields an aborted signal", async () => {
    const app = new Keala({ env: "test", requestTimeout: 30 });
    const gate = deferred();
    let sawAborted = false;
    app.get("/late-read", async (c) => {
      await gate.promise;
      sawAborted = c.signal.aborted; // materializes after the deadline fired
    });
    const response = await app.handle(new Request("http://x/late-read"));
    expect(response.status).toBe(504);
    gate.resolve();
    await wait(5);
    expect(sawAborted).toBe(true);
  });

  it("untouched requests pay nothing: signal stays lazy (no controller until read)", async () => {
    const app = new Keala({ env: "test" });
    let read = false;
    app.get("/lazy", (c) => {
      read = (c as unknown as { abortValue?: AbortController }).abortValue !== undefined;
      c.body = "ok";
    });
    await app.handle(new Request("http://x/lazy"));
    expect(read).toBe(false);
  });

  it("under the Node adapter the bridged signal aborts on real client disconnect (S4)", async () => {
    const app = new Keala({ env: "test", requestTimeout: 5000 });
    let signalSeen: AbortSignal | undefined;
    const gate = deferred();
    app.get("/watch", async (c) => {
      signalSeen = c.signal;
      await gate.promise;
      c.body = "done";
    });
    const server = await startNodeServer(app, { port: 0, hostname: "127.0.0.1" }).ready();
    liveServers.push(server);
    const net = await import("node:net");
    const socket = net.connect({ host: "127.0.0.1", port: server.port });
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.on("error", () => undefined);
    socket.end("GET /watch HTTP/1.1\r\nHost: x\r\n\r\n");
    await wait(50); // handler parked, holding the (now dead) connection
    expect(signalSeen?.aborted).toBe(true);
    const reason = signalSeen?.reason as DOMException;
    expect(reason?.name).toBe("AbortError");
    gate.resolve();
    socket.destroy();
  });
});

describe("R4.6 raceDeadline containment (unit)", () => {
  it("contains a rejecting settle and a late zombie", async () => {
    const { Keala: KealaApp } = await import("../src/core/app.ts");
    const { createLifecycle } = await import("../src/core/lifecycle.ts");
    const { raceDeadline } = await import("../src/core/lifecycle-deadline.ts");
    const { baseContextProto, createBoundContext } = await import(
      "../src/core/context/context.ts"
    );
    const app = new KealaApp({ env: "test" });
    const lc = createLifecycle(undefined);
    lc.inFlight = 1;
    const freshContext = () => createBoundContext(baseContextProto, new Request("http://x/"), undefined);
    const rejecting = Promise.reject(new Error("impossible by contract"));
    const settled = await raceDeadline(app, lc, freshContext(), rejecting, 30);
    expect(settled.status).toBe(504); // the deadline wins; the rejection is contained
    // Zombie path: the settle resolves AFTER the deadline — swallowed quietly.
    const late = new Promise<Response>(() => {}); // never settles on its own
    lc.inFlight = 1; // the second race owns its own slot
    void raceDeadline(app, lc, freshContext(), late, 10);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(lc.inFlight).toBe(0);
  });
});
