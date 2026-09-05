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
import { installSignalBridge } from "../../src/core/lifecycle.ts";
import { queueAdmission } from "../../src/core/lifecycle-admission.ts";
import { startNodeServer, type NodeServerHandle } from "../../src/adapters/node.ts";
import { startBunServer, type ServeImplementation } from "../../src/adapters/bun.ts";

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
export const unhandledWatch = (): { hits: unknown[]; stop: () => void } => {
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
const fakeGracefulServe = (): {
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
const bridgeChildClose = async (
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
  // R4.10 hard ceiling: the late async null lands while firstB still holds
  // the only slot, so it REFUSES (503) instead of admitting over
  // maxConcurrency. The SYNC null half above (secondA) still admits and
  // holds a real slot — no phantom release either way.
  expect(asyncApp.inFlight).toBe(1);
  gateB.resolve();
  expect((await firstB).status).toBe(200);
  expect((await secondB).status).toBe(503);
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
      const id = c.params("id") ?? "?";
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

it.skipIf(typeof Bun !== "undefined")(
  "REVIEW-CT-39: §6 C1 — the admission gate covers the NODE native path; the built-in rejection keeps its wire shape",
  async () => {
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
  },
);

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
  const onSpy = vi.spyOn(process, "on").mockImplementation(((
    event: string | symbol,
    handler: (...args: unknown[]) => void,
  ) => {
    if (typeof event === "string" && typeof handler === "function")
      registered.push([event, handler as () => void]);
    return realOn(event, handler as never) as typeof process;
  }) as unknown as typeof process.on);
  const exit = vi.spyOn(process, "exit").mockImplementation((() => {
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
