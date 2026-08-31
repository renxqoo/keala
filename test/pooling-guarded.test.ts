/**
 * Guarded pooling: opt-in recycling where retired contexts throw on write.
 */

import { describe, expect, it } from "vitest";

import { createApp } from "../src/core/app.ts";
import { deadContextProto } from "../src/core/context/pool.ts";
import type { Context } from "../src/core/context/context.ts";

const quiet = { env: "test" } as const;

describe("guarded pooling", () => {
  it("recycles contexts across requests with identical behavior", async () => {
    const app = createApp({ ...quiet, pooling: true });
    app.get("/x/:id", (c) => c.text(`id:${c.params?.["id"]}`));
    for (let i = 0; i < 5; i++) {
      const res = await app.handle(new Request(`http://localhost:3000/x/${i}`));
      expect(await res.text()).toBe(`id:${i}`);
    }
  });

  it("async chains retire only after settling (state intact during flight)", async () => {
    const app = createApp({ ...quiet, pooling: true });
    app.get("/slow", async (c, next) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await next();
      c.set("X-After", "1");
    });
    app.get("/slow", (c) => c.text("done"));
    const res = await app.handle(new Request("http://localhost:3000/slow"));
    expect(await res.text()).toBe("done");
    expect(res.headers.get("x-after")).toBe("1");
  });

  it("a retained retired context throws on every write surface", async () => {
    const held: Context[] = [];
    const app = createApp({ ...quiet, pooling: true });
    app.use((c, next) => {
      held.push(c);
      return next();
    });
    app.get("/x", (c) => c.text("ok"));
    // Consume the bodies: retirement happens once the response body is
    // consumed (streams outlive settle — the retire-on-settle race leaked
    // request data into in-flight bodies; see test/agent3-lifecycle.test.ts).
    await (await app.handle(new Request("http://localhost:3000/x"))).text();
    // A second request retires the first context into the pool.
    await (await app.handle(new Request("http://localhost:3000/x"))).text();
    const retired = held[0] as Context;
    expect(() => {
      (retired as unknown as { status: number }).status = 500;
    }).toThrow(/retired/);
    expect(() => {
      (retired as unknown as { set: (k: string, v: string) => void }).set("x", "1");
    }).toThrow(/retired/);
    expect(() => {
      (retired as unknown as { body: unknown }).body = "late";
    }).toThrow(/retired/);
  });

  it("a retired context is live again after reset (pool reuse)", async () => {
    const held: Context[] = [];
    const app = createApp({ ...quiet, pooling: true });
    app.use((c, next) => {
      held.push(c);
      return next();
    });
    app.get("/x", (c) => c.text("ok"));
    // Bodies consumed → each context retires once its body is read.
    await (await app.handle(new Request("http://localhost:3000/x"))).text();
    await (await app.handle(new Request("http://localhost:3000/x"))).text();
    await (await app.handle(new Request("http://localhost:3000/x"))).text();
    // The pool cycles: the first context comes back live with clean state.
    expect(held[0]).toBe(held[2]);
    const reused = held[2] as Context;
    expect(reused.path).toBe("/x");
    expect(reused.status).toBe(200);
  });

  it("pooling stays off by default (no recycling, no guards)", async () => {
    const held: Context[] = [];
    const app = createApp(quiet);
    app.use((c, next) => {
      held.push(c);
      return next();
    });
    app.get("/x", (c) => c.text("ok"));
    await app.handle(new Request("http://localhost:3000/x"));
    await app.handle(new Request("http://localhost:3000/x"));
    expect(held[0]).not.toBe(held[1]);
  });

  it("errors recycle through the pool without leaking into the next request", async () => {
    const app = createApp({ ...quiet, pooling: true });
    app.get("/boom", () => {
      throw new Error("kaboom");
    });
    app.get("/ok", (c) => c.text("clean"));
    const boom = await app.handle(new Request("http://localhost:3000/boom"));
    expect(boom.status).toBe(500);
    const ok = await app.handle(new Request("http://localhost:3000/ok"));
    expect(await ok.text()).toBe("clean");
    expect(ok.status).toBe(200);
  });

  it("deadContextProto exposes the retired surface", () => {
    const retired = Object.create(deadContextProto) as Context;
    expect(() => {
      (retired as unknown as { remove: (k: string) => void }).remove("x");
    }).toThrow(/retired/);
  });
});
