/**
 * Regression lock for the 0.6.2 HA/lifecycle review fixes:
 *  HA-1  an async handler settling before its floated next() registers the
 *        branch (pooling never recycles a context under a live branch), while
 *        the idiomatic `return next()` shape must NOT defer retirement —
 *        REVIEW-HA-7's soak caught the deferred release losing the
 *        retire-before-consumer-returns race.
 *  HA-3  startNodeServer refuses a second server for the same app.
 *  HA-4  close() caps each onShutdown hook (shutdownTimeout), later hooks
 *        still run, and 0 restores the wait-indefinitely contract.
 *  BUG-4 the direct() fast chain guards double next() like makeLevel.
 *  PERF-7 the deadline race consumes (cancels) a zombie's late Response body
 *        instead of dropping it unconsumed.
 */

import { describe, expect, it } from "vitest";

import { Keala } from "../../src/core/app.ts";
import { startNodeServer } from "../../src/adapters/node.ts";
import type { CloseOptions } from "../../src/types.ts";

const quiet = { env: "test" } as const;
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Externally resolvable void promise (hung-hook coordination). */
const deferred = (): { promise: Promise<void>; release: () => void } => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

describe("HA-1: floating-branch registration under pooling", () => {
  it("an async handler settling before its floated next() never leaks into the next request", async () => {
    const app = new Keala({ ...quiet, pooling: true });
    app.get(
      "/a",
      async (_c, next) => {
        void next().catch(() => undefined);
        await wait(5);
      },
      async (c) => {
        await wait(60); // late: /a already answered, its context retired-pending
        // U3c: the body setter is gone — probe the late write through a
        // surviving mutation path. On the retired context this throws (the
        // floated branch keeps the context out of the pool, so it can never
        // land on /victim's response either way).
        c.setHeader("X-Branch", "A-SECRET");
      },
    );
    app.get("/victim", (c) => c.text("VICTIM"));
    const first = app.handle(new Request("http://x/a"));
    await wait(15); // /a settles, its branch is still running
    const victim = await app.handle(new Request("http://x/victim"));
    expect(await victim.text()).toBe("VICTIM");
    expect(victim.headers.get("x-branch")).toBeNull(); // never leaked
    expect((await first).status).toBe(404); // the floated route never committed
  });

  it("`return next()` retires the context by the time the consumer resolves (no deferred release)", async () => {
    const app = new Keala({ ...quiet, pooling: true });
    const held: unknown[] = [];
    app.use((c, next) => {
      held.push(c);
      return next();
    });
    app.get("/a", async (c) => {
      await wait(5);
      return c.text("a");
    });
    const response = await app.handle(new Request("http://x/a"));
    await response.text();
    // The soak contract: the last-consumed response's context is retired
    // already — writing it throws without yielding to another turn.
    const retired = held[held.length - 1] as unknown as { status: number };
    expect(() => {
      retired.status = 500;
    }).toThrow(/retired/);
  });
});

describe("HA-3: Node adapter double-start guard", () => {
  it("a second startNodeServer for the same app refuses with app.listen()'s wording", async () => {
    const app = new Keala(quiet);
    app.get("/", (c) => c.text("ok"));
    const first = startNodeServer(app, { port: 0, hostname: "127.0.0.1" });
    try {
      await first.ready();
      expect(() => startNodeServer(app, { port: 0, hostname: "127.0.0.1" })).toThrow(
        "app.listen() called twice — stop()/close() the first server",
      );
    } finally {
      first.stop(true);
    }
  });
});

describe("HA-4: shutdown hook cap (shutdownTimeout)", () => {
  it("a hung hook is cut off, logged, and later hooks still run", async () => {
    const app = new Keala(quiet);
    const hung = deferred();
    app.onShutdown(() => hung.promise);
    let secondRan = false;
    app.onShutdown(() => {
      secondRan = true;
      return Promise.reject(new Error("late failure is contained"));
    });
    const status = await app.close({
      drain: 0,
      shutdownTimeout: 40,
    } as CloseOptions);
    expect(status).toEqual({ timedOut: false, inFlight: 0 });
    expect(secondRan).toBe(true);
    hung.release();
  });

  it("shutdownTimeout: 0 waits indefinitely (the pre-cap contract)", async () => {
    const app = new Keala(quiet);
    const hung = deferred();
    app.onShutdown(() => hung.promise);
    const closed = app.close({ drain: 0, shutdownTimeout: 0 } as CloseOptions);
    let state = "pending";
    void closed.then(() => {
      state = "resolved";
    });
    await wait(120);
    expect(state).toBe("pending"); // 0 = no cap: the hook decides
    hung.release();
    expect(await closed).toEqual({ timedOut: false, inFlight: 0 });
  });

  it("an invalid shutdownTimeout refuses loudly", () => {
    const app = new Keala(quiet);
    // The validation lives in closeApp before the promise is built, so the
    // refusal is a synchronous throw through app.close().
    expect(() => app.close({ drain: 0, shutdownTimeout: -1 } as CloseOptions)).toThrow(TypeError);
    expect(() => app.close({ drain: 0, shutdownTimeout: Number.NaN } as CloseOptions)).toThrow(
      TypeError,
    );
  });
});

describe("BUG-4: direct() double-next guard", () => {
  it("a single-handler route calling next() twice fails like a composed chain", async () => {
    const app = new Keala({ env: "test" });
    let caught: unknown;
    app.get("/y", (_c, next) => {
      try {
        void next();
        next(); // the second call must fail like makeLevel's guard
      } catch (error) {
        caught = error;
      }
      return undefined;
    });
    const res = await app.handle(new Request("http://x/y"));
    expect((caught as Error)?.message).toBe("next() called multiple times in the same middleware");
    expect(res.status).toBe(404); // no throw escaped; nothing committed
  });
});

describe("PERF-7: zombie Response bodies are consumed after the deadline", () => {
  it("a late-settling handler's Response body is cancelled, not dropped unread", async () => {
    let cancelled: unknown = null;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("late"));
        controller.close();
      },
      cancel(reason) {
        cancelled = reason;
      },
    });
    const app = new Keala({ ...quiet, requestTimeout: 15 });
    app.get("/slow", async () => {
      await wait(70); // the deadline answers first
      return new Response(body);
    });
    const res = await app.handle(new Request("http://x/slow"));
    expect(res.status).toBe(504);
    await wait(120); // the zombie settles late
    expect(cancelled).not.toBe(null); // the dropped body was consumed
  });
});
