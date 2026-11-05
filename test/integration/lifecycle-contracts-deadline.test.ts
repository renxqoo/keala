/* eslint-disable max-lines -- one review file per the task mandate (44 contract probes; agent is restricted to this single file) */
/**
 * R4.6 CONTRACT review — docs/HOTPATH-R4-6-LIFECYCLE-DESIGN.md §2.1/§2.2/§2.3/
 * §4 (U1-U3, AdmissionStrategy)/§6 (slots) + MIGRATION §4 vs implementation.
 * One rule per test (REVIEW-CT-n): FAILING = confirmed contract violation
 * (rule cited in the name); PASSING = contract holds (kept as a lock).
 * Helper style mirrors test/r4-lifecycle-overload.test.ts.
 */
import { expect, it, vi } from "vitest";
import { Keala } from "../../src/core/app.ts";

const deferred = <T = void>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((res) => (resolve = res)), resolve };
};
const wait = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));
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
    return c.text(started === 1 ? "zombie" : `done-${started}`);
  });
  const first = app.handle(new Request("http://x/work")); // admitted, parks
  const second = app.handle(new Request("http://x/work")); // queued
  expect((await first).status).toBe(504);
  expect(await (await second).text()).toBe("done-2"); // slot transferred at 504 time
  gate.resolve(); // zombie settles LATE
  await wait(20);
  expect(app.inFlight).toBe(0); // never -1: exactly one release per admission
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
      return c.text("ok");
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
    return c.text("ok");
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
