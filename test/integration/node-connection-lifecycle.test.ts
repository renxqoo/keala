import { afterEach, describe, expect, it } from "vitest";
import { once } from "node:events";
import { connect, type Socket } from "node:net";
import { Agent, request, IncomingMessage, type ServerResponse, type Server } from "node:http";
import { Keala } from "../../src/core/app.ts";
import { startNodeServer, type NodeServerHandle } from "../../src/adapters/node.ts";
import type { NodeRequestSource } from "../../src/adapters/node-source.ts";
import type { Context } from "../../src/core/context/context.ts";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const servers: NodeServerHandle[] = [];
const sockets: Socket[] = [];
const agents: Agent[] = [];
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const agent of agents.splice(0)) agent.destroy();
  for (const server of servers.splice(0)) server.stop(true);
});
const start = async (app: Keala) => {
  const server = await startNodeServer(app, { port: 0, hostname: "127.0.0.1" }).ready();
  servers.push(server);
  return server;
};

describe("Node connection completion and lazy cancellation", () => {
  it
    .skipIf(process.versions.bun !== undefined)
    .each(["inherited", "own", "fixed", "fixed accessor", "sealed"])(
    "emits one native close and restores closeIdleConnections (own method: %s)",
    async (ownMethod) => {
      const app = new Keala({ env: "test" });
      let native!: Server;
      let descriptor: PropertyDescriptor | undefined;
      let closeEvents = 0;
      app.get("/", (c) => {
        native = (
          (c.rawRequest as NodeRequestSource).incoming.socket as Socket & { server: Server }
        ).server;
        if (ownMethod === "own" || ownMethod === "fixed") {
          Object.defineProperty(native, "closeIdleConnections", {
            value: native.closeIdleConnections.bind(native),
            writable: ownMethod === "own",
            configurable: ownMethod === "own",
          });
        } else if (ownMethod === "fixed accessor") {
          const idle = native.closeIdleConnections.bind(native);
          Object.defineProperty(native, "closeIdleConnections", { get: () => idle });
        }
        descriptor = Object.getOwnPropertyDescriptor(native, "closeIdleConnections");
        native.on("close", () => closeEvents++);
        if (ownMethod === "sealed") Object.preventExtensions(native);
        return c.text("done");
      });
      const server = await start(app);
      expect(await (await fetch(`http://127.0.0.1:${server.port}/`)).text()).toBe("done");
      await expect(app.close({ drain: 500 })).resolves.toMatchObject({ timedOut: false });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closeEvents).toBe(1);
      expect(Object.getOwnPropertyDescriptor(native, "closeIdleConnections")).toEqual(descriptor);
    },
  );

  it("replays a disconnect first observed after the client has gone", async () => {
    const app = new Keala({ env: "test" });
    const entered = deferred(),
      release = deferred(),
      seen = deferred();
    let peerGone!: Promise<unknown>;
    let aborted = false;
    app.get("/", async (c) => {
      peerGone = once((c.rawRequest as NodeRequestSource).incoming.socket, "close");
      entered.resolve();
      await release.promise;
      aborted = c.signal.aborted && c.signal.reason.name === "AbortError";
      seen.resolve();
      return c.text("late");
    });
    const server = await start(app);
    const socket = connect(server.port, "127.0.0.1");
    sockets.push(socket);
    await once(socket, "connect");
    socket.write("GET / HTTP/1.1\r\nHost: test\r\n\r\n");
    await entered.promise;
    socket.destroy();
    await peerGone;
    release.resolve();
    await seen.promise;
    expect(aborted).toBe(true);
    await expect(app.close({ drain: 500 })).resolves.toMatchObject({
      timedOut: false,
      inFlight: 0,
    });
  });

  it("does not abort a successful response when its signal is first read after keep-alive closes", async () => {
    const app = new Keala({ env: "test" });
    let context!: Context;
    let peerGone!: Promise<unknown>;
    app.get("/", (c) => {
      context = c;
      peerGone = once((c.rawRequest as NodeRequestSource).incoming.socket, "close");
      return c.text("done");
    });
    const server = await start(app);
    const agent = new Agent({ keepAlive: true });
    agents.push(agent);
    await new Promise<void>((resolve, reject) => {
      request({ host: "127.0.0.1", port: server.port, agent }, (res) => {
        res.resume();
        res.once("end", resolve);
        res.once("error", reject);
      })
        .on("error", reject)
        .end();
    });
    agent.destroy();
    await peerGone;
    expect(context.signal.aborted).toBe(false);
    await expect(app.close({ drain: 500 })).resolves.toMatchObject({ timedOut: false });
  });

  it(
    "waits for backpressured FIFO output after both handlers have settled",
    { timeout: 10_000 },
    async () => {
      const app = new Keala({ env: "test" });
      const entered = deferred();
      const body = "x".repeat(8 * 1024 * 1024);
      let response!: ServerResponse;
      app.get("/large", (c) => c.text(body));
      app.get("/last", (c) => {
        response = (c.rawRequest as NodeRequestSource)._response!;
        entered.resolve();
        return c.text("LAST");
      });
      const server = await start(app);
      const socket = connect(server.port, "127.0.0.1");
      sockets.push(socket);
      await once(socket, "connect");
      socket.pause();
      socket.write(
        "GET /large HTTP/1.1\r\nHost: test\r\n\r\nGET /last HTTP/1.1\r\nHost: test\r\n\r\n",
      );
      await entered.promise;
      expect(app.inFlight).toBe(0);
      expect(response.writableFinished).toBe(false);
      let closed = false;
      const closing = app.close({ drain: 5000 }).then((result) => {
        closed = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(closed).toBe(false);
      const chunks: Buffer[] = [];
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      const ended = once(socket, "end");
      socket.resume();
      await ended;
      await expect(closing).resolves.toMatchObject({ timedOut: false });
      const wire = Buffer.concat(chunks).toString();
      expect(wire.match(/HTTP\/1\.1 200/g)).toHaveLength(2);
      expect(wire).toContain(body);
      expect(wire.endsWith("LAST")).toBe(true);
    },
  );

  it("cancels the signal and producer before shutdown hooks after a force stop", async () => {
    const app = new Keala({ env: "test" });
    let signal!: AbortSignal;
    let cancelled = false;
    let observed = false;
    app.get("/", (c) => {
      signal = c.signal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([65]));
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    });
    app.onShutdown(() => {
      observed = signal.aborted && cancelled;
    });
    const server = await start(app);
    const socket = connect(server.port, "127.0.0.1");
    sockets.push(socket);
    socket.on("error", () => undefined);
    await once(socket, "connect");
    socket.write("GET / HTTP/1.1\r\nHost: test\r\n\r\n");
    await once(socket, "data");
    expect(app.inFlight).toBe(0);
    server.stop(true);
    await expect(app.close({ drain: 1000 })).resolves.toMatchObject({ timedOut: false });
    expect(observed).toBe(true);
  });

  it("lets an admitted slow upload finish inside drain after transport request timeout would expire", async () => {
    const app = new Keala({ env: "test" });
    const entered = deferred();
    app.post("/", async (c) => {
      entered.resolve();
      return c.text(await c.raw.text());
    });
    const server = await startNodeServer(app, {
      port: 0,
      hostname: "127.0.0.1",
      http: { requestTimeout: 100, headersTimeout: 100, connectionsCheckingInterval: 10 },
    }).ready();
    servers.push(server);
    const socket = connect(server.port, "127.0.0.1");
    sockets.push(socket);
    socket.on("error", () => undefined);
    await once(socket, "connect");
    let wire = "";
    socket.on("data", (chunk: Buffer) => {
      wire += chunk.toString();
    });
    const ended = once(socket, "end");
    socket.write("POST / HTTP/1.1\r\nHost: test\r\nContent-Length: 2\r\n\r\nx");
    await entered.promise;
    await new Promise((done) => setTimeout(done, 30));
    const closing = app.close({ drain: 1000 });
    await new Promise((done) => setTimeout(done, 180));
    socket.write("y");
    await ended;
    await expect(closing).resolves.toMatchObject({ timedOut: false });
    expect(wire).toContain("HTTP/1.1 200");
    expect(wire).toContain("xy");
  });

  it(
    "does not mistake an unassigned pipeline response failure for its predecessor finishing",
    { timeout: 5000 },
    async () => {
      const app = new Keala({ env: "test" });
      const finishFirst = deferred(),
        failSecond = deferred(),
        secondEntered = deferred();
      let second!: ServerResponse;
      app.get(
        "/first",
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array([65]));
              },
              async pull(controller) {
                await finishFirst.promise;
                controller.close();
              },
            }),
          ),
      );
      app.get("/second", (c) => {
        second = (c.rawRequest as NodeRequestSource)._response!;
        secondEntered.resolve();
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([66]));
            },
            async pull(controller) {
              await failSecond.promise;
              controller.error(new Error("body failed"));
            },
          }),
        );
      });
      const server = await start(app);
      const socket = connect(server.port, "127.0.0.1");
      sockets.push(socket);
      socket.on("error", () => undefined);
      socket.on("data", () => undefined);
      await once(socket, "connect");
      const disconnected = once(socket, "close");
      socket.write(
        "GET /first HTTP/1.1\r\nHost: test\r\n\r\nGET /second HTTP/1.1\r\nHost: test\r\n\r\n",
      );
      await secondEntered.promise;
      for (let i = 0; i < 50 && !second.headersSent; i++)
        await new Promise((done) => setTimeout(done, 1));
      expect(second.headersSent).toBe(true);
      expect(second.socket).toBeNull();
      const failed = once(second, "close");
      failSecond.resolve();
      // Node 26 closes an unassigned OutgoingMessage immediately; Node 20
      // defers its close until assignment. Both must preserve the predecessor.
      const closedEarly = await Promise.race([
        failed.then(() => true),
        new Promise<boolean>((done) => setTimeout(() => done(false), 20)),
      ]);
      expect(second.destroyed).toBe(true);
      if (Number(process.versions.node.split(".")[0]) >= 26) expect(closedEarly).toBe(true);
      expect(app.inFlight).toBe(0);
      let closed = false;
      const closing = app.close({ drain: 1000 }).then((value) => {
        closed = true;
        return value;
      });
      await new Promise((done) => setTimeout(done, 20));
      expect(closed).toBe(false);
      finishFirst.resolve();
      await expect(closing).resolves.toMatchObject({ timedOut: false });
      await failed;
      await disconnected;
    },
  );

  // This native Node branch uses IncomingMessage construction to observe the
  // post-stop request. Bun's node:http shim does not implement that hook.
  it.skipIf(typeof Bun !== "undefined")(
    "wakes when a queued request arrives after draining began with only a bound response",
    { timeout: 10_000 },
    async () => {
      const app = new Keala({ env: "test" });
      const entered = deferred(),
        queued = deferred();
      let requests = 0;
      class CountedRequest extends IncomingMessage {
        constructor(socket: Socket) {
          super(socket);
          if (++requests === 2) queued.resolve();
        }
      }
      app.get("/", (c) => {
        entered.resolve();
        return c.text("x".repeat(8 * 1024 * 1024));
      });
      const server = await startNodeServer(app, {
        port: 0,
        hostname: "127.0.0.1",
        http: { IncomingMessage: CountedRequest },
      }).ready();
      servers.push(server);
      const socket = connect(server.port, "127.0.0.1");
      sockets.push(socket);
      socket.on("error", () => undefined);
      await once(socket, "connect");
      socket.pause();
      socket.write("GET / HTTP/1.1\r\nHost: test\r\n\r\n");
      await entered.promise;
      const closing = app.close({ drain: 3000 });
      socket.write("GET /late HTTP/1.1\r\nHost: test\r\n\r\n");
      await queued.promise;
      let bytes = 0;
      socket.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
      });
      const ended = once(socket, "end");
      socket.resume();
      await ended;
      await expect(closing).resolves.toMatchObject({ timedOut: false });
      expect(bytes).toBeGreaterThan(8 * 1024 * 1024);
    },
  );
});
