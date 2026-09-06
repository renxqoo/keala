import { describe, expect, it } from "vitest";

import { Keala, createCookies } from "../../src/index.ts";
import {
  baseContextProto,
  createContext,
  resetContext,
  type Context,
} from "../../src/core/context/context.ts";
import { NO_PARAM_NAMES, NO_PARAM_VALUES } from "../../src/router/router.ts";
import { deadProtoFor } from "../../src/core/context/pool.ts";
/**
 * Context recycling semantics .
 *
 * Pooling is opt-in through `new Keala({ pooling: true })`; resetContext is
 * exported for hosts that own their lifecycle. Fresh contexts inherit cold
 * primitive sentinels from the live prototype, while recycled contexts reset
 * the corresponding own slots. The contract is observable value equality,
 * not identical Object.keys() layout: requiring identical own keys would put
 * twenty cold writes back on every non-pooled request.
 */

const quiet = { env: "test" } as const;

/** A context that lived through a full, messy request lifecycle. */
const usedContext = (app = new Keala({}).use(createCookies({ keys: ["k"] }))): Context => {
  const c = createContext(app, baseContextProto, new Request("http://localhost:3000/a?x=1"), {
    remote: "1.1.1.1",
  });
  c.paramNames = ["id"];
  c.paramValues = ["7"];
  c.routerAllowed.add("GET");
  c.state["step"] = 1;
  c.setHeader("X-Used", "yes");
  c.append("Set-Cookie", "old=1; Path=/");
  // U3c: the status/body setters are gone — dirty the same response slots
  // directly (statusValue + the sugar-snapshot slot) so the recycle contract
  // keeps full coverage.
  c.statusValue = 201;
  c.directBodyResponseValue = new Response("payload", { status: 201 });
  // U-cookie: the facade decorates the APP proto; usedContext builds on
  // the shared baseContextProto (no plugin decoration there), so dirty the
  // plugin's memo slot + record directly (the recycle contract covers the
  // same slots).
  c.cookiesValue = { stale: "facade" };
  c.setHeader("Set-Cookie", "sid=one; Path=/");
  // Materialize every lazy cache (the recycle must drop them).
  void c.ip;
  void c.query("v");
  return c;
};

describe("resetContext recycling semantics", () => {
  it("field conservation: recycled and fresh contexts expose identical state values", () => {
    const app = new Keala({}).use(createCookies({ keys: ["k"] }));
    const raw = new Request("http://localhost:3000/b?y=2");
    const runtime = { remote: "2.2.2.2" };
    const fresh = createContext(app, baseContextProto, raw, runtime);
    const recycled = resetContext(usedContext(app), raw, runtime);

    const freshState = fresh as unknown as Record<string, unknown>;
    const recycledState = recycled as unknown as Record<string, unknown>;
    const freshKeys = Object.keys(fresh);
    const recycledKeys = Object.keys(recycled);
    expect(recycledKeys).toEqual(expect.arrayContaining(freshKeys));
    for (const key of recycledKeys) {
      expect(recycledState[key]).toEqual(freshState[key]);
    }
  });

  it("a recycled context reflects the new request only (no stale state)", () => {
    const recycled = resetContext(
      usedContext(),
      new Request("http://localhost:3000/b?y=2", { headers: { Cookie: "other=2" } }),
      { remote: "2.2.2.2" },
    );
    expect(recycled.url).toBe("/b?y=2");
    expect(recycled.path).toBe("/b");
    expect(recycled.query("y")).toBe("2");
    expect(recycled.status).toBe(404);
    // U3c: the body slot is gone; its closest survivor (the sugar-snapshot
    // identity slot) must be reset just the same.
    expect(recycled.directBodyResponseValue).toBeUndefined();
    expect(recycled.has("X-Used")).toBe(false);
    expect(recycled.resHeader("set-cookie")).toBe("");
    expect(Object.keys(recycled.state)).toEqual([]);
    expect(recycled.paramNames).toBe(NO_PARAM_NAMES);
    expect(recycled.paramValues).toBe(NO_PARAM_VALUES);
    expect(recycled.ip).toBe("2.2.2.2");
    // U-cookie: the facade is plugin-decorated (not on this base-proto
    // context) — its memo slot must be reset, and the NEW request's Cookie
    // header is what a fresh facade would parse.
    expect(recycled.cookiesValue).toBe(null);
    expect(recycled.header("cookie")).toBe("other=2");
  });

  it("clears the 405 allowed-methods bookkeeping (contract #6: no foreign-405 leaks)", () => {
    const recycled = resetContext(
      usedContext(),
      new Request("http://localhost:3000/fresh"),
      undefined,
    );
    expect(recycled.routerAllowed.size).toBe(0);
    recycled.routerAllowed.add("POST");
    expect(recycled.routerAllowed.has("GET")).toBe(false);
  });

  it("re-resolves the remote address from the new runtime", () => {
    const c = usedContext();
    expect(c.ip).toBe("1.1.1.1");
    const recycled = resetContext(c, new Request("http://localhost:3000/next"), {
      remote: () => "3.3.3.3",
    });
    expect(recycled.ip).toBe("3.3.3.3");
  });

  it("clears an explicit runtime when the next pooled request has none", async () => {
    const app = new Keala({ ...quiet, pooling: true });
    app.get("/runtime", (c) => c.json({ remote: c.runtime?.remote ?? null }));

    const first = await app.handle(new Request("http://localhost/runtime"), {
      remote: "4.4.4.4",
    });
    expect(await first.json()).toEqual({ remote: "4.4.4.4" });

    const second = await app.handle(new Request("http://localhost/runtime"));
    expect(await second.json()).toEqual({ remote: null });
  });
});

describe("request isolation (fresh context per request)", () => {
  it("serial requests never observe stale state", async () => {
    const app = new Keala(quiet);
    app.get("/a/:id", (c) => {
      c.state["id"] = c.params("id");
      c.setHeader("X-Run", String(c.state["id"]));
      return c.json({ id: c.state["id"], q: c.query("v") ?? null });
    });
    app.get("/b", (c) => {
      // No writes: every field must reflect THIS request, not the previous one.
      return c.json({
        state: Object.keys(c.state).length,
        url: c.url,
        path: c.path,
      });
    });

    await app.handle(new Request("http://localhost:3000/a/1?v=first"));
    const second = await app.handle(new Request("http://localhost:3000/b"));
    const body = (await second.json()) as {
      state: number;
      url: string;
      path: string;
    };
    expect(body.state).toBe(0); // state was reset
    expect(body.url).toBe("/b");
    expect(body.path).toBe("/b");

    const third = await app.handle(new Request("http://localhost:3000/a/2?v=x"));
    const parsed = (await third.json()) as { id: string; q: string };
    expect(parsed).toEqual({ id: "2", q: "x" });
    expect(third.headers.get("x-run")).toBe("2");
  });

  it("concurrent interleaved requests keep isolated contexts", async () => {
    const app = new Keala(quiet);
    app.use(createCookies());
    app.get("/slow/:tag", async (c) => {
      const mine = c.params("tag") as string;
      await new Promise((resolve) => setTimeout(resolve, mine === "a" ? 15 : 2));
      return c.text(`${mine}:${c.params("tag")}`);
    });
    const results = await Promise.all([
      app.handle(new Request("http://localhost:3000/slow/a")),
      app.handle(new Request("http://localhost:3000/slow/b")),
      app.handle(new Request("http://localhost:3000/slow/a")),
    ]);
    const bodies = await Promise.all(results.map((r) => r.text()));
    expect(bodies).toEqual(["a:a", "b:b", "a:a"]);
  });

  it("error responses recycle cleanly", async () => {
    const app = new Keala({ ...quiet });
    app.use(createCookies());
    app.onError(() => {});
    app.get("/ok", (c) => {
      return c.text(`fresh:${c.state["step"] ?? "0"}`);
    });
    app.get("/boom", async () => {
      throw new Error("planned");
    });
    await app.handle(new Request("http://localhost:3000/boom"));
    const res = await app.handle(new Request("http://localhost:3000/ok"));
    expect(await res.text()).toBe("fresh:0");
  });

  it("cookies and headers do not leak between requests", async () => {
    const app = new Keala({ ...quiet }).use(createCookies({ keys: ["k"] }));
    app.use(async (c) => {
      if (c.path === "/set") {
        // U-cookie: the facade decorates the APP proto; this context is built on
        // the shared baseContextProto, so dirty the plugin's memo slot + record
        // directly (the recycle contract covers the same slots).
        c.cookiesValue = { stale: "facade" };
        c.setHeader("Set-Cookie", "sid=one; Path=/");
        c.setHeader("X-Custom", "first");
        return;
      }
      return c.text(
        [
          c.cookies.get("sid") ?? "none",
          c.resHeader("X-Custom") || "none",
          c.headers.get("x-incoming") ?? "none",
        ].join("|"),
      );
    });
    await app.handle(new Request("http://localhost:3000/set"));
    const res = await app.handle(
      new Request("http://localhost:3000/get", { headers: { "X-Incoming": "yes" } }),
    );
    expect(await res.text()).toBe("none|none|yes");
  });

  it("stream bodies still deliver across requests", async () => {
    const app = new Keala(quiet);
    app.use(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("streamed"));
              controller.close();
            },
          }),
        ),
    );
    const first = await app.handle(new Request("http://localhost:3000/"));
    expect(await first.text()).toBe("streamed");
    const second = await app.handle(new Request("http://localhost:3000/"));
    expect(await second.text()).toBe("streamed");
  });
});

/**
 * Guarded pooling: opt-in recycling where retired contexts throw on write.
 */

describe("guarded pooling", () => {
  it("recycles contexts across requests with identical behavior", async () => {
    const app = new Keala({ ...quiet, pooling: true });
    app.get("/x/:id", (c) => c.text(`id:${c.params("id")}`));
    for (let i = 0; i < 5; i++) {
      const res = await app.handle(new Request(`http://localhost:3000/x/${i}`));
      expect(await res.text()).toBe(`id:${i}`);
    }
  });

  it("async chains retire only after settling (state intact during flight)", async () => {
    const app = new Keala({ ...quiet, pooling: true });
    app.get("/slow", async (c, next) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await next();
      c.setHeader("X-After", "1");
    });
    app.get("/slow", (c) => c.text("done"));
    const res = await app.handle(new Request("http://localhost:3000/slow"));
    expect(await res.text()).toBe("done");
    expect(res.headers.get("x-after")).toBe("1");
  });

  it("a retained retired context throws on every write surface", async () => {
    const held: Context[] = [];
    const app = new Keala({ ...quiet, pooling: true });
    app.use((c, next) => {
      held.push(c);
      return next();
    });
    app.get("/x", (c) => c.text("ok"));
    // Consume the bodies to keep the assertion order stable. Snapshot bodies
    // (this c.text string) retire AT SETTLE — an immutable snapshot cannot
    // reference the context, so the retire fast path releases immediately;
    // only stream-bodied responses wait for consumption (see
    // test/agent3-lifecycle.test.ts and the pooling wire suite).
    await (await app.handle(new Request("http://localhost:3000/x"))).text();
    // A second request retires the first context into the pool.
    await (await app.handle(new Request("http://localhost:3000/x"))).text();
    const retired = held[0] as Context;
    expect(() => {
      (retired as unknown as { status: number }).status = 500;
    }).toThrow(/retired/);
    // U3c: body/set left the surface with the setters — the retired guard's
    // surviving write surfaces are the header writers, redirect and state.
    expect(() => retired.setHeader("x", "1")).toThrow(/retired/);
    expect(() => retired.redirect("http://x/leak")).toThrow(/retired/);
  });

  it("a retired context is live again after reset (pool reuse)", async () => {
    const held: Context[] = [];
    const app = new Keala({ ...quiet, pooling: true });
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
    const app = new Keala(quiet);
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
    const app = new Keala({ ...quiet, pooling: true });
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

  it("deadProtoFor(baseContextProto) exposes the retired surface", () => {
    const retired = Object.create(deadProtoFor(baseContextProto)) as Context;
    expect(() => {
      (retired as unknown as { remove: (k: string) => void }).remove("x");
    }).toThrow(/retired/);
  });
});
