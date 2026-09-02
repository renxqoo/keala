/**
 * SECURITY review — R4.6 lifecycle (branch codex/r4-6-lifecycle-overload).
 * Contract: docs/HOTPATH-R4-6-LIFECYCLE-DESIGN.md §2.2 (rules/invariants)
 * and §7.3 (hot-path forbidden actions). Companion to
 * test/agent-r46-security{,-2}.test.ts — this file hunts what those locks
 * MISS (strategy garbage, wire-level queue abandon, cached rejection
 * Responses, drain races, deadline storms, signal cross-talk).
 *
 * Every test states an ATTACK and the expectation that must hold.
 * FAILING tests = holes confirmed (left failing, clearly named):
 *   - REVIEW-SEC-3 (strategy returning garbage synchronously throws out of app.handle)
 *   - REVIEW-SEC-4 (strategy resolving undefined rides through as the "response")
 *   - REVIEW-SEC-15 (abandoned wire queue entries hold their slot until the timer)
 */

/* eslint-disable max-lines -- one review file per the task mandate (18 security probes; the review agent is restricted to this single file) */

import { afterAll, describe, expect, it } from "vitest";
import { connect, type Socket } from "node:net";

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

/**
 * Count unhandledRejection AND uncaughtException while armed. Post-destroy
 * wire writes (abandoned sockets, force-closed drains) are the classic
 * source; counting keeps the worker alive so the finding is attributable.
 */
const noiseTracker = (): { count: () => number; stop: () => void } => {
  let n = 0;
  const bump = (): void => {
    n += 1;
  };
  const on = process.on.bind(process) as unknown as (event: string, fn: () => void) => void;
  const off = process.off.bind(process) as unknown as (event: string, fn: () => void) => void;
  on("unhandledRejection", bump);
  on("uncaughtException", bump);
  return {
    count: () => n,
    stop: () => {
      off("unhandledRejection", bump);
      off("uncaughtException", bump);
    },
  };
};

/** Wire-level exchange (pattern from agent-r46-security-2.test.ts). */
const wireExchange = async (
  port: number,
  script: (write: (chunk: string) => void) => Promise<void> | void,
  quietMs = 250,
): Promise<string> => {
  const sock: Socket = connect(port, "127.0.0.1");
  // Server-side force closes (drain escalation, connection: close) can RST a
  // still-open client socket; swallow so the test observes the wire, not a crash.
  sock.on("error", () => undefined);
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

const statusLines = (wire: string): string[] =>
  [...wire.matchAll(/HTTP\/1\.1 (\d{3})/g)].map((m) => m[1] as string);

const headerValues = (wire: string, name: string): string[] =>
  [...wire.matchAll(new RegExp(`(?:^|\\r\\n)${name}:([^\\r\\n]*)`, "gi"))].map((m) =>
    (m[1] as string).trim(),
  );

const liveServers: NodeServerHandle[] = [];
afterAll(() => {
  for (const server of liveServers) server.stop(true);
});

describe("REVIEW-SEC-1: rejection integrity — overload.handler throwing exotic values", () => {
  // ATTACK: a handler that throws non-Error values (string, null, undefined,
  // number) or a value that breaks console formatting (a Proxy whose symbol
  // traps throw during util.inspect) hoping to crash the gate or smuggle
  // garbage into the rejection. EXPECTATION: every throw falls back to the
  // fixed built-in 503; app.handle neither rejects nor throws synchronously.
  it("REVIEW-SEC-1: handler throwing string/null/undefined/number/hostile-Proxy all fall back to the built-in 503", async () => {
    const hostileProxy = new Proxy(
      {},
      {
        get(_t, key) {
          // Symbols (util.inspect custom hooks, toStringTag) trigger the throw;
          // string keys stay benign so only inspection explodes.
          if (typeof key === "symbol") throw new Error("inspect-boom");
          return "x";
        },
      },
    );
    const exotics: unknown[] = ["raw-string-boom", null, undefined, 42, hostileProxy];
    const app = new Keala({
      env: "test",
      overload: {
        maxConcurrency: 1,
        handler: () => {
          throw exotics.shift();
        },
      },
    });
    const gate = deferred();
    app.get("/hold", async () => {
      await gate.promise;
    });
    const holder = app.handle(new Request("http://x/hold"));
    try {
      for (const _exotic of exotics) {
        let threw: unknown = null;
        let outcome: unknown;
        try {
          outcome = await app.handle(new Request("http://x/work"));
        } catch (error) {
          threw = error; // sync throw or rejection — both break the contract
        }
        expect(threw).toBeNull();
        expect(outcome).toBeInstanceOf(Response);
        const res = outcome as Response;
        expect(res.status).toBe(503);
        expect(Object.fromEntries(res.headers.entries())).toEqual({
          "content-type": "text/plain; charset=utf-8",
          connection: "close",
          "retry-after": "1",
        });
        expect(await res.text()).toBe("Service Unavailable");
      }
    } finally {
      gate.resolve();
      await holder;
    }
  });
});

describe("REVIEW-SEC-2: custom rejection handler on the Node wire", () => {
  // ATTACK: a custom overload.handler's security-relevant headers (CSP,
  // X-Frame-Options, markers) could be dropped or duplicated on the wire
  // (duplicated Connection headers desync proxies). Note: the drain variant
  // of this attack is unobservable by design — drain closes the listener, so
  // no fresh connection can arrive to be refused (SEC-6a locks the pipelined
  // probe case). EXPECTATION: custom headers verbatim, exactly one Connection
  // header, one cleanly framed response.
  it.skipIf(typeof Bun !== "undefined")(
    "REVIEW-SEC-2: a custom 503 keeps its security headers and stays cleanly framed on the wire",
    { timeout: 15_000 },
    async () => {
      const marker = `CH-${Math.random().toString(36).slice(2)}`;
      const app = new Keala({
        env: "test",
        overload: {
          maxConcurrency: 1,
          handler: () =>
            new Response("CUSTOM-BUSY", {
              status: 503,
              headers: {
                "x-custom": marker,
                "x-frame-options": "DENY",
                connection: "keep-alive",
              },
            }),
        },
      });
      const gate = deferred();
      app.get("/hold", async (c) => {
        await gate.promise;
        c.body = "HOLD";
      });
      const handle = startNodeServer(app, { port: 0 });
      liveServers.push(handle);
      const server = await handle.ready();
      const holder = app.handle(new Request("http://x/hold"));
      try {
        const wire = await wireExchange(server.port, (write) => {
          write("GET /anything HTTP/1.1\r\nHost: x\r\n\r\n");
        });
        expect(wire.startsWith("HTTP/1.1 503")).toBe(true);
        expect(wire).toContain(`x-custom: ${marker}`);
        expect(wire.toLowerCase()).toContain("x-frame-options: deny");
        expect(wire).toContain("CUSTOM-BUSY");
        expect(headerValues(wire, "connection")).toHaveLength(1); // not duplicated
        expect(statusLines(wire)).toHaveLength(1); // one response, no smuggling
      } finally {
        gate.resolve();
        await holder;
      }
    },
  );
});

describe("REVIEW-SEC-3: AdmissionStrategy returning garbage synchronously", () => {
  // ATTACK (misbehaving/plugin-supplied strategy): onSaturated returns a
  // non-Response, non-null, non-thenable value ("busy"). The overload.handler
  // path guards with `instanceof Response` (SEC-1c) — the strategy path must
  // be equally defended. EXPECTATION: built-in 503 fallback, no sync throw
  // out of app.handle.
  it("REVIEW-SEC-3: strategy returning a string falls back to the built-in 503 without throwing", async () => {
    const app = new Keala({
      env: "test",
      overload: {
        maxConcurrency: 1,
        strategy: { onSaturated: () => "busy" as unknown as Response },
      },
    });
    const gate = deferred();
    app.get("/hold", async () => {
      await gate.promise;
    });
    const holder = app.handle(new Request("http://x/hold"));
    let threw: unknown = null;
    let outcome: unknown;
    try {
      outcome = await app.handle(new Request("http://x/work"));
    } catch (error) {
      threw = error;
    }
    gate.resolve();
    await holder;
    expect(threw).toBeNull();
    expect(outcome).toBeInstanceOf(Response);
    expect((outcome as Response).status).toBe(503);
    expect(await (outcome as Response).text()).toBe("Service Unavailable");
  });
});

describe("REVIEW-SEC-4: AdmissionStrategy promise resolving non-Response", () => {
  // ATTACK: an async strategy resolving `undefined` (the classic missing
  // return). null means "admitted" and a Response means "refused" — anything
  // else currently rides through to the caller as the "response". Same class
  // as SEC-1c, unguarded on the promise path. EXPECTATION: built-in 503.
  it("REVIEW-SEC-4: strategy resolving undefined falls back to the built-in 503", async () => {
    const app = new Keala({
      env: "test",
      overload: {
        maxConcurrency: 1,
        strategy: { onSaturated: () => Promise.resolve(undefined as unknown as null) },
      },
    });
    const gate = deferred();
    app.get("/hold", async () => {
      await gate.promise;
    });
    const holder = app.handle(new Request("http://x/hold"));
    const outcome = await app.handle(new Request("http://x/work"));
    gate.resolve();
    await holder;
    expect(outcome).toBeInstanceOf(Response);
    expect((outcome as Response).status).toBe(503);
    expect(await (outcome as Response).text()).toBe("Service Unavailable");
  });
});

describe("REVIEW-SEC-5: pre-context bypass — queue-timeout refusals run nothing", () => {
  // ATTACK: a refusal that goes THROUGH the queue (parks, times out) might
  // still execute middleware or touch the error funnel on the way out.
  // SEC-2a covered only the instant refusal. EXPECTATION: queued-timeout 503s
  // add nothing (docs §2.2: 拒绝路径无 Context/无池交互/无错误漏斗).
  it("REVIEW-SEC-5: queued-then-timed-out requests run no middleware, onError or notFound", async () => {
    const counts = { middleware: 0, mapper: 0, notFound: 0 };
    const app = new Keala({
      env: "test",
      pooling: true,
      overload: { maxConcurrency: 1, maxQueue: 3, queueTimeoutMs: 25 },
    });
    app.use((_c, next) => {
      counts.middleware += 1;
      return next();
    });
    app.notFound(() => {
      counts.notFound += 1;
    });
    app.onError(() => {
      counts.mapper += 1;
      return new Response("mapped");
    });
    const gate = deferred();
    app.get("/hold", async () => {
      await gate.promise;
    });
    const holder = app.handle(new Request("http://x/hold"));
    await wait(10);
    expect(counts.middleware).toBe(1); // the ADMITTED holder only
    const flood = [0, 1, 2].map((i) => app.handle(new Request(`http://x/work-${i}`)));
    const results = await Promise.all(flood);
    expect(results.every((r) => r.status === 503)).toBe(true);
    expect(counts).toEqual({ middleware: 1, mapper: 0, notFound: 0 });
    expect(app.inFlight).toBe(1);
    gate.resolve();
    await holder;
    expect(app.inFlight).toBe(0);
  });
});

describe("REVIEW-SEC-6: signal synthesis — deadline abort must stay request-scoped", () => {
  // ATTACK: request A's deadline fires; a shared/global abort channel would
  // abort request C's c.signal (fabricating client-disconnect evidence for
  // unrelated work). EXPECTATION: only A's signal aborts; B (concurrent,
  // short) completes; C (issued after A's 504) sees a pristine signal.
  it("REVIEW-SEC-6: a deadline abort never crosses into another request's c.signal", async () => {
    const observed: { who: string; aborted: boolean }[] = [];
    const app = new Keala({ env: "test", requestTimeout: 80 });
    app.get("/victim", async (c) => {
      await wait(300);
      observed.push({ who: "victim", aborted: c.signal.aborted });
    });
    app.get("/peer", async (c) => {
      await wait(30);
      observed.push({ who: "peer", aborted: c.signal.aborted });
      c.body = "peer-ok";
    });
    app.get("/after", async (c) => {
      observed.push({ who: "after", aborted: c.signal.aborted });
      c.body = "after-ok";
    });
    const victim = app.handle(new Request("http://x/victim"));
    const peer = app.handle(new Request("http://x/peer"));
    expect((await peer).status).toBe(200); // done well before any deadline
    const victimRes = await victim;
    expect(victimRes.status).toBe(504);
    const after = await app.handle(new Request("http://x/after"));
    expect(after.status).toBe(200); // issued AFTER the deadline fired
    expect(await after.text()).toBe("after-ok");
    await wait(350); // let the parked zombie record its observation
    expect(observed).toEqual([
      { who: "peer", aborted: false },
      { who: "after", aborted: false },
      { who: "victim", aborted: true },
    ]);
    expect(app.inFlight).toBe(0);
  });
});

describe("REVIEW-SEC-7: queue entries for requests whose signal already aborted", () => {
  // ATTACK: flood with requests that are ALREADY aborted when they reach the
  // gate — a buggy arm() would park dead weight in the queue, permanently
  // consuming maxQueue slots (remote DoS with a handful of dead requests).
  // EXPECTATION: an already-aborted request is answered 503 immediately and
  // never takes a queue slot; a fresh request still queues.
  it("REVIEW-SEC-7: an already-aborted request never occupies a queue slot", async () => {
    const app = new Keala({
      env: "test",
      overload: { maxConcurrency: 1, maxQueue: 2, queueTimeoutMs: 5000 },
    });
    const gate = deferred();
    app.get("/hold", async (c) => {
      await gate.promise;
      c.body = "done";
    });
    const holder = app.handle(new Request("http://x/hold"));
    const dead1 = new AbortController();
    const dead2 = new AbortController();
    dead1.abort();
    dead2.abort();
    const started = Date.now();
    const dead = await Promise.all([
      app.handle(new Request("http://x/hold", { signal: dead1.signal })),
      app.handle(new Request("http://x/hold", { signal: dead2.signal })),
    ]);
    expect(Date.now() - started).toBeLessThan(1000); // answered now, not at 5s
    expect(dead.every((r) => r.status === 503)).toBe(true);
    expect(app.inFlight).toBe(1);
    // Both dead requests left the queue: a fresh request QUEUES (pending
    // until the holder releases) instead of being fail-fast refused.
    const fresh = app.handle(new Request("http://x/hold"));
    const sentinel = Symbol("pending");
    const early = await Promise.race([
      fresh.then(() => "settled" as const),
      wait(60).then(() => sentinel as typeof sentinel),
    ]);
    expect(early).toBe(sentinel);
    gate.resolve();
    const freshRes = await fresh;
    expect(freshRes.status).toBe(200);
    expect(await freshRes.text()).toBe("done");
    await holder;
    expect(app.inFlight).toBe(0);
  });
});

describe("REVIEW-SEC-8: queueTimeoutMs boundary values", () => {
  // ATTACK: degenerate configuration values at the admission boundary.
  // EXPECTATION: 0 (and negatives) are rejected at construction; 1ms parks
  // and evicts cleanly (counter intact, healthy service afterwards). The
  // slots-freed proof lives in REVIEW-SEC-7 (the sentinel method needs a
  // timeout window larger than the probe).
  it("REVIEW-SEC-8: queueTimeoutMs 0 throws at construction; 1ms evicts cleanly", async () => {
    expect(
      () =>
        new Keala({
          env: "test",
          overload: { maxConcurrency: 1, maxQueue: 1, queueTimeoutMs: 0 },
        }),
    ).toThrow(TypeError);
    const app = new Keala({
      env: "test",
      overload: { maxConcurrency: 1, maxQueue: 2, queueTimeoutMs: 1 },
    });
    const gate = deferred();
    app.get("/hold", async (c) => {
      await gate.promise;
      c.body = "done";
    });
    const holder = app.handle(new Request("http://x/hold"));
    const flood = [0, 1].map((i) => app.handle(new Request(`http://x/hold-x-${i}`)));
    const results = await Promise.all(flood); // 1ms waiters: evicted fast
    expect(results.every((r) => r.status === 503)).toBe(true);
    expect(app.inFlight).toBe(1); // only the holder — evictions took nothing
    gate.resolve();
    await holder;
    const late = await app.handle(new Request("http://x/hold"));
    expect(late.status).toBe(200);
    expect(await late.text()).toBe("done");
    expect(app.inFlight).toBe(0);
  });
});

describe("REVIEW-SEC-9: deadline zombie — pooling state must not leak", () => {
  // ATTACK: a deadline zombie's context carries request-scoped state
  // (c.state.secret); if the late settle retired it into the pool, the NEXT
  // request would inherit another request's data (cross-request disclosure).
  // EXPECTATION: deadlineAnswered contexts go to GC, never the pool.
  it("REVIEW-SEC-9: a 504 zombie's c.state never reaches the next request", async () => {
    const marker = `ZS-${Math.random().toString(36).slice(2)}`;
    const app = new Keala({ env: "test", pooling: true, requestTimeout: 40 });
    const gate = deferred();
    app.get("/zombie", async (c) => {
      c.state.secret = marker;
      await gate.promise;
      c.body = "late"; // harmless write after the 504
    });
    app.get("/probe", (c) => {
      c.body = `keys=${Object.keys(c.state).toSorted().join(",")}`;
    });
    const zombie = await app.handle(new Request("http://x/zombie"));
    expect(zombie.status).toBe(504);
    expect(app.inFlight).toBe(0);
    gate.resolve();
    await wait(30);
    const probe = await app.handle(new Request("http://x/probe"));
    expect(probe.status).toBe(200);
    expect(await probe.text()).toBe("keys=");
    expect(app.inFlight).toBe(0);
  });
});

describe("REVIEW-SEC-10: requestTimeout 1ms storm", () => {
  // ATTACK: 1000 concurrent requests against a 1ms deadline — a per-request
  // race/timer bug (double settle, double release, escaping rejection) turns
  // into a flood of process-level noise and a corrupted counter.
  // EXPECTATION: exactly one 504 per request, no unhandledRejection, no
  // uncaughtException, counter exactly 0 at the end (docs §2.3 table).
  it("REVIEW-SEC-10: 1000 requests under a 1ms deadline yield one 504 each and a clean counter", { timeout: 30_000 }, async () => {
    const app = new Keala({ env: "test", pooling: true, requestTimeout: 1 });
    const gate = deferred();
    app.get("/hang", async (c) => {
      await gate.promise;
      c.body = "late";
    });
    const tracker = noiseTracker();
    try {
      const all = Array.from({ length: 1000 }, (_, i) =>
        app.handle(new Request(`http://x/hang?i=${i}`)),
      );
      const results = await Promise.all(all);
      expect(results).toHaveLength(1000);
      expect(results.every((r) => r instanceof Response && r.status === 504)).toBe(true);
      expect(app.inFlight).toBe(0);
      gate.resolve(); // wake 1000 zombies at once
      await wait(150);
      expect(tracker.count()).toBe(0);
      expect(app.inFlight).toBe(0);
    } finally {
      tracker.stop();
    }
  });
});

describe("REVIEW-SEC-11: deadline zombie must not write a second response on the wire", () => {
  // ATTACK: the zombie handler settles AFTER the 504 went out; a second write
  // on the keep-alive socket would desync any client/proxy parser (response
  // misattribution). EXPECTATION: exactly one response ever hits the wire.
  it.skipIf(typeof Bun !== "undefined")(
    "REVIEW-SEC-11: wire shows exactly one 504; the zombie's late body never reaches the socket",
    { timeout: 15_000 },
    async () => {
      const app = new Keala({ env: "test", requestTimeout: 120 });
      app.get("/zombie", async (c) => {
        await wait(450);
        c.body = "ZOMBIE-LATE-BYTES";
      });
      const handle = startNodeServer(app, { port: 0 });
      liveServers.push(handle);
      const server = await handle.ready();
      const wire = await wireExchange(
        server.port,
        (write) => {
          write("GET /zombie HTTP/1.1\r\nHost: x\r\n\r\n");
        },
        800, // well past the zombie's 450ms settle
      );
      expect(wire.startsWith("HTTP/1.1 504")).toBe(true);
      expect(statusLines(wire)).toEqual(["504"]);
      expect(wire).not.toContain("ZOMBIE-LATE-BYTES");
      expect(app.inFlight).toBe(0);
    },
  );
});

describe("REVIEW-SEC-12: pipelined requests racing drain start", () => {
  // ATTACK: request A is admitted and slow; drain starts; request B arrives
  // on the SAME keep-alive connection and is refused. If B's instant 503
  // overtook A's response, a pipelining client would misattribute bodies.
  // EXPECTATION (node semantics, same shape SEC-6a locked): A's close-marked
  // response ends the socket, so B is never answered — the wire holds exactly
  // ONE complete response, in request order, with no misattributed or partial
  // fragments of B (complements SEC-7a, which raced the overload gate).
  it.skipIf(typeof Bun !== "undefined")(
    "REVIEW-SEC-12: drain-start race keeps the wire ordered — one complete response, no misattribution",
    { timeout: 15_000 },
    async () => {
      const app = new Keala({ env: "test" });
      const gate = deferred();
      app.get("/slow", async (c) => {
        await gate.promise;
        c.body = "DRAIN-FIRST";
      });
      app.get("/fast", (c) => {
        c.body = "DRAIN-SECOND";
      });
      const handle = startNodeServer(app, { port: 0 });
      liveServers.push(handle);
      const server = await handle.ready();
      let closed: Promise<{ timedOut: boolean; inFlight: number }> | null = null;
      try {
        const wire = await wireExchange(
          server.port,
          async (write) => {
            write("GET /slow HTTP/1.1\r\nHost: x\r\n\r\n"); // admitted pre-drain
            await wait(60);
            closed = app.close({ drain: 5000 }); // drain starts here
            write("GET /fast HTTP/1.1\r\nHost: x\r\n\r\n"); // refused: draining
            await wait(30);
            gate.resolve();
          },
          400,
        );
        // A's response is the only one on the wire, complete and first.
        expect(statusLines(wire)).toEqual(["200"]);
        expect(wire.indexOf("DRAIN-FIRST")).toBeGreaterThan(-1);
        expect(wire.endsWith("0\r\n\r\n")).toBe(true); // cleanly terminated (chunked)
        expect(wire).not.toContain("DRAIN-SECOND"); // B never ran
        expect(wire.match(/HTTP\/1\.1/g)?.length).toBe(1); // no partial 503 fragment
        expect(headerValues(wire, "connection").map((v) => v.toLowerCase())).toEqual(["close"]);
        expect(wire.toLowerCase()).not.toContain("keep-alive");
      } finally {
        gate.resolve();
      }
      await closed;
    },
  );
});

describe("REVIEW-SEC-17: vanished pipelined peer wedges the drain window open", () => {
  // ATTACK: during drain a hostile client pipelines one request behind an
  // in-flight one, then vanishes. The pipelined ServerResponse never started
  // writing, so Node never emits 'close' for it when the socket dies — the
  // adapter's wireInFlight keeps a phantom count and stopGraceful waits the
  // FULL drain window (default 30s) with nothing alive: every close()/SIGTERM
  // lingers the maximum. The drain timeout is a bound, not a target.
  // EXPECTATION: once the socket is gone and the app counter is 0, close()
  // resolves promptly (well inside the window).
  it.skipIf(typeof Bun !== "undefined")(
    "REVIEW-SEC-17: a vanished pipelined request does not keep close() waiting the full window",
    { timeout: 15_000 },
    async () => {
      const app = new Keala({ env: "test" });
      const gate = deferred();
      app.get("/slow", async (c) => {
        await gate.promise;
        c.body = "DRAIN-FIRST";
      });
      app.get("/fast", (c) => {
        c.body = "never";
      });
      const handle = startNodeServer(app, { port: 0 });
      liveServers.push(handle);
      const server = await handle.ready();
      // socket lifecycle is manual: die mid-drain, then measure close().
      const sock = connect(server.port, "127.0.0.1");
      sock.on("error", () => undefined);
      await new Promise<void>((resolve, reject) => {
        sock.once("connect", resolve);
        sock.once("error", reject);
      });
      sock.setEncoding("latin1");
      let buf = "";
      sock.on("data", (d: string) => {
        buf += d;
      });
      sock.write("GET /slow HTTP/1.1\r\nHost: x\r\n\r\n");
      await wait(60);
      const closed = app.close({ drain: 5000 });
      sock.write("GET /fast HTTP/1.1\r\nHost: x\r\n\r\n"); // pipelined, refused
      await wait(40);
      gate.resolve(); // the real work finishes
      await wait(200); // A's response flushes...
      expect(buf).toContain("DRAIN-FIRST"); // ...and the client vanishes
      sock.destroy();
      const started = Date.now();
      const status = await closed;
      const elapsed = Date.now() - started;
      // HOLE: elapsed ≈ the full 5000ms window (timedOut: true, inFlight: 0 —
      // a phantom wire count, nothing real is in flight).
      expect(elapsed).toBeLessThan(2500);
      expect(status.timedOut).toBe(false);
      expect(app.inFlight).toBe(0);
    },
  );
});

describe("REVIEW-SEC-13: a strategy promise that never resolves", () => {
  // ATTACK: a strategy that forgets to settle parks requests before admission
  // — does anything bound them, or do they hold slots/wire requests forever?
  // EXPECTATION: no capacity slot is taken (inFlight untouched) and the drain
  // window bounds the wire request (stopGraceful force-closes). Note: the
  // request deadline does NOT bound this park — it arms post-admission (by
  // design); only close() bounds it.
  it.skipIf(typeof Bun !== "undefined")(
    "REVIEW-SEC-13: a never-resolving strategy holds no slot and is bounded by close()",
    { timeout: 15_000 },
    async () => {
      const app = new Keala({
        env: "test",
        overload: {
          maxConcurrency: 1,
          strategy: { onSaturated: () => new Promise<Response | null>(() => undefined) },
        },
      });
      const gate = deferred();
      app.get("/hold", async (c) => {
        await gate.promise;
        c.body = "done";
      });
      const handle = startNodeServer(app, { port: 0 });
      liveServers.push(handle);
      const server = await handle.ready();
      const holder = app.handle(new Request("http://x/hold"));
      const tracker = noiseTracker();
      try {
        await wireExchange(server.port, (write) => {
          write("GET /work HTTP/1.1\r\nHost: x\r\n\r\n"); // parks in the strategy
        }, 80);
        expect(app.inFlight).toBe(1); // only the holder — the parked request took nothing
        const started = Date.now();
        const closed = app.close({ drain: 300 });
        const status = await closed;
        expect(Date.now() - started).toBeLessThan(2000); // bounded by the drain window
        expect(status.timedOut).toBe(true); // the parked wire request strands
        expect(tracker.count()).toBe(0);
      } finally {
        tracker.stop();
        gate.resolve();
        await holder;
      }
    },
  );
});

describe("REVIEW-SEC-14: cached custom rejection Response reused across refusals", () => {
  // ATTACK: an overload.handler that returns ONE cached Response object for
  // every refusal (a natural "constant" optimization). Response bodies are
  // one-shot: after the first wire refusal consumed it, later refusals hand
  // out a disturbed body. EXPECTATION: every refusal still answers a cleanly
  // framed 503 on the wire (status and headers intact, no desync, no 500, no
  // destroyed connection mid-flood). Note: the configured BODY silently
  // degrades to empty on reuse — recorded in the review report as a
  // degradation (platform one-shot semantics), not asserted here.
  it.skipIf(typeof Bun !== "undefined")(
    "REVIEW-SEC-14: a reused handler Response stays a cleanly framed 503 on every refusal",
    { timeout: 15_000 },
    async () => {
      const cached = new Response("CACHED-BUSY-BYTES", {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
      const app = new Keala({
        env: "test",
        overload: { maxConcurrency: 1, handler: () => cached },
      });
      const gate = deferred();
      app.get("/hold", async (c) => {
        await gate.promise;
        c.body = "done";
      });
      const handle = startNodeServer(app, { port: 0 });
      liveServers.push(handle);
      const server = await handle.ready();
      const holder = app.handle(new Request("http://x/hold"));
      try {
        const first = await wireExchange(server.port, (write) => {
          write("GET /one HTTP/1.1\r\nHost: x\r\n\r\n");
        });
        expect(first.startsWith("HTTP/1.1 503")).toBe(true);
        expect(first).toContain("CACHED-BUSY-BYTES");
        expect(statusLines(first)).toHaveLength(1);
        const second = await wireExchange(server.port, (write) => {
          write("GET /two HTTP/1.1\r\nHost: x\r\n\r\n");
        }, 400);
        expect(second.startsWith("HTTP/1.1 503")).toBe(true); // never a 500
        expect(second.toLowerCase()).toContain("content-type: text/plain"); // headers intact
        expect(statusLines(second)).toHaveLength(1); // single, complete response
        expect(headerValues(second, "connection")).toHaveLength(1); // framing coherent
      } finally {
        gate.resolve();
        await holder;
      }
    },
  );
});

describe("REVIEW-SEC-15: hostile clients flooding the wire queue, then abandoning", () => {
  // ATTACK: open connections, send requests that park in the admission queue,
  // then destroy the sockets. The waiters must leave via the adapter's
  // disconnect→abort bridge (docs §6 S4: "native 路径排队断开出队") — leaked
  // waiters keep the queue "full" for up to queueTimeoutMs per wave, a
  // renewable remote DoS against every queued client.
  // FINDING: the bridge is severed — admitRequest hands the strategy a
  // MATERIALIZED fetch Request (src/core/lifecycle-admission.ts:80), and the
  // built-in queue arms its abort listener on that Request's inert signal, so
  // source.disconnect() finds _abort never materialized. Eviction falls back
  // to the queueTimeoutMs timer (REVIEW-SEC-15b locks that mitigation).
  it.skipIf(typeof Bun !== "undefined")(
    "REVIEW-SEC-15: abandoned queued sockets free their queue slot on disconnect",
    { timeout: 20_000 },
    async () => {
      const app = new Keala({
        env: "test",
        overload: { maxConcurrency: 1, maxQueue: 2, queueTimeoutMs: 60_000 },
      });
      const gate = deferred();
      app.get("/work", async (c) => {
        await gate.promise;
        c.body = "done";
      });
      const handle = startNodeServer(app, { port: 0 });
      liveServers.push(handle);
      const server = await handle.ready();
      const holder = app.handle(new Request("http://x/work"));
      const tracker = noiseTracker();
      const flood: Socket[] = [];
      try {
        for (let i = 0; i < 2; i += 1) {
          const sock = connect(server.port, "127.0.0.1");
          sock.on("error", () => undefined);
          await new Promise<void>((resolve, reject) => {
            sock.once("connect", resolve);
            sock.once("error", reject);
          });
          sock.write(`GET /work?peer=${i} HTTP/1.1\r\nHost: x\r\n\r\n`);
          flood.push(sock);
        }
        await wait(100); // both are parked in the queue
        for (const sock of flood) sock.destroy();
        await wait(300); // disconnects processed by the adapter
        // The queue must be empty again: a fresh request QUEUES (silence
        // until the holder releases) rather than being refused instantly.
        let freshBuf = "";
        const fresh = connect(server.port, "127.0.0.1");
        fresh.on("error", () => undefined);
        await new Promise<void>((resolve, reject) => {
          fresh.once("connect", resolve);
          fresh.once("error", reject);
        });
        fresh.setEncoding("latin1");
        fresh.on("data", (d: string) => {
          freshBuf += d;
        });
        fresh.write("GET /work HTTP/1.1\r\nHost: x\r\n\r\n");
        await wait(300);
        expect(freshBuf).toBe(""); // HOLE: instant 503 — dead waiters still hold slots
        gate.resolve();
        await wait(200);
        expect(freshBuf.startsWith("HTTP/1.1 200")).toBe(true);
        fresh.destroy();
        await holder;
        expect(app.inFlight).toBe(0);
        expect(tracker.count()).toBe(0);
      } finally {
        tracker.stop();
        gate.resolve();
        for (const sock of flood) sock.destroy();
      }
    },
  );

  // The mitigation boundary of REVIEW-SEC-15's hole: eviction eventually
  // happens via the queueTimeoutMs TIMER, and the resulting 503 answered onto
  // the long-dead socket must stay silent (no unhandledRejection /
  // uncaughtException) and free the slot. This is the DEFENDED half.
  it.skipIf(typeof Bun !== "undefined")(
    "REVIEW-SEC-15b: timer eviction of abandoned waiters is bounded and silent",
    { timeout: 20_000 },
    async () => {
      const app = new Keala({
        env: "test",
        overload: { maxConcurrency: 1, maxQueue: 2, queueTimeoutMs: 150 },
      });
      const gate = deferred();
      app.get("/work", async (c) => {
        await gate.promise;
        c.body = "done";
      });
      const handle = startNodeServer(app, { port: 0 });
      liveServers.push(handle);
      const server = await handle.ready();
      const holder = app.handle(new Request("http://x/work"));
      const tracker = noiseTracker();
      const flood: Socket[] = [];
      try {
        for (let i = 0; i < 2; i += 1) {
          const sock = connect(server.port, "127.0.0.1");
          sock.on("error", () => undefined);
          await new Promise<void>((resolve, reject) => {
            sock.once("connect", resolve);
            sock.once("error", reject);
          });
          sock.write(`GET /work?peer=${i} HTTP/1.1\r\nHost: x\r\n\r\n`);
          flood.push(sock);
        }
        await wait(80);
        for (const sock of flood) sock.destroy();
        await wait(500); // past the 150ms timer: evicted onto dead sockets
        expect(app.inFlight).toBe(1); // capacity untouched throughout
        expect(tracker.count()).toBe(0); // dead-socket writes stayed silent
        // Slots are free again: a fresh request queues (silent) ...
        let freshBuf = "";
        const fresh = connect(server.port, "127.0.0.1");
        fresh.on("error", () => undefined);
        await new Promise<void>((resolve, reject) => {
          fresh.once("connect", resolve);
          fresh.once("error", reject);
        });
        fresh.setEncoding("latin1");
        fresh.on("data", (d: string) => {
          freshBuf += d;
        });
        fresh.write("GET /work HTTP/1.1\r\nHost: x\r\n\r\n");
        await wait(80); // well under the 150ms queue timeout
        expect(freshBuf).toBe("");
        gate.resolve();
        await wait(200);
        expect(freshBuf.startsWith("HTTP/1.1 200")).toBe(true);
        expect(freshBuf).toContain("done");
        fresh.destroy();
        await holder;
        expect(app.inFlight).toBe(0);
      } finally {
        tracker.stop();
        gate.resolve();
        for (const sock of flood) sock.destroy();
      }
    },
  );
});

describe("REVIEW-SEC-16: oversized/slow bodies during drain must not wedge stopGraceful", () => {
  // ATTACK: a client POSTs headers declaring a huge body, dribbles a few
  // bytes and keeps the connection open — the admitted handler parks on the
  // body read forever. An unbounded stopGraceful would hang shutdown.
  // EXPECTATION: close() resolves within the drain window (bounded, timedOut
  // true, the stranded request reported) and the force-closed socket's
  // fallout produces no process noise.
  it.skipIf(typeof Bun !== "undefined")(
    "REVIEW-SEC-16: a stalled upload body keeps close() bounded by its drain window",
    { timeout: 20_000 },
    async () => {
      const app = new Keala({ env: "test" });
      const tracker = noiseTracker();
      app.post("/upload", async (c) => {
        const bytes = await c.raw.arrayBuffer(); // parks — body never completes
        c.body = `got-${bytes.byteLength}`;
      });
      const handle = startNodeServer(app, { port: 0 });
      liveServers.push(handle);
      const server = await handle.ready();
      // Manual socket: the stall must survive past close() (no client-side
      // destroy that would end it early via the disconnect bridge).
      const sock = connect(server.port, "127.0.0.1");
      sock.on("error", () => undefined);
      await new Promise<void>((resolve, reject) => {
        sock.once("connect", resolve);
        sock.once("error", reject);
      });
      sock.write("POST /upload HTTP/1.1\r\nHost: x\r\nContent-Length: 10000\r\n\r\n");
      sock.write("AAAAA"); // 5 of 10000 bytes, then silence
      await wait(100);
      try {
        const started = Date.now();
        const status = await app.close({ drain: 250 });
        expect(Date.now() - started).toBeLessThan(2000); // bounded by drain
        expect(status.timedOut).toBe(true); // the stalled upload strands, reported
        expect(status.inFlight).toBe(1);
        await wait(300); // fallout from the force-closed upload socket
        expect(tracker.count()).toBe(0);
      } finally {
        tracker.stop();
        sock.destroy();
      }
    },
  );
});
