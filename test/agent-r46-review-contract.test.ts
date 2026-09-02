/* eslint-disable max-lines -- one review file per the task mandate (44 contract probes; agent is restricted to this single file) */
/**
 * R4.6 CONTRACT review — docs/HOTPATH-R4-6-LIFECYCLE-DESIGN.md §2.1/§2.2/§2.3/
 * §4 (U1-U3, AdmissionStrategy)/§6 (slots) + MIGRATION §4 vs implementation.
 * One rule per test (REVIEW-CT-n): FAILING = confirmed contract violation
 * (rule cited in the name); PASSING = contract holds (kept as a lock).
 * Helper style mirrors test/r4-lifecycle-overload.test.ts.
 */
import { afterAll, expect, it, vi } from "vitest";
import net from "node:net";
import { spawn } from "node:child_process";
import { Keala } from "../src/core/app.ts";
import { installSignalBridge } from "../src/core/lifecycle.ts";
import {
  failFastAdmission,
  normalizeOverload,
  queueAdmission,
} from "../src/core/lifecycle-admission.ts";
import { startNodeServer, type NodeServerHandle } from "../src/adapters/node.ts";
import { startBunServer, type ServeImplementation } from "../src/adapters/bun.ts";
import type { Context } from "../src/core/context/context.ts";

const deferred = <T = void>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((res) => (resolve = res)), resolve };
};
const wait = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));
const waitUntil = async <T>(probe: () => T | false, ms: number): Promise<T | null> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = probe();
    if (v) return v;
    if (Date.now() >= end) return null;
    await wait(25);
  }
};
const state = (p: Promise<unknown>, ms: number): Promise<"resolved" | "pending"> =>
  Promise.race([p.then(() => "resolved" as const), wait(ms).then(() => "pending" as const)]);

const liveServers: NodeServerHandle[] = [];
afterAll(() => {
  for (const s of liveServers) s.stop(true);
});

/** True when the port refuses new TCP connections (the listener is dead). */
const refusedPort = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1");
    sock.once("error", (e: NodeJS.ErrnoException) => (sock.destroy(), resolve(e.code === "ECONNREFUSED")));
    sock.once("connect", () => (sock.destroy(), resolve(false)));
  });

/** unhandledRejection spy (typing cast per test/r4-lifecycle-timeout.test.ts). */
const unhandledWatch = (): { hits: unknown[]; stop: () => void } => {
  const hits: unknown[] = [];
  const on = (reason: unknown): void => {
    hits.push(reason);
  };
  (process.on as unknown as (event: string, fn: (r: unknown) => void) => void)(
    "unhandledRejection",
    on,
  );
  return {
    hits,
    stop: () =>
      (process.off as unknown as (event: string, fn: (r: unknown) => void) => void)(
        "unhandledRejection",
        on,
      ),
  };
};

/** Bun-shaped serve mock with a real-shaped stopGraceful (registerForce wired). */
const fakeGracefulServe = (): { impl: ServeImplementation; stopCalls: () => Array<boolean | undefined> } => {
  const stops: Array<boolean | undefined> = [];
  const impl: ServeImplementation = (options) => ({
    port: (options["port"] as number) ?? 0,
    hostname: "localhost",
    stop: (closeActive?: boolean) => void stops.push(closeActive),
    fetch: async () => new Response("fake"),
    reload: () => {},
    stopGraceful: (grace) =>
      new Promise((resolve) => {
        stops.push(undefined);
        let done = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (timedOut: boolean): void => {
          if (done) return;
          done = true;
          if (timer !== undefined) clearTimeout(timer);
          if (timedOut) stops.push(true);
          resolve({ timedOut });
        };
        grace.registerForce?.(() => finish(true));
        if (grace.drain !== Number.POSITIVE_INFINITY) timer = setTimeout(() => finish(true), grace.drain);
        if (grace.onSettled(() => finish(false))) finish(false);
      }),
  });
  return { impl, stopCalls: () => stops };
};

/**
 * Real-signal bridge probe (§2.1 "二次信号强停", §2.2 r9): a child process
 * runs the Node adapter with signals:true; the parent sends two real signals;
 * the child reports the bridge close's CloseStatus (and how it exited).
 */
const bridgeChildClose = async (
  signals: readonly [NodeJS.Signals, NodeJS.Signals],
): Promise<{ status: { timedOut: boolean } | null; exitBySecondSignal: boolean }> => {
  const appUrl = new URL("../src/core/app.ts", import.meta.url).href;
  const nodeUrl = new URL("../src/adapters/node.ts", import.meta.url).href;
  const source = `
import { Keala } from ${JSON.stringify(appUrl)};
import { listen } from ${JSON.stringify(nodeUrl)};
const app = new Keala({ env: "test" });
app.get("/park", async (c) => {
  await new Promise((resolve) => setTimeout(resolve, 5000)); // outlives the probe
  c.body = "done";
});
const server = await listen(app, { port: 0, hostname: "127.0.0.1", signals: true }).ready();
process.stdout.write("READY\\n");
void fetch("http://127.0.0.1:" + server.port + "/park").catch(() => undefined);
const poll = setInterval(() => {
  if (!app.isDraining()) return;
  clearInterval(poll);
  void app.close().then(
    (status) => process.stdout.write("CLOSE " + JSON.stringify(status) + "\\n"),
    (error) => process.stdout.write("CLOSE-ERROR " + String(error) + "\\n"),
  );
}, 10);
`;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  const exitBox: { current: { code: number | null; signal: string | null } | null } = {
    current: null,
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (c: string) => (out += c));
  child.on("exit", (code, signal) => (exitBox.current = { code, signal }));
  child.stderr.resume();
  try {
    if ((await waitUntil(() => out.includes("READY"), 5000)) === null)
      return { status: null, exitBySecondSignal: exitBox.current?.signal === signals[1] };
    await wait(200);
    child.kill(signals[0]);
    await wait(200); // drain running on the default window
    child.kill(signals[1]);
    const line = await waitUntil(() => {
      const m = out.match(/CLOSE (.+)\n|CLOSE-ERROR (.+)\n/);
      return m ? (m[1] ?? `ERROR:${m[2]}`) : false;
    }, 1500);
    if (line === null || line.startsWith("ERROR:"))
      return { status: null, exitBySecondSignal: exitBox.current?.signal === signals[1] };
    return { status: JSON.parse(line) as { timedOut: boolean }, exitBySecondSignal: false };
  } finally {
    child.kill("SIGKILL");
  }
};

it("REVIEW-CT-1: §2.1 CloseStatus shape; isDraining one-way (true forever after close)", async () => {
  const app = new Keala({ env: "test" });
  app.get("/x", (c) => { c.body = "x"; });
  expect(app.isDraining()).toBe(false);
  const status = await app.close({ drain: 100 });
  expect(Object.keys(status).toSorted()).toEqual(["inFlight", "timedOut"]);
  expect(status).toEqual({ timedOut: false, inFlight: 0 });
  expect(app.isDraining()).toBe(true);
  expect((await app.handle(new Request("http://x/x"))).status).toBe(503);
  expect(app.isDraining()).toBe(true);
});

it("REVIEW-CT-2: §2.1 close() is idempotent — repeat calls return the SAME promise object", async () => {
  const app = new Keala({ env: "test" });
  const first = app.close();
  expect(app.close()).toBe(first);
  expect(app.close({ drain: 500 })).toBe(first);
  await expect(first).resolves.toEqual({ timedOut: false, inFlight: 0 });
});

it("REVIEW-CT-3: §2.1 drain validation — negative / NaN / -Infinity throw TypeError; app stays usable", async () => {
  for (const bad of [-1, Number.NaN, -Infinity]) {
    const app = new Keala({ env: "test" });
    expect(() => app.close({ drain: bad })).toThrow(TypeError);
  }
  const app = new Keala({ env: "test" });
  app.get("/x", (c) => { c.body = "x"; });
  expect(() => app.close({ drain: -5 })).toThrow(TypeError);
  expect(app.isDraining()).toBe(false);
  expect((await app.handle(new Request("http://x/x"))).status).toBe(200);
  await expect(app.close({ drain: 100 })).resolves.toEqual({ timedOut: false, inFlight: 0 });
});

it("REVIEW-CT-4: §2.2 escalation — a repeat close({drain:0}) force-resolves a RUNNING close", async () => {
  const app = new Keala({ env: "test" });
  const gate = deferred();
  app.get("/park", async (c) => {
    await gate.promise;
    c.body = "done";
  });
  const inflight = app.handle(new Request("http://x/park"));
  await wait(10);
  const closing = app.close({ drain: 5000 });
  expect(await state(closing, 50)).toBe("pending");
  expect(app.close({ drain: 0 })).toBe(closing);
  await expect(closing).resolves.toEqual({ timedOut: true, inFlight: 1 });
  gate.resolve();
  const res = await inflight;
  expect(res.status).toBe(200);
  await res.text();
  await wait(10);
  expect(app.inFlight).toBe(0);
});

it("REVIEW-CT-5: §2.2 escalation is drain:0-only — a repeat close({drain:80}) does NOT force", async () => {
  const app = new Keala({ env: "test" });
  const gate = deferred();
  app.get("/park", async (c) => {
    await gate.promise;
    c.body = "done";
  });
  const inflight = app.handle(new Request("http://x/park"));
  await wait(10);
  const closing = app.close({ drain: 6000 });
  void app.close({ drain: 80 });
  await wait(200);
  expect(app.isDraining()).toBe(true);
  await app.close({ drain: 0 });
  await expect(closing).resolves.toEqual({ timedOut: true, inFlight: 1 });
  gate.resolve();
  await (await inflight).text();
});

it("REVIEW-CT-6: §2.2 default drain window is not immediate; close completes via the counter", async () => {
  const app = new Keala({ env: "test" });
  const gate = deferred();
  app.get("/park", async (c) => {
    await gate.promise;
    c.body = "done";
  });
  const inflight = app.handle(new Request("http://x/park"));
  await wait(10);
  const closing = app.close(); // default window (30_000 per §2.2)
  expect(await state(closing, 250)).toBe("pending");
  gate.resolve();
  await (await inflight).text();
  await expect(closing).resolves.toEqual({ timedOut: false, inFlight: 0 });
});

it("REVIEW-CT-7: §2.2 r2 — drain:Infinity never arms a timer; the counter completes the close", async () => {
  const app = new Keala({ env: "test" });
  const gate = deferred();
  app.get("/park", async (c) => {
    await gate.promise;
    c.body = "done";
  });
  const inflight = app.handle(new Request("http://x/park"));
  await wait(10);
  const closing = app.close({ drain: Number.POSITIVE_INFINITY });
  expect(await state(closing, 150)).toBe("pending");
  gate.resolve();
  await (await inflight).text();
  await expect(closing).resolves.toEqual({ timedOut: false, inFlight: 0 });
});

it("REVIEW-CT-8: §2.2 r3 — drain:0 is immediate force and the listener ALWAYS dies (real Node server)", async () => {
  const app = new Keala({ env: "test" });
  const gate = deferred();
  app.get("/park", async (c) => {
    await gate.promise;
    c.body = "done";
  });
  const server = await startNodeServer(app, { port: 0, hostname: "127.0.0.1" }).ready();
  liveServers.push(server);
  const inflight = fetch(`http://127.0.0.1:${server.port}/park`).then(
    (r) => `ok:${r.status}`,
    () => "reset",
  );
  await wait(30);
  expect(app.inFlight).toBe(1);
  await expect(app.close({ drain: 0 })).resolves.toEqual({ timedOut: true, inFlight: 1 });
  await wait(30);
  expect(await refusedPort(server.port)).toBe(true);
  gate.resolve();
  await inflight;
  await wait(20);
  expect(app.inFlight).toBe(0);
});

it("REVIEW-CT-9: §2.2 r3 — drain window expiry reports {timedOut:true, inFlight:N}", async () => {
  const app = new Keala({ env: "test" });
  const gate = deferred();
  app.get("/park", async (c) => {
    await gate.promise;
    c.body = "done";
  });
  const inflight = app.handle(new Request("http://x/park"));
  await wait(10);
  await expect(app.close({ drain: 60 })).resolves.toEqual({ timedOut: true, inFlight: 1 });
  gate.resolve();
  await (await inflight).text();
  await wait(10);
  expect(app.inFlight).toBe(0);
});

it("REVIEW-CT-10: §2.3 — CloseStatus resolves LAST (after in-flight work completes)", async () => {
  const app = new Keala({ env: "test" });
  const gate = deferred();
  const order: string[] = [];
  app.get("/park", async (c) => {
    await gate.promise;
    c.body = "done";
    order.push("request-done");
  });
  const inflight = app.handle(new Request("http://x/park"));
  await wait(10);
  const closing = app.close({ drain: 3000 }).then((s) => (order.push("close-done"), s));
  gate.resolve();
  await (await inflight).text();
  await closing;
  expect(order).toEqual(["request-done", "close-done"]);
});

it("REVIEW-CT-11: §2.2 r5 — a bodied response during drain holds its slot until fully consumed", async () => {
  const app = new Keala({ env: "test" });
  const gate = deferred();
  app.get("/s", async () => {
    await gate.promise;
    return new Response(
      new ReadableStream({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode("chunk1;"));
          await wait(30);
          controller.enqueue(new TextEncoder().encode("chunk2;"));
          controller.close();
        },
      }),
    );
  });
  const inflight = app.handle(new Request("http://x/s"));
  await wait(10);
  const closing = app.close({ drain: 3000 });
  gate.resolve();
  const res = await inflight;
  expect(await state(closing, 120)).toBe("pending"); // body unconsumed: slot held
  expect(await res.text()).toBe("chunk1;chunk2;");
  await expect(closing).resolves.toEqual({ timedOut: false, inFlight: 0 });
});

it("REVIEW-CT-12: §2.2 r5 — a consumer CANCEL of the drain-held body releases the slot", async () => {
  const app = new Keala({ env: "test" });
  const gate = deferred();
  app.get("/s", async () => {
    await gate.promise;
    return new Response(
      new ReadableStream({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode("a;"));
          await wait(2000);
          controller.close();
        },
      }),
    );
  });
  const inflight = app.handle(new Request("http://x/s"));
  await wait(10);
  const closing = app.close({ drain: 3000 });
  gate.resolve();
  const res = await inflight;
  expect(await state(closing, 80)).toBe("pending");
  await res.body!.cancel("consumer gone");
  await expect(closing).resolves.toEqual({ timedOut: false, inFlight: 0 });
});

it("REVIEW-CT-13: §2.1 — listen() after close() throws", async () => {
  const app = new Keala({ env: "test" });
  await app.close({ drain: 100 });
  expect(() => app.listen(3000, { signals: true } as never)).toThrow(/shutting down/);
});

it("REVIEW-CT-14: §2.1 — inFlight is readonly (assignment throws)", () => {
  const app = new Keala({ env: "test" });
  expect(() => ((app as unknown as { inFlight: number }).inFlight = 42)).toThrow(TypeError);
  expect(app.inFlight).toBe(0);
});

it("REVIEW-CT-15: §2.1/§6 C1 — inFlight counts admitted-not-settled; queued requests are excluded", async () => {
  const plain = new Keala({ env: "test" });
  const gate = deferred();
  plain.get("/park", async (c) => {
    await gate.promise;
    c.body = "done";
  });
  const inflight = plain.handle(new Request("http://x/park"));
  await wait(10);
  expect(plain.inFlight).toBe(1);
  gate.resolve();
  await (await inflight).text();
  expect(plain.inFlight).toBe(0); // released at settle (documented asymmetry)

  const queued = new Keala({ env: "test", overload: { maxConcurrency: 1, maxQueue: 2 } });
  const gate2 = deferred();
  queued.get("/park", async (c) => {
    await gate2.promise;
    c.body = "done";
  });
  const first = queued.handle(new Request("http://x/park"));
  void queued.handle(new Request("http://x/park"));
  void queued.handle(new Request("http://x/park"));
  await wait(10);
  expect(queued.inFlight).toBe(1); // queued waiters hold no capacity
  gate2.resolve();
  await first;
  await wait(20);
  expect(queued.inFlight).toBe(0);
});

it("REVIEW-CT-16: §2.1/§4 U1 — documented defaults; implicit selection is failFast/queue (byte-equal)", () => {
  const d = normalizeOverload({});
  expect(d.maxConcurrency).toBe(Number.POSITIVE_INFINITY);
  expect(d.maxQueue).toBe(0);
  expect(d.queueTimeoutMs).toBe(10_000);
  expect(d.retryAfterSeconds).toBe(1);
  expect(d.handler).toBeUndefined();
  expect(d.strategy).toBe(failFastAdmission);
  expect(normalizeOverload({ maxConcurrency: 2, maxQueue: 4 }).strategy).toBe(queueAdmission);
  expect(normalizeOverload({ maxConcurrency: 2 }).strategy).toBe(failFastAdmission);
  expect(normalizeOverload({ maxConcurrency: Number.POSITIVE_INFINITY }).maxConcurrency).toBe(
    Number.POSITIVE_INFINITY,
  );
  expect(() => normalizeOverload({ maxConcurrency: Number.POSITIVE_INFINITY, maxQueue: 1 })).toThrow(
    /finite/,
  );
});

it("REVIEW-CT-17: §2.1 — every overload validation error case throws TypeError", () => {
  expect(() => new Keala({ overload: "nope" as never })).toThrow(TypeError);
  expect(() => new Keala({ overload: null as never })).toThrow(TypeError);
  for (const bad of [0, -1, 1.5, Number.NaN])
    expect(() => new Keala({ overload: { maxConcurrency: bad } })).toThrow(TypeError);
  for (const bad of [-1, 2.5])
    expect(() => new Keala({ overload: { maxConcurrency: 1, maxQueue: bad } })).toThrow(TypeError);
  expect(() => new Keala({ overload: { maxQueue: 1 } })).toThrow(/finite/);
  for (const bad of [0, -5, 1.5])
    expect(() =>
      new Keala({ overload: { maxConcurrency: 1, maxQueue: 1, queueTimeoutMs: bad } }),
    ).toThrow(TypeError);
  for (const bad of [-1, 0.5])
    expect(() =>
      new Keala({ overload: { maxConcurrency: 1, retryAfterSeconds: bad } }),
    ).toThrow(TypeError);
  expect(() => new Keala({ overload: { maxConcurrency: 1, handler: "x" as never } })).toThrow(TypeError);
  expect(() => new Keala({ overload: { maxConcurrency: 1, strategy: {} as never } })).toThrow(/onSaturated/);
  expect(() =>
    new Keala({ overload: { maxConcurrency: 1, strategy: { onSaturated: null } as never } }),
  ).toThrow(/onSaturated/);
  expect(
    () => new Keala({ overload: { maxConcurrency: 1, retryAfterSeconds: 0, queueTimeoutMs: 5_000 } }),
  ).not.toThrow();
});

it("REVIEW-CT-18: §2.1 — requestTimeout 0/undefined = off; invalid values throw at construction", async () => {
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, "30000" as never])
    expect(() => new Keala({ requestTimeout: bad })).toThrow(TypeError);
  for (const off of [undefined, 0]) {
    const app = new Keala({ env: "test", requestTimeout: off });
    app.get("/slow", async (c) => {
      await wait(70);
      c.body = "fine";
    });
    expect((await app.handle(new Request("http://x/slow"))).status).toBe(200);
  }
});

it("REVIEW-CT-19: §2.2 — built-in rejection shape is exact (503, text/plain, connection: close, Retry-After, body)", async () => {
  const app = new Keala({ env: "test", overload: { maxConcurrency: 1 } });
  const gate = deferred();
  app.get("/work", async (c) => {
    await gate.promise;
    c.body = "ok";
  });
  const first = app.handle(new Request("http://x/work"));
  const r = await app.handle(new Request("http://x/work"));
  expect(r.status).toBe(503);
  expect(r.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(r.headers.get("connection")).toBe("close");
  expect(r.headers.get("retry-after")).toBe("1");
  expect(await r.text()).toBe("Service Unavailable");
  gate.resolve();
  await first;
});

it("REVIEW-CT-20: §2.2 — Retry-After ONLY when not draining AND retryAfterSeconds > 0", async () => {
  const live = new Keala({ env: "test", overload: { maxConcurrency: 1, retryAfterSeconds: 7 } });
  const gate = deferred();
  live.get("/w", async (c) => {
    await gate.promise;
    c.body = "ok";
  });
  const first = live.handle(new Request("http://x/w"));
  expect((await live.handle(new Request("http://x/w"))).headers.get("retry-after")).toBe("7");
  gate.resolve();
  await first;

  const zero = new Keala({ env: "test", overload: { maxConcurrency: 1, retryAfterSeconds: 0 } });
  const gate2 = deferred();
  zero.get("/w", async (c) => {
    await gate2.promise;
    c.body = "ok";
  });
  const first2 = zero.handle(new Request("http://x/w"));
  expect((await zero.handle(new Request("http://x/w"))).headers.get("retry-after")).toBeNull();
  gate2.resolve();
  await first2;

  for (const retryAfterSeconds of [undefined, 5]) {
    const app = new Keala({
      env: "test",
      overload: { maxConcurrency: 1, ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) },
    });
    app.get("/w", (c) => { c.body = "ok"; });
    await app.close({ drain: 100 });
    const r = await app.handle(new Request("http://x/w"));
    expect(r.status).toBe(503);
    expect(r.headers.get("retry-after")).toBeNull();
    expect(r.headers.get("connection")).toBe("close");
  }
});

it("REVIEW-CT-21: §2.1/§2.2 — handler override is returned verbatim; reasons are the closed 3-value vocabulary", async () => {
  const reasons: string[] = [];
  const app = new Keala({
    env: "test",
    overload: {
      maxConcurrency: 1,
      maxQueue: 1,
      queueTimeoutMs: 20,
      handler: (_request, reason) => {
        reasons.push(reason);
        return new Response(`busy:${reason}`, { status: 529, headers: { "x-own": "1" } });
      },
    },
  });
  const gate = deferred();
  app.get("/work", async (c) => {
    await gate.promise;
    c.body = "ok";
  });
  const first = app.handle(new Request("http://x/work"));
  const second = app.handle(new Request("http://x/work")); // queued
  const third = await app.handle(new Request("http://x/work")); // queue full
  expect(third.status).toBe(529);
  expect(await third.text()).toBe("busy:concurrency");
  expect(third.headers.get("x-own")).toBe("1");
  expect(third.headers.get("connection")).toBeNull(); // verbatim: no injected headers
  const timedOut = await second;
  expect(await timedOut.text()).toBe("busy:queue");
  gate.resolve();
  await first;
  await app.close({ drain: 100 });
  expect(await (await app.handle(new Request("http://x/work"))).text()).toBe("busy:draining");
  expect(reasons).toEqual(["concurrency", "queue", "draining"]);
});

it("REVIEW-CT-22: §2.2 — a THROWING handler falls back to the built-in shape (loudly)", async () => {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const app = new Keala({
      env: "test",
      overload: {
        maxConcurrency: 1,
        handler: () => {
          throw new Error("handler bug");
        },
      },
    });
    const gate = deferred();
    app.get("/work", async (c) => {
      await gate.promise;
      c.body = "ok";
    });
    const first = app.handle(new Request("http://x/work"));
    const r = await app.handle(new Request("http://x/work"));
    expect(r.status).toBe(503);
    expect(r.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(r.headers.get("connection")).toBe("close");
    expect(r.headers.get("retry-after")).toBe("1");
    expect(await r.text()).toBe("Service Unavailable");
    expect(errorSpy).toHaveBeenCalled();
    gate.resolve();
    await first;
  } finally {
    errorSpy.mockRestore();
  }
});

it("REVIEW-CT-23: §2.3 — a queued request leaves exactly once: drain-drop wins, the armed timeout stays inert", async () => {
  const watcher = unhandledWatch();
  try {
    const app = new Keala({
      env: "test",
      overload: { maxConcurrency: 1, maxQueue: 1, queueTimeoutMs: 25 },
    });
    const gate = deferred();
    app.get("/work", async (c) => {
      await gate.promise;
      c.body = "done";
    });
    const first = app.handle(new Request("http://x/work"));
    const queued = app.handle(new Request("http://x/work"));
    await wait(5);
    const closing = app.close({ drain: 2000 });
    const dropped = await queued;
    expect(dropped.status).toBe(503);
    expect(dropped.headers.get("retry-after")).toBeNull();
    expect(app.inFlight).toBe(1);
    await wait(90); // the waiter's 25ms timeout fires into the settled guard
    expect(app.inFlight).toBe(1);
    gate.resolve();
    await (await first).text();
    await expect(closing).resolves.toEqual({ timedOut: false, inFlight: 0 });
    expect(watcher.hits).toEqual([]);
  } finally {
    watcher.stop();
  }
});

it("REVIEW-CT-24: §2.3 — a queued request whose client disconnects leaves once and frees the queue slot", async () => {
  const app = new Keala({
    env: "test",
    overload: { maxConcurrency: 1, maxQueue: 1, queueTimeoutMs: 5000 },
  });
  const gate = deferred();
  app.get("/work", async (c) => {
    await gate.promise;
    c.body = "done";
  });
  const first = app.handle(new Request("http://x/work"));
  const abort = new AbortController();
  const queued = app.handle(new Request("http://x/work", { signal: abort.signal }));
  await wait(10);
  abort.abort();
  expect((await queued).status).toBe(503);
  const third = app.handle(new Request("http://x/work")); // takes the freed queue slot
  await wait(10);
  gate.resolve();
  expect((await first).status).toBe(200);
  expect((await third).status).toBe(200);
  expect(app.inFlight).toBe(0);
});

it("REVIEW-CT-25: §2.2 invariant — the rejection path has NO Context, no mapper, no counter touch", async () => {
  const app = new Keala({ env: "test", overload: { maxConcurrency: 1 } });
  const middleware = vi.fn(async (_c: unknown, next: () => Promise<void>) => next());
  const mapper = vi.fn();
  app.use(middleware as never);
  app.onError(mapper);
  const gate = deferred();
  app.get("/work", async (c) => {
    await gate.promise;
    c.body = "ok";
  });
  const first = app.handle(new Request("http://x/work"));
  await wait(10); // the ADMITTED request legitimately runs the middleware
  middleware.mockClear();
  expect((await app.handle(new Request("http://x/work"))).status).toBe(503);
  expect(middleware).not.toHaveBeenCalled(); // the refusal built NO Context
  expect(mapper).not.toHaveBeenCalled();
  expect(app.inFlight).toBe(1);
  gate.resolve();
  await first;
});

it("REVIEW-CT-26: §2.2 r1 — draining refusals also precede Context (unconfigured app)", async () => {
  const app = new Keala({ env: "test" });
  const middleware = vi.fn(async (_c: unknown, next: () => Promise<void>) => next());
  const mapper = vi.fn();
  app.use(middleware as never);
  app.onError(mapper);
  app.get("/x", (c) => { c.body = "x"; });
  await app.close({ drain: 100 });
  const r = await app.handle(new Request("http://x/x"));
  expect(r.status).toBe(503);
  expect(r.headers.get("connection")).toBe("close");
  expect(r.headers.get("retry-after")).toBeNull();
  expect(await r.text()).toBe("Service Unavailable");
  expect(middleware).not.toHaveBeenCalled();
  expect(mapper).not.toHaveBeenCalled();
  expect(app.inFlight).toBe(0);
});

it("REVIEW-CT-27: §2.1 — c.signal is lazy, stable per request, and replays a client disconnect (AbortError)", async () => {
  const app = new Keala({ env: "test" });
  let observed: AbortSignal | undefined;
  let first: AbortSignal | undefined;
  app.get("/watch", async (c) => {
    first = c.signal;
    await wait(60);
    observed = c.signal;
  });
  const abort = new AbortController();
  const inflight = app.handle(new Request("http://x/watch", { signal: abort.signal }));
  await wait(15);
  abort.abort();
  await inflight;
  expect(observed).toBe(first); // one controller per request (stable identity)
  expect(observed!.aborted).toBe(true); // late materialization replays the disconnect
  expect((observed!.reason as DOMException).name).toBe("AbortError");
});

it("REVIEW-CT-28: §2.2 — the deadline aborts c.signal with TimeoutError, exactly once (first reason wins)", async () => {
  const app = new Keala({ env: "test", requestTimeout: 40 });
  const abort = new AbortController();
  let fires = 0;
  let reason: unknown;
  app.get("/stuck", async (c) => {
    const signal = c.signal;
    signal.addEventListener("abort", () => fires++);
    await wait(150);
    reason = signal.reason;
  });
  const inflight = app.handle(new Request("http://x/stuck", { signal: abort.signal }));
  await wait(70);
  abort.abort(); // client leaves AFTER the deadline — must not re-fire
  expect((await inflight).status).toBe(504);
  await wait(100); // the zombie records its observation
  expect(fires).toBe(1);
  expect((reason as DOMException).name).toBe("TimeoutError");
});

it("REVIEW-CT-29: §2.2 — materializing c.signal AFTER the deadline still yields an aborted signal", async () => {
  const app = new Keala({ env: "test", requestTimeout: 40 });
  const recorded = deferred<void>();
  let sawAborted: boolean | undefined;
  let reasonName: string | undefined;
  app.get("/z", async (c) => {
    await wait(80); // 504 already answered by the race
    const signal = c.signal; // FIRST materialization happens now
    sawAborted = signal.aborted;
    reasonName = (signal.reason as DOMException).name;
    recorded.resolve();
  });
  expect((await app.handle(new Request("http://x/z"))).status).toBe(504);
  await recorded.promise;
  expect(sawAborted).toBe(true);
  expect(reasonName).toBe("TimeoutError");
});

it("REVIEW-CT-30: §2.2 — the 504 goes through the error funnel: mapper restyles it, exactly once", async () => {
  let mapperCalls = 0;
  const app = new Keala({ env: "test", requestTimeout: 40 });
  app.onError((error) => {
    mapperCalls++;
    expect(error.status).toBe(504);
    return new Response(`late:${error.message}`, { status: 503, headers: { "x-funnel": "1" } });
  });
  const gate = deferred();
  app.get("/z", async () => gate.promise.then(() => undefined));
  const dead = await app.handle(new Request("http://x/z"));
  expect(dead.status).toBe(503);
  expect(dead.headers.get("x-funnel")).toBe("1");
  expect(await dead.text()).toBe("late:request deadline exceeded");
  gate.resolve(); // the zombie settles — the funnel must NOT run again
  await wait(20);
  expect(mapperCalls).toBe(1);
});

it("REVIEW-CT-31: §2.2 r1 — the 504 frees the slot at once; the zombie's late settle releases nothing twice", async () => {
  const app = new Keala({
    env: "test",
    requestTimeout: 30,
    overload: { maxConcurrency: 1, maxQueue: 1 },
  });
  const gate = deferred();
  let started = 0;
  app.get("/work", async (c) => {
    started++;
    if (started === 1) await gate.promise; // the zombie-to-be parks
    c.body = started === 1 ? "zombie" : `done-${started}`;
  });
  const first = app.handle(new Request("http://x/work")); // admitted, parks
  const second = app.handle(new Request("http://x/work")); // queued
  expect((await first).status).toBe(504);
  expect(await (await second).text()).toBe("done-2"); // slot transferred at 504 time
  gate.resolve(); // zombie settles LATE
  await wait(20);
  expect(app.inFlight).toBe(0); // never -1: exactly one release per admission
});

it("REVIEW-CT-32: §2.2 invariant — a deadline-504 Context is never recycled into the pool", async () => {
  const controlApp = new Keala({ env: "test", pooling: true });
  let controlCtx: Context | undefined;
  controlApp.get("/n", (c) => ((controlCtx = c), new Response(null)));
  await controlApp.handle(new Request("http://x/n"));
  expect(() => ((controlCtx as Context).body = "late")).toThrow(/retired/); // guard active

  const app = new Keala({ env: "test", pooling: true, requestTimeout: 40 });
  const gate = deferred();
  let zombieCtx: Context | undefined;
  app.get("/z", async (c) => {
    zombieCtx = c;
    await gate.promise;
    return new Response(null);
  });
  expect((await app.handle(new Request("http://x/z"))).status).toBe(504);
  gate.resolve(); // the zombie settles — its context must go to GC, not the pool
  await wait(20);
  expect(() => ((zombieCtx as Context).body = "late-write")).not.toThrow();
});

it("REVIEW-CT-33: §2.2 invariant — a REJECTING strategy is contained to the built-in 503", async () => {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const watcher = unhandledWatch();
  try {
    const app = new Keala({
      env: "test",
      overload: {
        maxConcurrency: 1,
        strategy: { onSaturated: () => Promise.reject(new Error("strategy bug")) },
      },
    });
    const gate = deferred();
    app.get("/work", async (c) => {
      await gate.promise;
      c.body = "ok";
    });
    const first = app.handle(new Request("http://x/work"));
    const r = await app.handle(new Request("http://x/work"));
    expect(r.status).toBe(503);
    expect(r.headers.get("connection")).toBe("close");
    expect(await r.text()).toBe("Service Unavailable");
    gate.resolve();
    await first;
    await wait(20);
    expect(watcher.hits).toEqual([]);
  } finally {
    watcher.stop();
    errorSpy.mockRestore();
  }
});

it("REVIEW-CT-34: §2.2 invariant — a SYNC-THROWING strategy must not take the gate down (handle resolves)", async () => {
  const app = new Keala({
    env: "test",
    overload: {
      maxConcurrency: 1,
      strategy: {
        onSaturated: () => {
          throw new Error("sync strategy bug");
        },
      },
    },
  });
  const gate = deferred();
  app.get("/work", async (c) => {
    await gate.promise;
    c.body = "ok";
  });
  const first = app.handle(new Request("http://x/work"));
  await wait(10);
  let threw: unknown;
  let res: Response | undefined;
  try {
    res = await app.handle(new Request("http://x/work"));
  } catch (error) {
    threw = error; // handle() must neither reject NOR throw synchronously
  }
  expect(threw).toBeUndefined();
  expect(res?.status).toBe(503);
  gate.resolve();
  await first;
});

it("REVIEW-CT-35: §4 U1 — strategy null (sync AND async) admits through the gate with a real slot", async () => {
  const sync = new Keala({
    env: "test",
    overload: { maxConcurrency: 1, strategy: { onSaturated: () => null } },
  });
  const gateA = deferred();
  sync.get("/w", async (c) => {
    await gateA.promise;
    c.body = "a";
  });
  const first = sync.handle(new Request("http://x/w"));
  const second = sync.handle(new Request("http://x/w"));
  await wait(10);
  expect(sync.inFlight).toBe(2); // the core admitted the untaken null — real slots
  gateA.resolve();
  expect((await first).status).toBe(200);
  expect((await second).status).toBe(200);
  expect(sync.inFlight).toBe(0);

  const asyncApp = new Keala({
    env: "test",
    overload: { maxConcurrency: 1, strategy: { onSaturated: () => wait(15).then(() => null) } },
  });
  const gateB = deferred();
  asyncApp.get("/w", async (c) => {
    await gateB.promise;
    c.body = "b";
  });
  const firstB = asyncApp.handle(new Request("http://x/w"));
  const secondB = asyncApp.handle(new Request("http://x/w"));
  await wait(50);
  expect(asyncApp.inFlight).toBe(2); // no phantom release
  gateB.resolve();
  expect((await firstB).status).toBe(200);
  expect((await secondB).status).toBe(200);
  expect(asyncApp.inFlight).toBe(0);
});

it("REVIEW-CT-36: §4 U1 — admit() takes exactly one slot at the moment of capacity", async () => {
  const app = new Keala({
    env: "test",
    overload: {
      maxConcurrency: 1,
      strategy: {
        onSaturated: (_state, _request, admit) => (admit(), null), // sync grab AND null
      },
    },
  });
  const gate = deferred();
  app.get("/w", async (c) => {
    await gate.promise;
    c.body = "ok";
  });
  const first = app.handle(new Request("http://x/w"));
  const second = app.handle(new Request("http://x/w"));
  await wait(10);
  expect(app.inFlight).toBe(2); // 1 parked + exactly 1 strategy slot
  gate.resolve();
  expect((await first).status).toBe(200);
  expect((await second).status).toBe(200);
  expect(app.inFlight).toBe(0);
});

it("REVIEW-CT-37: §4 U1/P3 — a null resolving DURING drain: untaken is refused (draining), a taken slot is served", async () => {
  const refuser = new Keala({
    env: "test",
    overload: { maxConcurrency: 1, strategy: { onSaturated: () => wait(50).then(() => null) } },
  });
  const gate = deferred();
  refuser.get("/w", async (c) => {
    await gate.promise;
    c.body = "a";
  });
  const first = refuser.handle(new Request("http://x/w"));
  await wait(10);
  const second = refuser.handle(new Request("http://x/w")); // strategy pending
  await wait(10);
  const closing = refuser.close({ drain: 2000 }); // drain begins mid-wait
  const outcome = await second;
  expect(outcome.status).toBe(503);
  expect(outcome.headers.get("retry-after")).toBeNull(); // draining: omitted
  gate.resolve();
  await (await first).text();
  await closing;

  const served = new Keala({
    env: "test",
    overload: {
      maxConcurrency: 1,
      strategy: {
        onSaturated: (_state, _request, admit) => (admit(), wait(50).then(() => null)),
      },
    },
  });
  const gate2 = deferred();
  let started = 0;
  served.get("/w", async (c) => {
    started++;
    if (started === 1) await gate2.promise; // only the FIRST parks
    c.body = "b";
  });
  const firstB = served.handle(new Request("http://x/w"));
  await wait(10);
  const secondB = served.handle(new Request("http://x/w")); // takes a slot NOW
  await wait(10);
  expect(served.inFlight).toBe(2);
  const closingB = served.close({ drain: 2000 });
  const resB = await secondB;
  expect(resB.status).toBe(200); // the slot was held before drain: served
  await resB.text();
  gate2.resolve();
  await (await firstB).text();
  await closingB;
  expect(served.inFlight).toBe(0);
});

it("REVIEW-CT-38: §4 U1 — an injected queueAdmission is byte-equal to the implicit maxQueue selection", async () => {
  const run = async (strategy?: { onSaturated: unknown }): Promise<string[]> => {
    const app = new Keala({
      env: "test",
      overload: {
        maxConcurrency: 1,
        maxQueue: 2,
        ...(strategy === undefined ? {} : { strategy: strategy as never }),
      },
    });
    const order: string[] = [];
    const gates = [deferred(), deferred(), deferred()];
    app.get("/work/:id", async (c) => {
      const id = c.params?.["id"] ?? "?";
      order.push(`start:${id}`);
      await (gates[Number(id)] ?? gates[0]!).promise;
      order.push(`end:${id}`);
    });
    const handles = [0, 1, 2].map((i) => app.handle(new Request(`http://x/work/${i}`)));
    await wait(10);
    gates[0]!.resolve();
    await wait(10);
    gates[1]!.resolve();
    gates[2]!.resolve();
    await Promise.all(handles);
    expect(app.inFlight).toBe(0);
    return order;
  };
  const implicit = await run();
  expect(await run({ onSaturated: queueAdmission.onSaturated })).toEqual(implicit);
  expect(implicit).toEqual(["start:0", "end:0", "start:1", "end:1", "start:2", "end:2"]);
});

it("REVIEW-CT-39: §6 C1 — the admission gate covers the NODE native path; the built-in rejection keeps its wire shape", async () => {
  const app = new Keala({ env: "test", overload: { maxConcurrency: 1 } });
  const gate = deferred();
  app.get("/work", async (c) => {
    await gate.promise;
    c.body = "served";
  });
  const server = await startNodeServer(app, { port: 0, hostname: "127.0.0.1" }).ready();
  liveServers.push(server);
  const first = fetch(`http://127.0.0.1:${server.port}/work`).then(
    (r) => `ok:${r.status}`,
    () => "reset",
  );
  await wait(40);
  expect(app.inFlight).toBe(1); // native request admitted through C1
  const second = await fetch(`http://127.0.0.1:${server.port}/work`);
  expect(second.status).toBe(503); // native request REFUSED through C1
  expect(second.headers.get("connection")).toBe("close"); // on the WIRE
  expect(second.headers.get("retry-after")).toBe("1");
  expect(await second.text()).toBe("Service Unavailable");
  gate.resolve();
  expect(await first).toBe("ok:200");
  expect(app.inFlight).toBe(0);
});

it("REVIEW-CT-39b: §4 U1/P3 — a native-source strategy call sees a materialized fetch Request; its Response goes out verbatim", async () => {
  const seen: Array<{ isRequest: boolean; url: string }> = [];
  const app = new Keala({
    env: "test",
    overload: {
      maxConcurrency: 1,
      strategy: {
        onSaturated: (_state, request) => {
          seen.push({ isRequest: request instanceof Request, url: request.url });
          return new Response("native-refused", { status: 503 });
        },
      },
    },
  });
  const gate = deferred();
  app.get("/work", async (c) => {
    await gate.promise;
    c.body = "served";
  });
  const server = await startNodeServer(app, { port: 0, hostname: "127.0.0.1" }).ready();
  liveServers.push(server);
  const first = fetch(`http://127.0.0.1:${server.port}/work`).then(
    (r) => `ok:${r.status}`,
    () => "reset",
  );
  await wait(40);
  const second = await fetch(`http://127.0.0.1:${server.port}/work`);
  expect(second.status).toBe(503);
  expect(await second.text()).toBe("native-refused"); // custom refusal, verbatim
  expect(seen).toEqual([{ isRequest: true, url: `http://127.0.0.1:${server.port}/work` }]);
  gate.resolve();
  expect(await first).toBe("ok:200");
  expect(app.inFlight).toBe(0);
});

it("REVIEW-CT-40: §2.1/r9 — first signal drains (default window), second force-closes, never process.exit", async () => {
  const registered: Array<[string, () => void]> = [];
  // The bridge registers PERMANENT listeners via process.on (REVIEW-BUG-1
  // fix): once-listeners consumed themselves and let a repeated same-name
  // signal fall to the OS default disposition.
  const realOn = process.on.bind(process);
  const onSpy = vi.spyOn(process, "on").mockImplementation(
    ((event: string | symbol, handler: (...args: unknown[]) => void) => {
      if (typeof event === "string" && typeof handler === "function")
        registered.push([event, handler as () => void]);
      return realOn(event, handler as never) as typeof process;
    }) as unknown as typeof process.on,
  );
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => {
      throw new Error("the bridge must never process.exit()");
    }) as never);
  const gate = deferred();
  try {
    const app = new Keala({ env: "test" });
    app.get("/stuck", async (c) => {
      await gate.promise;
      c.body = "done";
    });
    const inflight = app.handle(new Request("http://x/stuck"));
    await wait(10);
    installSignalBridge(app);
    expect(registered.map(([e]) => e).toSorted()).toEqual(["SIGINT", "SIGTERM"]);
    const handler = registered[0]![1];
    handler(); // FIRST signal: close() with the default window
    expect(app.isDraining()).toBe(true);
    const closing = app.close(); // the very promise the bridge holds
    expect(await state(closing, 40)).toBe("pending"); // default window, not drain:0
    handler(); // SECOND signal: close({drain: 0}) → force
    await expect(closing).resolves.toEqual({ timedOut: true, inFlight: 1 });
    expect(exit).not.toHaveBeenCalled();
    gate.resolve();
    await inflight;
  } finally {
    exit.mockRestore();
    onSpy.mockRestore();
    gate.resolve();
  }
});

it("REVIEW-CT-41: §2.2 r9 — escalation flows through the adapter contract (stopGraceful + registerForce)", async () => {
  const app = new Keala({ env: "test" });
  const { impl, stopCalls } = fakeGracefulServe();
  startBunServer(app, { port: 0 }, undefined, impl);
  const gate = deferred();
  app.get("/park", async (c) => {
    await gate.promise;
    c.body = "done";
  });
  const inflight = app.handle(new Request("http://x/park"));
  await wait(10);
  const closing = app.close({ drain: 5000 });
  expect(await state(closing, 50)).toBe("pending");
  expect(stopCalls()).toEqual([undefined]); // stopped accepting, no force yet
  await app.close({ drain: 0 }); // operator escalates
  await expect(closing).resolves.toEqual({ timedOut: true, inFlight: 1 });
  // stop(undefined) at drain start; then TWO force stops — the adapter's
  // registerForce routine and the core's finish(true) both force (idempotent).
  expect(stopCalls()).toEqual([undefined, true, true]);
  gate.resolve();
  await (await inflight).text();
});

it("REVIEW-CT-42 (control): §2.2 r9 — SIGTERM then SIGINT force-closes the running drain", async () => {
  const { status } = await bridgeChildClose(["SIGTERM", "SIGINT"]);
  expect(status).not.toBeNull();
  expect(status?.timedOut).toBe(true); // second signal = force
});

it("REVIEW-CT-43: §2.1/§2.2 r9 — a REAL second same-name signal (SIGTERM, SIGTERM) force-closes", async () => {
  const { status, exitBySecondSignal } = await bridgeChildClose(["SIGTERM", "SIGTERM"]);
  // Expected: the bridge sees the second signal → close({drain:0}) → the
  // running close resolves {timedOut:true}. The diff shows what actually
  // happened: status null = the close never resolved; exitBySecondSignal
  // true = the OS-default disposition killed the child instead.
  expect(status?.timedOut).toBe(true);
  expect(exitBySecondSignal).toBe(false);
});
