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
 * Koa baseline: .parity/koa/lib/{request,context,application}.js (v3.2.1).
 */

import { describe, expect, it } from "vitest";

import { createApp } from "../src/application/app.ts";
import { createEmitter } from "../src/application/emitter.ts";

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
// 5. Lazy singletons on the request facade
// ---------------------------------------------------------------------------
describe("lazy singletons", () => {
  it("语义锁定: the cookies facade is created once and shared across await points", async () => {
    const app = createApp({ ...quiet, keys: ["k"] });
    const observed: boolean[] = [];
    app.use(async (ctx, next) => {
      const first = ctx.cookies;
      ctx.cookies.set("a", "1");
      await next();
      observed.push(ctx.cookies === first);
      ctx.body = "ok";
    });
    app.use(async (ctx) => {
      ctx.cookies.set("b", "2");
      await delay(2);
    });
    await app.handle(new Request("http://localhost:3000/"));
    expect(observed).toEqual([true]);
  });

  it("语义锁定: ctx.state is one object per request and fresh across requests", async () => {
    const app = createApp(quiet);
    const states: unknown[] = [];
    app.use(async (ctx) => {
      states.push(ctx.state);
      ctx.state.n = states.length;
      await delay(1);
      ctx.body = JSON.stringify({ keys: Object.keys(ctx.state) });
    });
    const first = await app.handle(new Request("http://localhost:3000/"));
    const second = await app.handle(new Request("http://localhost:3000/"));
    expect(states[0]).not.toBe(states[1]);
    expect(await first.text()).toBe(JSON.stringify({ keys: ["n"] }));
    expect(await second.text()).toBe(JSON.stringify({ keys: ["n"] }));
  });

  // CONFIRMED-BUG (design intent): the remote source must be consulted ONCE
  // per request — that is the whole point of `RequestState.remoteValue`
  // memoization (src/http/request.ts:53,269-277), and Koa memoizes its ip
  // getter the same way (`if (!this[IP])`, .parity/koa/lib/request.js:464).
  // Repro: pass a thunk (or requestIP host) whose result is undefined/null —
  // e.g. a disconnected peer under Bun's server.requestIP. Expected: the
  // thunk is called exactly once and the "no remote" answer is cached.
  // Actual: `remoteValue` only caches defined values, so every ctx.ip access
  // re-invokes the thunk (3 reads -> 3 calls), multiplying side effects.
  // Root cause: src/http/request.ts:269-277 — the `=== undefined` sentinel
  // conflates "not resolved yet" with "resolved to nothing".
  it("CONFIRMED-BUG: ip thunk returning undefined is re-invoked on every access", async () => {
    let calls = 0;
    const app = createApp(quiet);
    app.use((ctx) => {
      const readings = [ctx.ip, ctx.ip, ctx.ip];
      ctx.body = readings.join("|");
    });
    await app.handle(new Request("http://localhost:3000/"), () => {
      calls++;
      return undefined;
    });
    expect(calls).toBe(1); // actual: 3
  });

  // CONFIRMED-BUG (same root cause, object form): a `server.requestIP`
  // source returning null (Bun does this once the peer is gone) is consulted
  // once per ctx.ip read instead of once per request.
  it("CONFIRMED-BUG: requestIP host returning null is re-consulted on every access", async () => {
    let calls = 0;
    const app = createApp(quiet);
    app.use((ctx) => {
      ctx.body = `${ctx.ip},${ctx.ip}`;
    });
    await app.handle(new Request("http://localhost:3000/"), {
      requestIP: () => {
        calls++;
        return null;
      },
    });
    expect(calls).toBe(1); // actual: 2
  });

  it("语义锁定: a thunk with a concrete result is called exactly once", async () => {
    let calls = 0;
    const app = createApp(quiet);
    app.use((ctx) => {
      ctx.body = [ctx.ip, ctx.ip, ctx.ip].join(",");
    });
    const res = await app.handle(new Request("http://localhost:3000/"), () => {
      calls++;
      return "10.0.0.9";
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
    app.use((ctx) => {
      ctx.type = "text/plain";
      ctx.body = new ReadableStream({
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
    app.use((ctx) => {
      ctx.body = new ReadableStream({
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

  // CONFIRMED-BUG (error lifecycle parity): a body stream that fails
  // mid-flight never reaches the app's error channel. Koa 3.2.1 pipes the
  // body through `Stream.pipeline(stream, res, err => { if (err ...)
  // ctx.onerror(err) })` (.parity/koa/lib/application.js respond), so the
  // framework's error listeners fire and logging/telemetry sees the failure.
  // Repro: handler returns a stream that emits a chunk then errors; the
  // client-visible Response rejects when consumed, but no app-level signal
  // exists. Expected: the framework error listener is invoked with the
  // stream's error. Actual: zero emissions — respond() hands the raw stream
  // to `new Response()` and nothing ever observes it.
  // Root cause: src/application/respond.ts:46-63 (stream passed through
  // unobserved); src/application/app.ts has no onFinished/pipeline
  // equivalent after finalize.
  it("CONFIRMED-BUG: a failing body stream never reaches app error listeners", async () => {
    const seen: string[] = [];
    const app = createApp(quiet);
    app.on("error", (e: Error) => seen.push(e.message));
    app.use((ctx) => {
      ctx.body = new ReadableStream({
        start(controller) {
          controller.enqueue(enc("first"));
          queueMicrotask(() => controller.error(new Error("stream exploded")));
        },
      });
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    await expect(res.text()).rejects.toThrow();
    expect(seen).toContain("stream exploded"); // actual: seen === []
  });
});
