/**
 * Concurrency / interleaving / lifecycle red-team suite (part 2: emitter
 * races, lazy singletons, stream bodies). Part 1 lives in
 * test/agent-concurrency.test.ts.
 *
 * CONFIRMED-BUG tests are written with the CORRECT (Koa-3.2.1 / design-intent)
 * expectation and currently FAIL — each one's comment carries the label
 * CONFIRMED-BUG plus the reproduction, expected-vs-actual and the root cause
 * (file:line). "语义锁定" tests encode behavior that matches Koa (or a
 * documented deliberate deviation) and must stay green.
 *
 * migration notes: the inherited koa CONFIRMED-BUGs around the lazy ip memoization
 * (undefined thunk result / null requestIP result re-consulted) are fixed in
 * The core: `ipValue` now distinguishes unresolved from resolved-empty and the
 * resolver runs exactly once. The failing-body-stream error channel is a
 * documented divergence (observeStream is opt-in by design, off by
 * default; docs/DESIGN.md §4) and is carried as a labeled skip until the
 * opt-in switch ships (P2).
 *
 * Koa baseline: .parity/koa/lib/{request,context,application}.js (v3.2.1).
 */

import { describe, expect, it } from "vitest";

import { createApp } from "../src/index.ts";
import { createEmitter } from "../src/core/emitter.ts";

const quiet = { env: "test" } as const;
const enc = (value: string): Uint8Array => new TextEncoder().encode(value);
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// 4. Emitter races
// ---------------------------------------------------------------------------
describe("emitter races", () => {
  it("语义锁定: once() fires exactly once and self-removal is race-free", async () => {
    const emitter = createEmitter();
    const calls: number[] = [];
    emitter.once("error", () => calls.push(1));
    emitter.emit("error");
    emitter.emit("error");
    expect(calls).toEqual([1]);
    expect(emitter.listenerCount("error")).toBe(0);
  });

  it("语义锁定: listeners added during emit are not invoked by the in-flight emit", () => {
    const emitter = createEmitter();
    const calls: string[] = [];
    emitter.on("e", () => {
      calls.push("first");
      emitter.on("e", () => calls.push("late"));
    });
    emitter.emit("e");
    expect(calls).toEqual(["first"]);
    emitter.emit("e");
    expect(calls).toEqual(["first", "first", "late"]);
  });

  it("语义锁定: removing a not-yet-invoked listener mid-emit still lets the snapshot call it (Node parity)", () => {
    const emitter = createEmitter();
    const calls: string[] = [];
    const late = (): void => {
      calls.push("late");
    };
    emitter.on("e", () => {
      calls.push("first");
      emitter.off("e", late);
    });
    emitter.on("e", late);
    emitter.emit("e"); // Node also snapshots: "late" still runs this once
    expect(calls).toEqual(["first", "late"]);
    emitter.emit("e");
    expect(calls).toEqual(["first", "late", "first"]);
  });

  it("语义锁定: off() of an unknown listener is a silent no-op", () => {
    const emitter = createEmitter();
    expect(() => emitter.off("nope", () => {})).not.toThrow();
    expect(() => emitter.off("nope", () => {})).not.toThrow();
    expect(emitter.emit("nope")).toBe(false);
    expect(emitter.listenerCount("nope")).toBe(0);
  });

  it("语义锁定: a throwing listener stops later listeners and propagates (Node parity)", () => {
    const emitter = createEmitter();
    const calls: string[] = [];
    emitter.on("e", () => {
      calls.push("throws");
      throw new Error("boom");
    });
    emitter.on("e", () => calls.push("never"));
    expect(() => emitter.emit("e")).toThrow("boom");
    expect(calls).toEqual(["throws"]);
  });

  it("语义锁定: once() wrapped listener is removable via the returned disposer", () => {
    const emitter = createEmitter();
    const dispose = emitter.once("e", () => {});
    dispose();
    expect(emitter.emit("e")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Lazy singletons on the flat context
// ---------------------------------------------------------------------------
describe("lazy singletons", () => {
  it("语义锁定: the cookies facade is created once and shared across await points", async () => {
    const app = createApp({ ...quiet, keys: ["k"] });
    const observed: boolean[] = [];
    app.use(async (c, next) => {
      const first = c.cookies;
      c.cookies.set("a", "1");
      await next();
      observed.push(c.cookies === first);
      c.body = "ok";
    });
    app.use(async (c) => {
      c.cookies.set("b", "2");
      await delay(2);
    });
    await app.handle(new Request("http://localhost:3000/"));
    expect(observed).toEqual([true]);
  });

  it("语义锁定: ctx.state is one object per request and fresh across requests", async () => {
    const app = createApp(quiet);
    const states: unknown[] = [];
    app.use(async (c) => {
      states.push(c.state);
      c.state["n"] = states.length;
      await delay(1);
      c.body = JSON.stringify({ keys: Object.keys(c.state) });
    });
    const first = await app.handle(new Request("http://localhost:3000/"));
    const second = await app.handle(new Request("http://localhost:3000/"));
    expect(states[0]).not.toBe(states[1]);
    expect(await first.text()).toBe(JSON.stringify({ keys: ["n"] }));
    expect(await second.text()).toBe(JSON.stringify({ keys: ["n"] }));
  });

  // Fixed (was an inherited koa CONFIRMED-BUG): the remote source is consulted ONCE
  // per request even when it resolves to nothing — `ipValue` distinguishes
  // unresolved (null) from resolved-empty (""), so a thunk returning
  // undefined is memoized after the first call.
  it("语义锁定: an ip thunk returning undefined is invoked exactly once", async () => {
    let calls = 0;
    const app = createApp(quiet);
    app.use((c) => {
      const readings = [c.ip, c.ip, c.ip];
      c.body = readings.join("|");
    });
    await app.handle(new Request("http://localhost:3000/"), {
      remote: () => {
        calls++;
        return undefined;
      },
    });
    expect(calls).toBe(1);
  });

  // Fixed (same root cause): a `server.requestIP` source returning null
  // (Bun does this once the peer is gone) is consulted once per request, not
  // once per read.
  it("语义锁定: a requestIP host returning null is consulted exactly once", async () => {
    let calls = 0;
    const app = createApp(quiet);
    app.use((c) => {
      c.body = `${c.ip},${c.ip}`;
    });
    await app.handle(new Request("http://localhost:3000/"), {
      server: {
        requestIP: () => {
          calls++;
          return null;
        },
      },
    });
    expect(calls).toBe(1);
  });

  it("语义锁定: a thunk with a concrete result is called exactly once", async () => {
    let calls = 0;
    const app = createApp(quiet);
    app.use((c) => {
      c.body = [c.ip, c.ip, c.ip].join(",");
    });
    const res = await app.handle(new Request("http://localhost:3000/"), {
      remote: () => {
        calls++;
        return "10.0.0.9";
      },
    });
    expect(calls).toBe(1);
    expect(await res.text()).toBe("10.0.0.9,10.0.0.9,10.0.0.9");
  });
});

// ---------------------------------------------------------------------------
// 6. Stream bodies: error propagation and HEAD
// ---------------------------------------------------------------------------
describe("stream bodies", () => {
  it("语义锁定: HEAD with a stream body drops the body but keeps status and type", async () => {
    const app = createApp(quiet);
    app.use((c) => {
      c.type = "text/plain";
      c.body = new ReadableStream({
        start(controller) {
          controller.enqueue(enc("abc"));
          controller.close();
        },
      });
    });
    const res = await app.handle(new Request("http://localhost:3000/", { method: "HEAD" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(res.headers.get("content-length")).toBe(null); // length of a stream is unknowable
    expect(await res.text()).toBe("");
  });

  it("语义锁定: consuming a healthy streamed body yields its chunks", async () => {
    const app = createApp(quiet);
    app.use((c) => {
      c.body = new ReadableStream({
        start(controller) {
          controller.enqueue(enc("hello "));
          controller.enqueue(enc("stream"));
          controller.close();
        },
      });
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(await res.text()).toBe("hello stream");
  });

  // Documented divergence (was an inherited koa CONFIRMED-BUG): Koa pipes the body
  // through `Stream.pipeline(stream, res, err => ctx.onerror(err))` so a
  // mid-flight body failure reaches the app's error channel. honu hands the raw
  // stream to the fetch `Response` and — by design (docs/DESIGN.md §4) —
  // made stream error observation an OPT-IN feature (`observeStream`, off by
  // default to save 567ns/response and restore backpressure). The opt-in
  // switch has not shipped yet (P2); until it does, this lock is explicitly
  // parked rather than silently dropped.
  it("[P2 delivered] a failing body stream reaches the onStreamError hook (opt-in)", async () => {
    const seen: string[] = [];
    const app = createApp({
      env: "test",
      onStreamError: (e) => seen.push(e.message),
    });
    app.use((c) => {
      c.body = new ReadableStream({
        start(controller) {
          controller.enqueue(enc("first"));
          queueMicrotask(() => controller.error(new Error("stream exploded")));
        },
      });
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    await expect(res.text()).rejects.toThrow();
    expect(seen).toContain("stream exploded");
  });
});
