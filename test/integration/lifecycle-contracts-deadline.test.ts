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
import { type NodeServerHandle } from "../../src/adapters/node.ts";
import { type ServeImplementation } from "../../src/adapters/bun.ts";
import type { Context } from "../../src/core/context/context.ts";

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
