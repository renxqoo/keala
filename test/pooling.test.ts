/**
 * Opt-in context pooling: recycled contexts must be indistinguishable from
 * fresh ones across serial, concurrent, error and mixed-shape traffic.
 */

import { describe, expect, it } from "vitest";

import { createApp } from "../src/application/app.ts";
import { createRouter } from "../src/router/router.ts";

const quiet = { env: "test", pooling: true } as const;

describe("context pooling (opt-in)", () => {
  it("serial requests never observe stale state", async () => {
    const app = createApp(quiet);
    const router = createRouter();
    router.get("/a/:id", (ctx) => {
      ctx.state.id = ctx.params.id;
      ctx.set("X-Run", String(ctx.state.id));
      ctx.body = JSON.stringify({ id: ctx.state.id, q: ctx.query.v ?? null });
    });
    router.get("/b", (ctx) => {
      // No writes: every field must reflect THIS request, not the previous one.
      ctx.body = JSON.stringify({
        state: Object.keys(ctx.state).length,
        url: ctx.url,
        path: ctx.path,
        type: ctx.type,
      });
    });
    app.use(router.routes());

    await app.handle(new Request("http://localhost:3000/a/1?v=first"));
    const second = await app.handle(new Request("http://localhost:3000/b"));
    const body = (await second.json()) as {
      state: number;
      url: string;
      path: string;
      type: string;
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
    const app = createApp(quiet);
    const router = createRouter();
    router.get("/slow/:tag", async (ctx) => {
      const mine = ctx.params.tag as string;
      await new Promise((resolve) => setTimeout(resolve, mine === "a" ? 15 : 2));
      ctx.body = `${mine}:${ctx.params.tag}`;
    });
    app.use(router.routes());
    const results = await Promise.all([
      app.handle(new Request("http://localhost:3000/slow/a")),
      app.handle(new Request("http://localhost:3000/slow/b")),
      app.handle(new Request("http://localhost:3000/slow/a")),
    ]);
    const bodies = await Promise.all(results.map((r) => r.text()));
    expect(bodies).toEqual(["a:a", "b:b", "a:a"]);
  });

  it("error responses recycle cleanly", async () => {
    const app = createApp({ ...quiet });
    app.on("error", () => {});
    const router = createRouter();
    router.get("/ok", (ctx) => {
      ctx.body = `fresh:${ctx.state.step ?? "0"}`;
    });
    router.get("/boom", async () => {
      throw new Error("planned");
    });
    app.use(router.routes());
    await app.handle(new Request("http://localhost:3000/boom"));
    const res = await app.handle(new Request("http://localhost:3000/ok"));
    expect(await res.text()).toBe("fresh:0");
  });

  it("cookies and headers do not leak between pooled requests", async () => {
    const app = createApp({ ...quiet, keys: ["k"] });
    app.use(async (ctx) => {
      if (ctx.path === "/set") {
        ctx.cookies.set("sid", "one", { signed: true });
        ctx.set("X-Custom", "first");
        return;
      }
      ctx.body = [
        ctx.cookies.get("sid") ?? "none",
        ctx.response.get("X-Custom") || "none",
        ctx.headers.get("x-incoming") ?? "none",
      ].join("|");
    });
    await app.handle(new Request("http://localhost:3000/set"));
    const res = await app.handle(
      new Request("http://localhost:3000/get", { headers: { "X-Incoming": "yes" } }),
    );
    expect(await res.text()).toBe("none|none|yes");
  });

  it("pooling stays correct with currentContext enabled", async () => {
    const app = createApp({ ...quiet, currentContext: true });
    const seen: string[] = [];
    app.use(async (ctx) => {
      seen.push(app.currentContext?.url ?? "none");
      ctx.body = "ok";
    });
    await app.handle(new Request("http://localhost:3000/one"));
    await app.handle(new Request("http://localhost:3000/two"));
    expect(seen).toEqual(["/one", "/two"]);
  });

  it("stream bodies on pooled contexts still deliver", async () => {
    const app = createApp(quiet);
    app.use(async (ctx) => {
      ctx.body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("streamed"));
          controller.close();
        },
      });
    });
    const first = await app.handle(new Request("http://localhost:3000/"));
    expect(await first.text()).toBe("streamed");
    const second = await app.handle(new Request("http://localhost:3000/"));
    expect(await second.text()).toBe("streamed");
  });
});
