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

/**
 * Count unhandledRejection AND uncaughtException while armed. Post-destroy
 * wire writes (abandoned sockets, force-closed drains) are the classic
 * source; counting keeps the worker alive so the finding is attributable.
 */
export const noiseTracker = (): { count: () => number; stop: () => void } => {
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
