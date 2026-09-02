/**
 * R4.6 coverage completion: the lifecycle branches the matrices graze but
 * never force — timer-fires-after-settle guard, operator escalation with a
 * live server slot, unknown-socket ws dispatch, native body-read teardown,
 * the S4 channel's disconnect-before-materialization replay, and the
 * consumed-Request shape after a native bytes() read.
 */

import { afterAll, describe, expect, it, vi } from "vitest";
import net from "node:net";
import { Keala, startBunServer, type ServeImplementation } from "../src/index.ts";
import { startNodeServer, type NodeServerHandle } from "../src/adapters/node.ts";
import { attachServer } from "../src/core/server-slot.ts";
import { readBodyLimited } from "../src/plugins/body-parser.ts";

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

describe("R4.6 coverage: race + escalation edges", () => {
  it("a deadline timer firing after the settle won dies in the guard (no second answer)", async () => {
    const app = new Keala({ env: "test", requestTimeout: 25 });
    let answers = 0;
    app.get("/race", async (c) => {
      await wait(5); // settles BEFORE the timer
      c.body = "won";
    });
    const settled = app.handle(new Request("http://x/race"));
    const response = await settled;
    answers++;
    expect(await response.text()).toBe("won");
    await wait(60); // the timer fires into the done guard
    expect(answers).toBe(1);
    expect(app.inFlight).toBe(0);
  });

  it("a repeat close({drain:0}) escalates a RUNNING stopGraceful close (force runs)", async () => {
    const stops: Array<boolean | undefined> = [];
    let forced = 0;
    const app = new Keala({ env: "test" });
    // A directly-attached handle: the escalation branch under test lives in
    // closeApp, not in any adapter.
    attachServer(app, {
      stop: (closeActive?: boolean) => {
        stops.push(closeActive);
      },
      stopGraceful: (grace) =>
        new Promise((resolve) => {
          grace.registerForce?.(() => {
            forced++;
            resolve({ timedOut: true });
          });
        }),
    });
    const gate = deferred();
    app.get("/hold", () => gate.promise.then(() => undefined));
    void app.handle(new Request("http://x/hold"));
    const closed = app.close({ drain: 5000 });
    await wait(10);
    const again = app.close({ drain: 0 }); // operator escalation
    await expect(again).resolves.toEqual({ timedOut: true, inFlight: 1 });
    await expect(closed).resolves.toEqual({ timedOut: true, inFlight: 1 });
    expect(forced).toBe(1);
    expect(stops).toEqual([true]); // force-close reached the handle once
    gate.resolve();
  });

  it("ws events from an unknown socket (no route data) dispatch nothing and break nothing", async () => {
    const app = new Keala({ env: "test" });
    let wsConfig: Record<string, (ws: unknown, ...rest: unknown[]) => void> = {};
    const impl: ServeImplementation = (options) => {
      wsConfig = options["websocket"] as typeof wsConfig;
      return {
        port: 0,
        hostname: "localhost",
        stop: () => {},
        fetch: async () => new Response("fake"),
        reload: () => {},
      };
    };
    startBunServer(app, { port: 0 }, undefined, impl);
    const stranger = {}; // no data.wsKey — entryFor returns undefined
    expect(() => {
      wsConfig.open?.(stranger);
      wsConfig.message?.(stranger, "hi");
      wsConfig.drain?.(stranger);
      wsConfig.close?.(stranger, 1000, "bye");
      wsConfig.error?.(stranger, new Error("stranger"));
    }).not.toThrow();
    await wait(5);
  });
});

describe("R4.6 coverage: native transport teardown", () => {
  it("a client disconnect mid body-read rejects the bounded read (contained, slot freed)", async () => {
    const app = new Keala({ env: "test" });
    let settled = false;
    app.post("/read", async (c) => {
      try {
        await readBodyLimited(c, 1024 * 1024);
      } catch {
        // The native read tore down with the socket — contained.
      }
      settled = true;
      return new Response("read-done");
    });
    const server = await startNodeServer(app, { port: 0, hostname: "127.0.0.1" }).ready();
    liveServers.push(server);
    const socket = net.connect(server.port, "127.0.0.1");
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.on("error", () => undefined);
    // Partial body, never finished — the server's read parks, then dies.
    socket.write(
      "POST /read HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\npartial",
    );
    await wait(40);
    socket.destroy();
    await wait(40);
    expect(settled).toBe(true);
    expect(app.inFlight).toBe(0);
  });

  it("the S4 channel replays a disconnect recorded before materialization", async () => {
    const app = new Keala({ env: "test" });
    let signalSeen: AbortSignal | undefined;
    const gate = deferred();
    app.get("/watch", async (c) => {
      gate.resolve(); // release the writer before touching c.signal
      await wait(10);
      signalSeen = c.signal;
    });
    const server = await startNodeServer(app, { port: 0, hostname: "127.0.0.1" }).ready();
    liveServers.push(server);
    const socket = net.connect(server.port, "127.0.0.1");
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.on("error", () => undefined);
    socket.write("GET /watch HTTP/1.1\r\nHost: x\r\n\r\n");
    await gate.promise;
    socket.destroy(); // disconnect lands BEFORE c.signal materializes
    await wait(40);
    expect(signalSeen?.aborted).toBe(true);
    expect((signalSeen?.reason as DOMException)?.name).toBe("AbortError");
  });

  it("a native bytes() read followed by c.raw exposes the consumed-Request shape", async () => {
    const app = new Keala({ env: "test" });
    let rawAfterBytes: Request | undefined;
    app.post("/shape", async (c) => {
      const raw = await readBodyLimited(c, 1024);
      rawAfterBytes = c.raw;
      c.body = new TextDecoder().decode(raw);
    });
    const response = await app.handle(
      new Request("http://x/shape", { method: "POST", body: "payload" }),
    );
    expect(await response.text()).toBe("payload");
    expect(rawAfterBytes?.bodyUsed).toBe(true);
  });

  it("a native bounded read over the limit answers 413 through the funnel", async () => {
    const app = new Keala({ env: "test" });
    app.post("/tiny", async (c) => {
      await readBodyLimited(c, 8);
    });
    const response = await app.handle(
      new Request("http://x/tiny", { method: "POST", body: "way-more-than-eight-bytes" }),
    );
    expect(response.status).toBe(413);
    expect(app.inFlight).toBe(0);
  });

  it("a rejecting strategy falls back loud to the built-in 503", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const app = new Keala({
      env: "test",
      overload: {
        maxConcurrency: 1,
        strategy: {
          onSaturated: () => Promise.reject(new Error("strategy bug")),
        },
      },
    });
    const gate = deferred();
    app.get("/work", async () => {
      await gate.promise;
    });
    const first = app.handle(new Request("http://x/work"));
    const refused = await app.handle(new Request("http://x/work"));
    errorSpy.mockRestore();
    expect(refused.status).toBe(503);
    expect(refused.headers.get("retry-after")).toBe("1");
    gate.resolve();
    await first;
  });

  it("a sync-settling request under a configured deadline races clean (no 504)", async () => {
    const app = new Keala({ env: "test", requestTimeout: 1000 });
    app.get("/sync", (c) => {
      c.body = "sync-ok";
    });
    for (let i = 0; i < 3; i++) {
      const response = await app.handle(new Request("http://x/sync"));
      expect(await response.text()).toBe("sync-ok");
    }
    expect(app.inFlight).toBe(0);
  });

  it("a NATIVE bounded read over the limit answers 413 (early, connection reusable)", async () => {
    const app = new Keala({ env: "test" });
    app.post("/tiny", async (c) => {
      await readBodyLimited(c, 8);
    });
    const server = await startNodeServer(app, { port: 0, hostname: "127.0.0.1" }).ready();
    liveServers.push(server);
    const socket = net.connect(server.port, "127.0.0.1");
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.on("error", () => undefined);
    const big = "x".repeat(64);
    socket.write(
      `POST /tiny HTTP/1.1\r\nHost: x\r\nContent-Length: ${big.length}\r\n\r\n${big}`,
    );
    let buf = "";
    socket.setEncoding("latin1");
    const got = new Promise<string>((resolve) => {
      socket.on("data", (d: string) => {
        buf += d;
        if (buf.includes("\r\n\r\n")) resolve(buf);
      });
      setTimeout(() => resolve(buf), 500);
    });
    const head = await got;
    expect(head.startsWith("HTTP/1.1 413")).toBe(true);
    socket.destroy();
  });

  it("a native multi-chunk bounded read concatenates exactly (wire)", async () => {
    const app = new Keala({ env: "test" });
    app.post("/multi", async (c) => {
      const raw = await readBodyLimited(c, 8192);
      c.body = `len:${raw.byteLength}`;
    });
    const server = await startNodeServer(app, { port: 0, hostname: "127.0.0.1" }).ready();
    liveServers.push(server);
    const response = await fetch(`http://127.0.0.1:${server.port}/multi`, {
      method: "POST",
      body: "a".repeat(4000),
    });
    expect(await response.text()).toBe("len:4000");
  });

  it("a throw inside the overload handler's materialization path still answers 503 (fetch mode)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const app = new Keala({
      env: "test",
      overload: {
        maxConcurrency: 1,
        handler: () => {
          throw new Error("custom bug");
        },
      },
    });
    const gate = deferred();
    app.get("/work", async () => {
      await gate.promise;
    });
    const first = app.handle(new Request("http://x/work"));
    const refused = await app.handle(new Request("http://x/work"));
    errorSpy.mockRestore();
    expect(refused.status).toBe(503);
    expect(refused.headers.get("retry-after")).toBe("1");
    gate.resolve();
    await first;
  });
});
