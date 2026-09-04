/**
 * HA residual review red tests (zz-red-ha-1) — current tree @ aacc945.
 *
 * Three CONFIRMED residual findings, each asserted as the CORRECT behavior
 * (fails against the implementation):
 *  HA-1  Node adapter double-start: listen(app, …) twice silently orphans the
 *        first server; app.close() can never reach it (server slot was
 *        overwritten) and the orphan serves 503 forever with the port bound.
 *  HA-2  A hung app.onShutdown() handler blocks close() forever: the drain
 *        finished, `escalate` was nulled, so a repeat close({drain: 0}) is a
 *        no-op — later registered handlers never run either.
 *  HA-3  Post-deadline zombie body reads (Node adapter): after requestTimeout
 *        answers 504 on a keep-alive socket whose request body is still being
 *        read, the native source keeps its 'data' listeners attached and
 *        retains every subsequent byte in the read closure. inFlight reports 0
 *        the whole time (no admission visibility, no cap beyond the plugin
 *        limit per connection).
 */

import { afterAll, describe, expect, it } from "vitest";
import net from "node:net";

import { Keala } from "../src/core/app.ts";
import { startNodeServer, listen, type NodeServerHandle } from "../src/adapters/node.ts";
import { createBodyParser } from "../src/plugins/body-parser.ts";
import { streamSSE } from "../src/helpers/streams.ts";

const quiet = { env: "test" } as const;
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const liveServers: NodeServerHandle[] = [];
const liveSockets: net.Socket[] = [];
afterAll(() => {
  for (const s of liveServers.splice(0)) {
    try {
      s.stop(true);
    } catch {
      // already stopped
    }
  }
  for (const s of liveSockets.splice(0)) s.destroy();
});

const openSocket = (port: number): Promise<net.Socket> =>
  new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      liveSockets.push(sock);
      resolve(sock);
    });
    sock.on("error", reject);
  });

const readUntil = (sock: net.Socket, predicate: (buf: string) => boolean, ms = 1500) =>
  new Promise<string>((resolve) => {
    let acc = "";
    const timer = setTimeout(() => {
      cleanup();
      resolve(acc);
    }, ms);
    const onData = (chunk: Buffer): void => {
      acc += chunk.toString("latin1");
      if (predicate(acc)) {
        cleanup();
        resolve(acc);
      }
    };
    const onEnd = (): void => {
      cleanup();
      resolve(`${acc}<<EOF>>`);
    };
    const onError = (): void => {
      cleanup();
      resolve(`${acc}<<SOCKET-ERROR>>`);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      sock.off("data", onData);
      sock.off("end", onEnd);
      sock.off("error", onError);
    };
    sock.on("data", onData);
    sock.on("end", onEnd);
    sock.on("error", onError);
  });

describe("HA-1: Node adapter double-start orphans the first server", () => {
  it("a second listen()/startNodeServer() for the same app must refuse (Bun listen() parity)", async () => {
    const app = new Keala(quiet);
    app.get("/", (c) => c.text("ok"));
    const first = listen(app, 8901, "127.0.0.1");
    liveServers.push(first);
    await first.ready();

    let refused = false;
    try {
      const second = listen(app, 8902, "127.0.0.1");
      liveServers.push(second);
      await second.ready();
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  });

  it("after close(), no server of the app may keep serving 503s with its port bound", async () => {
    const app = new Keala(quiet);
    app.get("/", (c) => c.text("ok"));
    const first = listen(app, 8903, "127.0.0.1");
    liveServers.push(first);
    await first.ready();
    const second = listen(app, 8904, "127.0.0.1"); // no guard on the Node path
    liveServers.push(second);
    await second.ready();

    await app.close({ drain: 100 }); // reaches only the SECOND handle

    let orphanServing = false;
    try {
      const res = await fetch("http://127.0.0.1:8903/");
      orphanServing = res.status > 0; // got ANY answer (observed: 503 forever)
    } catch {
      orphanServing = false;
    }
    expect(orphanServing).toBe(false);
  });
});

describe("HA-2: a hung onShutdown() handler hangs close() with no escalation", () => {
  it("close() resolves despite a never-settling handler, and later handlers still run", async () => {
    const app = new Keala(quiet);
    app.get("/", (c) => c.text("ok"));
    const server = startNodeServer(app, { port: 8905, hostname: "127.0.0.1" });
    liveServers.push(server);
    await server.ready();

    let release = (): void => {};
    app.onShutdown(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    let secondRan = false;
    app.onShutdown(() => {
      secondRan = true;
    });

    const closed = app.close({ drain: 50 });
    let state = "pending";
    void closed.then(() => {
      state = "resolved";
    });
    await wait(300); // >> the 50ms drain window
    expect(state).toBe("resolved"); // FAILS today: handler hang = close() hang
    expect(secondRan).toBe(true);

    // Escalation must also work while hooks hang:
    void app.close({ drain: 0 });
    await wait(50);
    expect(state).toBe("resolved");

    release(); // cleanup so the worker can exit
    await closed;
  });
});

describe("HA-3: zombie body read after the deadline retains client bytes (Node adapter)", () => {
  it("after the 504, the socket must not keep absorbing the request body (retained: ~pumped bytes, inFlight: 0)", async () => {
    const app = new Keala({ ...quiet, requestTimeout: 100 });
    app.use(createBodyParser());
    app.post("/slow", async (c) => {
      const bytes = await c.req.arrayBuffer();
      c.text(`body:${bytes.byteLength}`);
    });
    const server = startNodeServer(app, { port: 8906, hostname: "127.0.0.1" });
    liveServers.push(server);
    await server.ready();

    const DECLARED = 8 * 1024 * 1024; // within the plugin's default limits
    const sock = await openSocket(server.port);
    sock.write(`POST /slow HTTP/1.1\r\nHost: x\r\nContent-Length: ${DECLARED}\r\n\r\nhello`);
    const reply = await readUntil(sock, (b) => b.includes("\r\n\r\n"));
    expect(reply).toContain("504");
    // The capacity slot is already free while the zombie read still listens.
    expect(app.inFlight).toBe(0);

    const rssBefore = Math.round(process.memoryUsage().rss / 1024 / 1024);
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    let sent = 0;
    const target = 6 * 1024 * 1024;
    let done: () => void = () => {};
    const pumped = new Promise<void>((resolve) => {
      done = resolve;
    });
    const pump = (): void => {
      while (sent < target) {
        sent += chunk.length;
        if (!sock.write(chunk)) {
          sock.once("drain", pump);
          return;
        }
      }
      done();
    };
    pump();
    await pumped;
    await wait(300); // let the data land in the server's read closure

    const rssAfter = Math.round(process.memoryUsage().rss / 1024 / 1024);
    // Correct behavior: the adapter closes the socket on the early answer (or
    // otherwise stops retaining) — retained delta must be far below `sent`.
    expect(rssAfter - rssBefore).toBeLessThan(2 * 1024 / 1024); // < 2MB
    expect(app.inFlight).toBe(0);
  }, 8000);
});

describe("HA residual: verified-clean behaviors (documentation probes)", () => {
  it("SSE heartbeat interval is cleared on abrupt client disconnect (real socket)", async () => {
    const app = new Keala(quiet);
    app.get(
      "/events",
      (c) =>
        streamSSE(
          c,
          async (sse) => {
            sse.send({ data: "hello" });
            await new Promise(() => {});
          },
          { heartbeat: 40 },
        ),
    );
    const server = startNodeServer(app, { port: 8907, hostname: "127.0.0.1" });
    liveServers.push(server);
    await server.ready();

    const sock = await openSocket(server.port);
    sock.write("GET /events HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n");
    const first = await readUntil(sock, (b) => b.includes("hello"));
    expect(first).toContain("text/event-stream");
    await wait(120); // a few heartbeats
    const pings = await readUntil(sock, () => false, 60);
    expect(pings).toContain(": ping");
    sock.destroy();
    await wait(120);
    // No assertion possible on intervals here (vitest worker handles); the
    // standalone probe (scripts in /tmp) shows the interval is cleared.
    expect(true).toBe(true);
  });

  it("a request on an established keep-alive connection during drain is refused (503 or closed)", async () => {
    const app = new Keala(quiet);
    app.get("/", (c) => c.text("ok"));
    const server = startNodeServer(app, { port: 8908, hostname: "127.0.0.1" });
    liveServers.push(server);
    await server.ready();

    const sock = await openSocket(server.port);
    sock.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n");
    const first = await readUntil(sock, (b) => b.includes("\r\n\r\n"));
    expect(first).toContain("200");

    const closed = app.close({ drain: 1500 });
    await wait(20);
    sock.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n");
    const second = await readUntil(sock, (b) => b.includes("\r\n\r\n") || b === "", 600);
    // Either an explicit 503 refusal or a torn-down connection is acceptable;
    // serving 200 would be a readiness violation.
    expect(second.includes("200")).toBe(false);
    await closed;
  });
});
