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
import { Keala } from "../../src/core/app.ts";
import {
  failFastAdmission,
  normalizeOverload,
  queueAdmission,
} from "../../src/core/lifecycle-admission.ts";
import { type NodeServerHandle } from "../../src/adapters/node.ts";
import { type ServeImplementation } from "../../src/adapters/bun.ts";

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
export const state = (p: Promise<unknown>, ms: number): Promise<"resolved" | "pending"> =>
  Promise.race([p.then(() => "resolved" as const), wait(ms).then(() => "pending" as const)]);

const liveServers: NodeServerHandle[] = [];
afterAll(() => {
  for (const s of liveServers) s.stop(true);
});

/** True when the port refuses new TCP connections (the listener is dead). */
export const refusedPort = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1");
    sock.once(
      "error",
      (e: NodeJS.ErrnoException) => (sock.destroy(), resolve(e.code === "ECONNREFUSED")),
    );
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
export const fakeGracefulServe = (): {
  impl: ServeImplementation;
  stopCalls: () => Array<boolean | undefined>;
} => {
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
        if (grace.drain !== Number.POSITIVE_INFINITY)
          timer = setTimeout(() => finish(true), grace.drain);
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
export const bridgeChildClose = async (
  signals: readonly [NodeJS.Signals, NodeJS.Signals],
): Promise<{ status: { timedOut: boolean } | null; exitBySecondSignal: boolean }> => {
  const appUrl = new URL("../../src/core/app.ts", import.meta.url).href;
  const nodeUrl = new URL("../../src/adapters/node.ts", import.meta.url).href;
  const source = `
import { Keala } from ${JSON.stringify(appUrl)};
import { listen } from ${JSON.stringify(nodeUrl)};
const app = new Keala({ env: "test" });
app.get("/park", async (c) => {
  await new Promise((resolve) => setTimeout(resolve, 5000)); // outlives the probe
  return c.text("done");
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
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", source],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
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

it("REVIEW-CT-15: §2.1/§6 C1 — inFlight counts admitted-not-settled; queued requests are excluded", async () => {
  const plain = new Keala({ env: "test" });
  const gate = deferred();
  plain.get("/park", async (c) => {
    await gate.promise;
    return c.text("done");
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
    return c.text("done");
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
  expect(() =>
    normalizeOverload({ maxConcurrency: Number.POSITIVE_INFINITY, maxQueue: 1 }),
  ).toThrow(/finite/);
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
    expect(
      () => new Keala({ overload: { maxConcurrency: 1, maxQueue: 1, queueTimeoutMs: bad } }),
    ).toThrow(TypeError);
  for (const bad of [-1, 0.5])
    expect(() => new Keala({ overload: { maxConcurrency: 1, retryAfterSeconds: bad } })).toThrow(
      TypeError,
    );
  expect(() => new Keala({ overload: { maxConcurrency: 1, handler: "x" as never } })).toThrow(
    TypeError,
  );
  expect(() => new Keala({ overload: { maxConcurrency: 1, strategy: {} as never } })).toThrow(
    /onSaturated/,
  );
  expect(
    () => new Keala({ overload: { maxConcurrency: 1, strategy: { onSaturated: null } as never } }),
  ).toThrow(/onSaturated/);
  expect(
    () =>
      new Keala({ overload: { maxConcurrency: 1, retryAfterSeconds: 0, queueTimeoutMs: 5_000 } }),
  ).not.toThrow();
});

it("REVIEW-CT-18: §2.1 — requestTimeout 0/undefined = off; invalid values throw at construction", async () => {
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, "30000" as never])
    expect(() => new Keala({ requestTimeout: bad })).toThrow(TypeError);
  for (const off of [undefined, 0]) {
    const app = new Keala({ env: "test", requestTimeout: off });
    app.get("/slow", async (c) => {
      await wait(70);
      return c.text("fine");
    });
    expect((await app.handle(new Request("http://x/slow"))).status).toBe(200);
  }
});

it("REVIEW-CT-19: §2.2 — built-in rejection shape is exact (503, text/plain, connection: close, Retry-After, body)", async () => {
  const app = new Keala({ env: "test", overload: { maxConcurrency: 1 } });
  const gate = deferred();
  app.get("/work", async (c) => {
    await gate.promise;
    return c.text("ok");
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
    return c.text("ok");
  });
  const first = live.handle(new Request("http://x/w"));
  expect((await live.handle(new Request("http://x/w"))).headers.get("retry-after")).toBe("7");
  gate.resolve();
  await first;

  const zero = new Keala({ env: "test", overload: { maxConcurrency: 1, retryAfterSeconds: 0 } });
  const gate2 = deferred();
  zero.get("/w", async (c) => {
    await gate2.promise;
    return c.text("ok");
  });
  const first2 = zero.handle(new Request("http://x/w"));
  expect((await zero.handle(new Request("http://x/w"))).headers.get("retry-after")).toBeNull();
  gate2.resolve();
  await first2;

  for (const retryAfterSeconds of [undefined, 5]) {
    const app = new Keala({
      env: "test",
      overload: {
        maxConcurrency: 1,
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      },
    });
    app.get("/w", (c) => {
      return c.text("ok");
    });
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
    return c.text("ok");
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
      return c.text("ok");
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
      return c.text("done");
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
    return c.text("done");
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
    return c.text("ok");
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
  app.get("/x", (c) => {
    return c.text("x");
  });
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
