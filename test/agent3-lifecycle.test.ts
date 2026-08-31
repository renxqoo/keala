/**
 * Agent3 red-test bug hunt: LIFECYCLE / CONCURRENCY / ADAPTERS / HELPERS.
 *
 * Every test below asserts the CORRECT behavior of a confirmed defect and
 * fails against the current implementation (TDD red). Groups:
 *  - guarded pooling: recycle completeness, release-vs-body-consumption races
 *  - native sink: JS mirror parity with the sunk Response instance
 *  - emitter: off()/once() Node-contract divergence
 *  - stream helpers: security header consistency across stream/streamText/SSE
 */

import { describe, expect, it } from "vitest";

import { Honu } from "../src/core/app.ts";
import { createEmitter } from "../src/core/emitter.ts";
import { streamText, streamSSE, stream } from "../src/helpers/streams.ts";

const quiet = { env: "test" } as const;
const req = (path: string, init?: RequestInit): Request =>
  new Request(`http://localhost:3000${path}`, init);
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("guarded pooling: recycle completeness", () => {
  it("a recycled context carries no ad-hoc properties from the previous request (cross-request disclosure)", async () => {
    const app = new Honu({ ...quiet, pooling: true });
    app.use((c, next) => {
      // koa-idiomatic per-request decoration (decorate() is for shared slots;
      // per-request data like an authenticated user is assigned ad hoc).
      if (c.path === "/login") {
        (c as unknown as Record<string, unknown>)["user"] = {
          name: "alice",
          token: "req1-secret",
        };
      }
      return next();
    });
    app.get("/login", (c) => c.text("in"));
    app.get("/who", (c) =>
      c.text(JSON.stringify((c as unknown as Record<string, unknown>)["user"] ?? null)),
    );

    await app.handle(req("/login"));
    // The pool hands request 2 the SAME context object; the login request's
    // `user` own-property must not survive the recycle.
    const res = await app.handle(req("/who"));
    expect(await res.text()).toBe("null");
  });
});

describe("guarded pooling: release vs streaming body consumption", () => {
  it("a streaming handler still reads its own request's data after the pool recycles the context", async () => {
    const app = new Honu({ ...quiet, pooling: true });
    let open: () => void = () => gate.then(() => undefined);
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    app.get("/s/:secret", (c) =>
      streamText(c, async (w) => {
        w.write("begin|");
        await gate; // a second request recycles the context while this body is open
        w.write(`secret=${c.params?.["secret"]}`);
      }),
    );

    const firstBody = Promise.resolve(app.handle(req("/s/alpha"))).then((res) => res.text());
    await delay(5);
    // Same route, second user: acquires and re-dispatches the SAME context.
    await app.handle(req("/s/beta"));
    open();

    // Request 1's response body must carry request 1's param — not the value
    // the recycled context now holds for request 2.
    expect(await firstBody).toBe("begin|secret=alpha");
  });

  it("a late stream error (onStreamError) is attributed to the request that owns the stream", async () => {
    const seen: string[] = [];
    const app = new Honu({
      env: "test",
      pooling: true,
      onStreamError: (_error, c) => {
        seen.push(c.url);
      },
    });
    let detonate: () => void = () => boom.then(() => undefined);
    const boom = new Promise<void>((resolve) => {
      detonate = resolve;
    });
    app.get("/first", (c) => {
      c.body = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode("part"));
          await boom;
          controller.error(new Error("late-failure"));
        },
      });
    });
    app.get("/second", (c) => c.text("ok"));

    const res = await app.handle(req("/first"));
    const reader = res.body!.getReader();
    await reader.read();
    // Request 2 fully settles: the retired context is recycled and reset.
    await app.handle(req("/second"));
    detonate();
    await expect(reader.read()).rejects.toThrow();
    // The hook must report the stream's OWN request, not the foreign request
    // the context was recycled into.
    expect(seen).toEqual(["/first"]);
  });
});

describe("guarded pooling: retireWithBody edge paths", () => {
  it("a cancelled body retires the context (client disconnect)", async () => {
    const app = new Honu({ ...quiet, pooling: true });
    app.get("/s", (c) => {
      c.body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("chunk"));
          // never closed — only cancellation can end this body
        },
      });
    });
    const first = await app.handle(req("/s"));
    const reader = first.body!.getReader();
    await reader.read();
    await reader.cancel("client went away");
    // The context retired through the cancel path: the NEXT request may
    // acquire it (identical object) with clean state.
    const held: unknown[] = [];
    app.use((c, next) => {
      held.push(c);
      return next();
    });
    app.get("/x", (c) => c.text("next"));
    await (await app.handle(req("/x"))).text();
    const again = await app.handle(req("/x"));
    await again.text();
    expect(held[0]).toBe(held[1]);
  });

  it("a body reader error retires the context exactly once", async () => {
    const app = new Honu({ ...quiet, pooling: true });
    let detonate: () => void = () => undefined;
    const boom = new Promise<void>((resolve) => {
      detonate = () => resolve();
    });
    app.get("/boom", (c) => {
      c.body = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode("x"));
          await boom;
          controller.error(new Error("source died"));
        },
      });
    });
    const res = await app.handle(req("/boom"));
    const reader = res.body!.getReader();
    await reader.read();
    detonate();
    await expect(reader.read()).rejects.toThrow("source died");
    // …and a subsequent request still works (the context was retired once).
    app.get("/after", (c) => c.text("ok"));
    const after = await app.handle(req("/after"));
    expect(await after.text()).toBe("ok");
  });
});

describe("native sink: JS mirror parity", () => {
  it("the JS mirror preserves the sunk Response's status text", async () => {
    const sunk = new Response("ok", { status: 280, statusText: "Custom Reason" });
    const app = new Honu(quiet);
    app.sink("/health", sunk);
    const res = await app.handle(req("/health"));
    expect(res.status).toBe(280);
    expect(await res.text()).toBe("ok");
    // The native table reuses `sunk` verbatim (statusText survives there);
    // the JS mirror rebuilds and must not diverge from it.
    expect(sunk.statusText).toBe("Custom Reason");
    expect(res.statusText).toBe("Custom Reason");
  });
});

describe("emitter: off()/once() contract", () => {
  it("off() removes a listener registered through once() (Node EventEmitter contract)", () => {
    const emitter = createEmitter();
    const calls: string[] = [];
    const listener = (): void => {
      calls.push("fired");
    };
    emitter.once("error", listener);
    emitter.off("error", listener);
    expect(emitter.listenerCount("error")).toBe(0);
    expect(emitter.emit("error", new Error("x"))).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("stream helpers: security header consistency", () => {
  it("streamText and streamSSE keep the nosniff header stream() sets", async () => {
    const app = new Honu(quiet);
    app.get("/bin", (c) => stream(c, () => undefined));
    app.get("/txt", (c) => streamText(c, () => undefined));
    app.get("/sse", (c) => streamSSE(c, () => undefined, { heartbeat: 0 }));

    const bin = await app.handle(req("/bin"));
    const txt = await app.handle(req("/txt"));
    const sse = await app.handle(req("/sse"));

    expect(bin.headers.get("x-content-type-options")).toBe("nosniff");
    expect(txt.headers.get("x-content-type-options")).toBe("nosniff");
    expect(sse.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
