/* eslint-disable max-lines -- one review file per the task mandate (44 contract probes; agent is restricted to this single file) */
/**
 * R4.6 CONTRACT review — docs/HOTPATH-R4-6-LIFECYCLE-DESIGN.md §2.1/§2.2/§2.3/
 * §4 (U1-U3, AdmissionStrategy)/§6 (slots) + MIGRATION §4 vs implementation.
 * One rule per test (REVIEW-CT-n): FAILING = confirmed contract violation
 * (rule cited in the name); PASSING = contract holds (kept as a lock).
 * Helper style mirrors test/r4-lifecycle-overload.test.ts.
 */
import { afterAll, expect, it } from "vitest";
import net from "node:net";
import { spawn } from "node:child_process";
import { Keala } from "../../src/core/app.ts";
import { startNodeServer, type NodeServerHandle } from "../../src/adapters/node.ts";
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

it("REVIEW-CT-1: §2.1 CloseStatus shape; isDraining one-way (true forever after close)", async () => {
  const app = new Keala({ env: "test" });
  app.get("/x", (c) => {
    c.body = "x";
  });
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
  app.get("/x", (c) => {
    c.body = "x";
  });
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
