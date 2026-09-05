/**
 * Agent security review — R4.4 pre-context admission machinery
 * (branch codex/hotpath-r4-4-lifecycle).
 * Contract: docs/HOTPATH-R4-4-MIGRATION-LIFECYCLE.md §2.2 (drain), §2.3
 * (overload / pre-context rejection), §2.5 (invariants). Every test states
 * an ATTACK and the expectation that must hold. FINDING-marked tests were
 * RED at review time and ship as `it.fails` (desired contract expressed,
 * suite stays green).
 */

import { afterAll, describe, expect, it } from "vitest";
import { connect, type Socket } from "node:net";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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

/** Count unhandledRejections while armed (zombie/containment checks). */
const unhandledTracker = (): { count: () => number; stop: () => void } => {
  let n = 0;
  const onUnhandled = (): void => {
    n += 1;
  };
  // Cast pattern from agent-r6-prop-invariants-2.test.ts (bun-types narrows
  // the process event map); bound so `this` survives.
  const on = process.on.bind(process) as unknown as (event: string, fn: () => void) => void;
  const off = process.off.bind(process) as unknown as (event: string, fn: () => void) => void;
  on("unhandledRejection", onUnhandled);
  return { count: () => n, stop: () => off("unhandledRejection", onUnhandled) };
};

/** Wire-level exchange: connect, script writes at chosen moments, collect. */
const wireExchange = async (
  port: number,
  script: (write: (chunk: string) => void) => Promise<void>,
  quietMs = 250,
): Promise<string> => {
  const sock: Socket = connect(port, "127.0.0.1");
  let buf = "";
  await new Promise<void>((resolve, reject) => {
    sock.once("connect", resolve);
    sock.once("error", reject);
  });
  sock.setEncoding("latin1");
  sock.on("data", (d: string) => {
    buf += d;
  });
  await script((chunk: string) => sock.write(chunk));
  await wait(quietMs);
  sock.destroy();
  return buf;
};

const srcFilesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? srcFilesUnder(join(dir, entry.name)) : [join(dir, entry.name)],
  );

const liveServers: NodeServerHandle[] = [];
afterAll(() => {
  for (const server of liveServers) server.stop(true);
});

describe("SEC-6: Node wire — drain Connection: close injection vs handler-set headers", () => {
  // ATTACK: a handler (or a value injected through a committed Response) sets
  // its own Connection header hoping to keep a socket alive through a drain
  // or to smuggle extra header bytes. EXPECTATION: during drain the runtime
  // owns hop-by-hop framing — exactly one Connection header, saying close;
  // framing stays consistent.
  it.skipIf(typeof Bun !== "undefined")(
    "SEC-6a: a handler-set Connection header never reaches the drain wire",
    { timeout: 15_000 },
    async () => {
      const marker = `H-${Math.random().toString(36).slice(2)}`;
      const app = new Keala({ env: "test" });
      const gate = deferred();
      app.get("/slow", async () => {
        await gate.promise;
        return new Response("SLOWBODY", {
          headers: { Connection: "keep-alive", "x-probe": marker },
        });
      });
      const handle = startNodeServer(app, { port: 0 });
      liveServers.push(handle);
      const server = await handle.ready();
      const wire = await wireExchange(
        server.port,
        async (write) => {
          write("GET /slow HTTP/1.1\r\nHost: x\r\n\r\n"); // admitted, parked
          await wait(40);
          void app.close({ drain: 2000 }); // drain starts while in flight
          gate.resolve(); // settles DURING drain → close injected
        },
        300,
      );
      const connectionHeaders = wire.match(/connection:[^\r\n]*/gi) ?? [];
      expect(connectionHeaders.map((h) => h.toLowerCase())).toEqual(["connection: close"]);
      expect(wire.toLowerCase()).not.toContain("keep-alive");
      expect(wire).toContain(`x-probe: ${marker}`);
      // Framing: chunked body is exactly SLOWBODY, stream terminates right
      // after (no smuggled bytes).
      expect(wire.endsWith("8\r\nSLOWBODY\r\n0\r\n\r\n")).toBe(true);
      // Drain + pipelining (node semantics, locked so a change surfaces): a
      // probe pipelined behind the in-flight request never receives its gate
      // 503 — node destroys the socket after the close-marked response. The
      // wire must hold exactly ONE complete response (no half-written
      // fragments a parser could misattribute).
      expect(wire.match(/HTTP\/1\.1/g)?.length).toBe(1);
    },
  );

  // ATTACK: wire-level confusion around the built-in gate rejection (framing
  // lies would desync any keep-alive client or proxy). Asserted on the
  // overload path where the keep-alive wire stays observable. EXPECTATION:
  // exact fixed status line, fixed headers, cleanly terminated body.
  it.skipIf(typeof Bun !== "undefined")(
    "SEC-6b: the built-in gate rejection on the wire is byte-exact and cleanly framed",
    { timeout: 15_000 },
    async () => {
      const app = new Keala({ env: "test", overload: { maxConcurrency: 1 } });
      const gate = deferred();
      app.get("/slow", async (c) => {
        await gate.promise;
        c.body = "done";
      });
      const handle = startNodeServer(app, { port: 0 });
      liveServers.push(handle);
      const server = await handle.ready();
      // Hold the only capacity slot in-process so the wire request is refused.
      const holder = app.handle(new Request("http://x/slow"));
      try {
        const wire = await wireExchange(
          server.port,
          async (write) => {
            write("GET /anything?evil=1 HTTP/1.1\r\nHost: x\r\n\r\n");
          },
          300,
        );
        expect(wire.startsWith("HTTP/1.1 503 Service Unavailable\r\n")).toBe(true);
        expect(wire).toContain("content-type: text/plain; charset=utf-8");
        expect(wire).toContain("retry-after: 1");
        expect(wire).not.toContain("evil");
        // 19-byte body (0x13) chunked; nothing after the terminating 0-chunk.
        expect(wire.endsWith("13\r\nService Unavailable\r\n0\r\n\r\n")).toBe(true);
        expect(wire.match(/HTTP\/1\.1/g)?.length).toBe(1);
      } finally {
        gate.resolve();
        await holder;
      }
    },
  );

  // ATTACK: malformed HTTP through the raw clientError path — its hand-rolled
  // reply must still order the connection closed. EXPECTATION: 400 + close.
  it.skipIf(typeof Bun !== "undefined")(
    "SEC-6c: the malformed-request 400 bridge reply orders the connection closed",
    { timeout: 15_000 },
    async () => {
      const app = new Keala({ env: "test" });
      app.get("/x", (c) => {
        c.body = "ok";
      });
      const handle = startNodeServer(app, { port: 0 });
      liveServers.push(handle);
      const server = await handle.ready();
      const wire = await wireExchange(
        server.port,
        async (write) => {
          write("\x00\x01\x02 garbage \r\n\r\n");
        },
        300,
      );
      expect(wire.startsWith("HTTP/1.1 400")).toBe(true);
      expect(/connection:\s*close/i.test(wire)).toBe(true);
    },
  );
});

describe("SEC-7: pipelining and gate refusals on the Node wire", () => {
  // ATTACK (DISPROVED at review time — now a regression lock): on ONE
  // keep-alive connection a peer pipelines two requests while capacity is
  // saturated; the instant 503 for the second could overtake the first
  // request's response on the socket (response misattribution/desync).
  // EXPECTATION: responses reach the wire in request order.
  it.skipIf(typeof Bun !== "undefined")(
    "SEC-7a: pipelined responses stay in request order when the gate refuses the second",
    { timeout: 15_000 },
    async () => {
      const app = new Keala({ env: "test", overload: { maxConcurrency: 1 } });
      const gate = deferred();
      app.get("/slow", async (c) => {
        await gate.promise;
        c.body = "FIRST-SLOW";
      });
      app.get("/fast", (c) => {
        c.body = "SECOND-FAST";
      });
      const handle = startNodeServer(app, { port: 0 });
      liveServers.push(handle);
      const server = await handle.ready();
      try {
        const wire = await wireExchange(
          server.port,
          async (write) => {
            write("GET /slow HTTP/1.1\r\nHost: x\r\n\r\nGET /fast HTTP/1.1\r\nHost: x\r\n\r\n");
            await wait(50);
            gate.resolve(); // the admitted response flushes last
          },
          300,
        );
        // R4.5's writer frames known-length bodies with content-length (no
        // chunked terminator), so order is asserted framing-independently.
        const statuses = [...wire.matchAll(/HTTP\/1\.1 (\d{3})/g)].map((m) => m[1]);
        expect(statuses).toEqual(["200", "503"]); // request order on the wire
        const firstBody = wire.indexOf("FIRST-SLOW");
        expect(firstBody).toBeGreaterThan(-1);
        expect(firstBody).toBeLessThan(wire.indexOf("HTTP/1.1 503"));
      } finally {
        gate.resolve();
      }
    },
  );

  // FINDING SEC-7b (P2, wire) — the built-in rejection declares
  // `connection: close` on the Response object (observable by every
  // fetch-mode consumer/gateway), but writeResponse skips the response's own
  // connection header whenever the ADAPTER is not draining — so an overload
  // 503 (non-drain) reaches the Node wire as `Connection: keep-alive` +
  // `Keep-Alive: timeout=5`: object contract and wire disagree, and refused
  // peers keep sockets warm through rejection floods.
  // EXPECTATION: a gate rejection that declares connection: close is closed
  // on the wire.
  it.skipIf(typeof Bun !== "undefined")(
    "SEC-7b: an overload 503 that declares connection: close is closed on the wire",
    { timeout: 15_000 },
    async () => {
      const app = new Keala({ env: "test", overload: { maxConcurrency: 1 } });
      const gate = deferred();
      app.get("/slow", async (c) => {
        await gate.promise;
        c.body = "done";
      });
      const handle = startNodeServer(app, { port: 0 });
      liveServers.push(handle);
      const server = await handle.ready();
      const holder = app.handle(new Request("http://x/slow"));
      try {
        const wire = await wireExchange(
          server.port,
          async (write) => {
            write("GET /probe HTTP/1.1\r\nHost: x\r\n\r\n");
          },
          300,
        );
        expect(wire.startsWith("HTTP/1.1 503")).toBe(true);
        // Fixed in the review round: writeResponse honors a Response that
        // itself declares connection: close even outside drain.
        expect(wire).toMatch(/connection:\s*close/i);
      } finally {
        gate.resolve();
        await holder;
      }
    },
  );
});

describe("SEC-8: signal bridge — request input cannot synthesize process signals", () => {
  // ATTACK: a request tries to forge signal delivery (method/URL/headers
  // named after signals) hoping to flip the app into draining. EXPECTATION:
  // only real process signals reach the bridge; no request path reaches
  // process.kill/emit/exit anywhere in src.
  it("SEC-8a: signal-shaped requests leave the bridge untouched; src has no process control", async () => {
    const srcDir = fileURLToPath(new URL("../../src", import.meta.url));
    for (const file of srcFilesUnder(srcDir).filter((f) => f.endsWith(".ts"))) {
      expect(readFileSync(file, "utf8")).not.toMatch(/process\s*\.\s*(kill|exit|emit|abort)\s*\(/);
    }
    const app = new Keala({ env: "test" });
    app.get("/x", (c) => {
      c.body = "ok";
    });
    const handle = startNodeServer(app, { port: 0, signals: true });
    liveServers.push(handle);
    const server = await handle.ready();
    // Cast rationale as in unhandledTracker (bun-types narrows the map).
    const proc = process as unknown as {
      removeAllListeners(event: string): unknown;
      on(event: string, fn: (...args: unknown[]) => void): unknown;
      listeners(event: string): Array<(...args: unknown[]) => void>;
    };
    const before = { term: proc.listeners("SIGTERM"), int: proc.listeners("SIGINT") };
    try {
      const viaHttp = await fetch(`http://127.0.0.1:${server.port}/x?signal=SIGTERM&kill=1`, {
        headers: { "x-signal": "SIGINT", "x-kill": "process.exit(1)" },
      });
      expect(viaHttp.status).toBe(200);
      expect(app.isDraining()).toBe(false);
      expect(proc.listeners("SIGTERM")).toEqual(before.term);
      expect(proc.listeners("SIGINT")).toEqual(before.int);
    } finally {
      server.stop(true);
      // Drop only what the bridge installed.
      proc.removeAllListeners("SIGTERM");
      for (const listener of before.term) proc.on("SIGTERM", listener);
      proc.removeAllListeners("SIGINT");
      for (const listener of before.int) proc.on("SIGINT", listener);
    }
  });

  // FINDING SEC-8b (P2, ops/availability) — ATTACK: requests wedge the drain
  // window; the operator sends the documented SECOND signal to force-stop
  // (docs §2.2 rule 9: "第二个 → close({drain: 0}) 强停"). The bridge calls
  // app.close({ drain: 0 }), but closeApp returns the FIRST close promise
  // (§2.2 rule 6 idempotency) — the force-stop branch is dead code: rules 6
  // and 9 are mutually unimplementable as coded, and the process lingers
  // until the original drain window expires.
  // EXPECTATION: a second close({drain: 0}) forces the shutdown immediately.
  it(
    "SEC-8b: a second close({drain:0}) (the bridge's second signal) force-stops the drain",
    { timeout: 10_000 },
    async () => {
      const app = new Keala({ env: "test" });
      const gate = deferred();
      app.get("/stuck", () => gate.promise.then(() => undefined));
      void app.handle(new Request("http://x/stuck"));
      void app.close({ drain: 5000 }); // first signal: default drain
      try {
        const forced = app.close({ drain: 0 }); // the second signal's call
        const sentinel = Symbol("pending");
        const outcome = await Promise.race([forced, wait(120).then(() => sentinel)]);
        // Fixed in the review round: escalation settles the pending close.
        expect(outcome).not.toBe(sentinel);
        // A forced close REPORTS the stranded request (§2.2 rule 5); it
        // does not release its slot — the stuck handler still holds it.
        expect(outcome).toEqual({ timedOut: true, inFlight: 1 });
      } finally {
        gate.resolve();
      }
    },
  );
});

describe("SEC-9: requestTimeout 504 — no request-derived data, fixed abort reason", () => {
  // ATTACK: a peer sends secret-looking query/headers hoping the deadline
  // 504 reflects request data into its body/headers, or that the mapper sees
  // a request-shaped error. EXPECTATION: fixed "request deadline exceeded".
  it("SEC-9a: the deadline 504 body is the fixed message; no request-derived leak", async () => {
    const marker = `SECRET-${Math.random().toString(36).slice(2)}`;
    let mappedStatus = 0;
    let mappedMessage = "";
    const app = new Keala({ env: "test", requestTimeout: 40 });
    app.onError((error) => {
      mappedStatus = error.status;
      mappedMessage = error.message;
      return new Response(`mapped:${error.status}`, { status: error.status });
    });
    app.get("/hang", async () => {
      await wait(500);
    });
    const res = await app.handle(
      new Request(`http://x/hang?token=${marker}&path=/admin`, {
        headers: { "x-secret": marker, authorization: `Bearer ${marker}` },
      }),
    );
    expect(res.status).toBe(504);
    expect(await res.text()).toBe("mapped:504");
    expect(mappedStatus).toBe(504);
    expect(mappedMessage).toBe("request deadline exceeded");
    const flat = [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
    expect(flat).not.toContain(marker);
    expect(app.inFlight).toBe(0); // the slot was freed at the deadline
  });

  // ATTACK: the abort REASON could carry per-request internals (URLs, error
  // objects) observable by late readers of c.signal. EXPECTATION: the reason
  // is the shared, constant TimeoutError DOMException.
  it("SEC-9b: c.signal's abort reason is the shared fixed TimeoutError", async () => {
    const reasons: unknown[] = [];
    const app = new Keala({ env: "test", requestTimeout: 40 });
    app.get("/hang", async (c) => {
      void c.signal; // materialize before the deadline
      await wait(300);
      reasons.push(c.signal.reason);
    });
    const probes = [0, 1].map((i) => app.handle(new Request(`http://x/hang?marker=M${i}`)));
    await Promise.all(probes.map((p) => p.catch(() => undefined))); // 504s out
    await wait(400); // let the parked zombies observe their aborted signals
    expect(reasons).toHaveLength(2);
    const r1 = reasons[0] as DOMException;
    const r2 = reasons[1] as DOMException;
    expect(r1).toBe(r2); // the SAME shared constant — nothing per-request
    expect(r1).toBeInstanceOf(DOMException);
    expect(r1.name).toBe("TimeoutError");
    expect(r1.message).toBe("request deadline exceeded");
    expect(app.inFlight).toBe(0);
  });

  // ATTACK: after the 504 is out, the zombie handler settles late — its
  // settlement must be contained (docs §2.4 rule 3). EXPECTATION: no
  // unhandledRejection, counter restored, next request healthy.
  it("SEC-9c: the zombie's late settlement is contained — counter restored, next request healthy", async () => {
    const app = new Keala({ env: "test", requestTimeout: 40 });
    const gate = deferred();
    app.get("/zombie", async (c) => {
      await gate.promise;
      c.body = "zombie-writes-late"; // harmless write after the 504
    });
    app.get("/next", (c) => {
      c.body = "healthy";
    });
    const tracker = unhandledTracker();
    try {
      const res = await app.handle(new Request("http://x/zombie"));
      expect(res.status).toBe(504);
      expect(app.inFlight).toBe(0); // capacity already freed at the deadline
      gate.resolve(); // the zombie wakes
      await wait(30);
      expect(tracker.count()).toBe(0);
      expect(app.inFlight).toBe(0);
      const next = await app.handle(new Request("http://x/next"));
      expect(next.status).toBe(200);
      expect(await next.text()).toBe("healthy");
    } finally {
      tracker.stop();
    }
  });
});
