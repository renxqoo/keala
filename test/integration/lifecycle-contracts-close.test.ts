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
import { Keala } from "../../src/core/app.ts";
import { startNodeServer, type NodeServerHandle } from "../../src/adapters/node.ts";

const deferred = <T = void>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((res) => (resolve = res)), resolve };
};
const wait = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));
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

it("REVIEW-CT-1: §2.1 CloseStatus shape; isDraining one-way (true forever after close)", async () => {
  const app = new Keala({ env: "test" });
  app.get("/x", (c) => {
    return c.text("x");
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
    return c.text("x");
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
    return c.text("done");
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
    return c.text("done");
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
    return c.text("done");
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
    return c.text("done");
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
    return c.text("done");
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
    return c.text("done");
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
    order.push("request-done");
    return c.text("done");
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
