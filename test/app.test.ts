import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/application/app.ts";
import { createError } from "../src/http/errors.ts";
import { createRouter } from "../src/router/router.ts";

describe("application", () => {
  it("registers middleware and returns itself", () => {
    const app = createApp();
    expect(app.use(async () => {})).toBe(app);
    expect(() => app.use(null as unknown as () => void)).toThrow(TypeError);
  });

  it("serves 404 for unhandled requests", async () => {
    const app = createApp();
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });

  it("callback() mirrors handle()", async () => {
    const app = createApp();
    app.use(async (ctx) => {
      ctx.body = "via callback";
    });
    const handler = app.callback();
    const res = await handler(new Request("http://localhost:3000/"));
    expect(await res.text()).toBe("via callback");
  });

  it("recompiles the chain when middleware is added later", async () => {
    const app = createApp();
    app.use(async (ctx, next) => {
      ctx.body = "first";
      await next();
    });
    expect(await (await app.handle(new Request("http://x/"))).text()).toBe("first");
    app.use(async (ctx, next) => {
      await next();
      ctx.set("X-Second", "yes");
    });
    const res = await app.handle(new Request("http://x/"));
    expect(res.headers.get("x-second")).toBe("yes");
  });

  it("emits error events with context", async () => {
    const app = createApp({ env: "test" });
    const listener = vi.fn();
    app.on("error", listener);
    app.use(async () => {
      throw new Error("middleware failure");
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(500);
    expect(listener).toHaveBeenCalledTimes(1);
    const [error, ctx] = listener.mock.calls[0] as [Error, { url: string }];
    expect(error.message).toBe("middleware failure");
    expect(ctx.url).toBe("/");
  });

  it("returns exposed 4xx messages and hides 5xx messages", async () => {
    const app = createApp({ env: "test" });
    app.use(async (ctx) => {
      ctx.throw(404, "no such user");
    });
    const notFound = await app.handle(new Request("http://localhost:3000/"));
    expect(notFound.status).toBe(404);
    expect(await notFound.text()).toBe("no such user");

    const server = createApp({ env: "test" });
    server.use(async () => {
      throw createError(502, "upstream secret");
    });
    const badGateway = await server.handle(new Request("http://localhost:3000/"));
    expect(badGateway.status).toBe(502);
    expect(await badGateway.text()).toBe("Bad Gateway");
  });

  it("normalizes non-Error throwables", async () => {
    const app = createApp({ env: "test" });
    app.on("error", (err) => {
      expect(err).toBeInstanceOf(Error);
    });
    app.use(async () => {
      throw "just a string";
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(500);
  });

  it("applies error headers", async () => {
    const app = createApp({ env: "test" });
    app.use(async () => {
      throw createError(429, "slow down", { headers: { "Retry-After": "30" } });
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
  });

  it("silences console output when silent or test env", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const loud = createApp({ env: "development" });
    loud.use(async () => {
      throw new Error("loud");
    });
    await loud.handle(new Request("http://localhost:3000/"));
    expect(errorSpy).toHaveBeenCalledTimes(1);

    const quiet = createApp({ silent: true });
    quiet.use(async () => {
      throw new Error("quiet");
    });
    await quiet.handle(new Request("http://localhost:3000/"));
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it("supports once and off listeners", async () => {
    const app = createApp({ env: "test" });
    const onceListener = vi.fn();
    app.once("error", onceListener);
    app.use(async () => {
      throw new Error("a");
    });
    await app.handle(new Request("http://localhost:3000/"));
    await app.handle(new Request("http://localhost:3000/"));
    expect(onceListener).toHaveBeenCalledTimes(1);

    const offListener = vi.fn();
    const unsub = app.on("error", offListener);
    unsub();
    await app.handle(new Request("http://localhost:3000/"));
    expect(offListener).not.toHaveBeenCalled();

    const removed = vi.fn();
    app.on("error", removed);
    app.off("error", removed);
    await app.handle(new Request("http://localhost:3000/"));
    expect(removed).not.toHaveBeenCalled();
    expect(app.listenerCount("error")).toBe(0);
  });

  it("toJSON exposes settings", () => {
    const app = createApp({ proxy: true, env: "production" });
    expect(app.toJSON()).toEqual({ subdomainOffset: 2, proxy: true, env: "production" });
  });

  it("forwards error events through emit/onerror", () => {
    const app = createApp();
    const seen: unknown[] = [];
    app.on("custom", (value) => seen.push(value));
    app.emit("custom", 1);
    expect(seen).toEqual([1]);
    expect(app.emit("nobody-listens", 2)).toBe(false);
  });

  it("runs a full router app end to end", async () => {
    const app = createApp();
    const router = createRouter({ prefix: "/api" });
    router.get("/users/:id", async (ctx) => {
      ctx.body = { id: ctx.params["id"] };
    });
    router.post("/users", async (ctx) => {
      ctx.status = 201;
      ctx.body = { created: true };
    });
    app.use(router.routes()).use(router.allowedMethods());

    const got = await app.handle(new Request("http://localhost:3000/api/users/42"));
    expect(await got.json()).toEqual({ id: "42" });

    const created = await app.handle(
      new Request("http://localhost:3000/api/users", { method: "POST" }),
    );
    expect(created.status).toBe(201);

    const missing = await app.handle(new Request("http://localhost:3000/api/nope"));
    expect(missing.status).toBe(404);
  });

  it("mutating middleware continue upstream after next()", async () => {
    const app = createApp();
    const order: string[] = [];
    app.use(async (_ctx, next) => {
      order.push("one:before");
      await next();
      order.push("one:after");
    });
    app.use(async (ctx) => {
      order.push("two");
      ctx.body = "done";
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(await res.text()).toBe("done");
    expect(order).toEqual(["one:before", "two", "one:after"]);
  });
});
