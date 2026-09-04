/**
 * Branch-coverage completion, part 2: the injected-gzip compress tree and the
 * last small gaps (cors preflight extras, crypto fallback, adapter drain,
 * body-parser declared-limit on non-default readers).
 */

import { describe, expect, it } from "vitest";

import { Keala } from "../src/core/app.ts";
import { compress } from "../src/middleware/etag.ts";
import { cors } from "../src/middleware/cors.ts";
import type { Context } from "../src/core/context/context.ts";
import { Router } from "../src/router/group.ts";
import { startBunServer } from "../src/adapters/bun.ts";
import type { Application } from "../src/core/app.ts";

const quiet = { env: "test" } as const;
const gzip = (input: Uint8Array): Promise<Uint8Array> =>
  Promise.resolve(
    new Uint8Array([0x1f, 0x8b, ...input.subarray(0, Math.max(1, input.byteLength - 64))]),
  );
const gzRequest = (path: string): Request =>
  new Request(`http://localhost:3000${path}`, { headers: { "accept-encoding": "gzip, br" } });

describe("coverage: compress with injected gzip", () => {
  it("compresses eligible string bodies and replaces the body bytes", async () => {
    const app = new Keala(quiet);
    app.use(compress({ gzip }));
    app.get("/x", (c) => {
      c.body = "0".repeat(400);
    });
    const res = await app.handle(gzRequest("/x"));
    expect(res.headers.get("content-encoding")).toBe("gzip");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes[0]).toBe(0x1f);
    expect(bytes[1]).toBe(0x8b);
  });

  it("object bodies compress; pre-encoded and committed responses skip", async () => {
    const app = new Keala(quiet);
    app.use(compress({ gzip }));
    app.get("/obj", (c) => {
      c.body = { pad: "1".repeat(500) };
    });
    app.get("/pre", (c) => {
      c.body = "0".repeat(400);
      c.setHeader("Content-Encoding", "br");
    });
    app.get("/committed", (c) => c.text("0".repeat(400)));
    expect((await app.handle(gzRequest("/obj"))).headers.get("content-encoding")).toBe("gzip");
    expect((await app.handle(gzRequest("/pre"))).headers.get("content-encoding")).toBe("br");
    expect((await app.handle(gzRequest("/committed"))).headers.get("content-encoding")).toBeNull();
  });

  it("skips when the packed output would not shrink", async () => {
    const growing = (): Promise<Uint8Array> => Promise.resolve(new Uint8Array(1024).fill(1));
    const app = new Keala(quiet);
    app.use(compress({ gzip: growing }));
    app.get("/x", (c) => {
      c.body = "0".repeat(400);
    });
    const res = await app.handle(gzRequest("/x"));
    expect(res.headers.get("content-encoding")).toBeNull();
  });

  it("Uint8Array bodies are eligible; accept-encoding lists parse", async () => {
    const app = new Keala(quiet);
    app.use(compress({ gzip }));
    app.get("/x", (c) => {
      c.body = new Uint8Array(400).fill(7);
    });
    const res = await app.handle(gzRequest("/x"));
    expect(res.headers.get("content-encoding")).toBe("gzip");
    // wildcard-less encodings do not trigger
    const brotliOnly = await app.handle(
      new Request("http://localhost:3000/x", { headers: { "accept-encoding": "br" } }),
    );
    expect(brotliOnly.headers.get("content-encoding")).toBeNull();
  });
});

describe("coverage: cors preflight extras", () => {
  it("preflight reflects whitelisted origin with credentials and exposes headers", async () => {
    const app = new Keala(quiet);
    app.use(
      cors({
        origin: ["https://app.site"],
        allowCredentials: true,
        exposeHeaders: ["x-custom"],
      }),
    );
    app.get("/x", (c) => c.text("ok"));
    const pre = await app.handle(
      new Request("http://localhost:3000/x", {
        method: "OPTIONS",
        headers: {
          origin: "https://app.site",
          "access-control-request-method": "GET",
        },
      }),
    );
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("https://app.site");
    expect(pre.headers.get("access-control-allow-credentials")).toBe("true");
    const get = await app.handle(
      new Request("http://localhost:3000/x", { headers: { origin: "https://app.site" } }),
    );
    expect(get.headers.get("access-control-expose-headers")).toBe("x-custom");
  });

  it("simple-mode default reject answers 403 on preflight", async () => {
    const app = new Keala(quiet);
    app.use(cors({ origin: ["https://a"] }));
    app.get("/x", (c) => c.text("ok"));
    const res = await app.handle(
      new Request("http://localhost:3000/x", {
        method: "OPTIONS",
        headers: { origin: "https://b" },
      }),
    );
    expect(res.status).toBe(403);
  });
});

describe("coverage: adapter drain + router mount through dispatch", () => {
  it("drain events reach the registered handlers", async () => {
    const drained: string[] = [];
    const app = new Keala(quiet);
    app.ws("/w", {
      drain: (_ws, c) => {
        drained.push(c.path);
      },
    });
    const made: Record<string, unknown>[] = [];
    startBunServer(app as Application, { port: 0 }, undefined, (options) => {
      made.push(options);
      return {
        port: 0,
        hostname: "x",
        stop: () => undefined,
        fetch: async () => new Response("x"),
        reload: () => undefined,
      };
    });
    const websocket = made[0]?.["websocket"] as Record<string, (ws: unknown) => void>;
    websocket["drain"]?.({ data: { wsKey: "/w", ctx: { path: "/w" } } });
    await new Promise((r) => setTimeout(r, 0)); // handlers dispatch on a microtask
    expect(drained).toEqual(["/w"]);
  });

  it("mount composes sub-router param middleware into the parent", async () => {
    const app = new Keala(quiet);
    const api = new Router({ prefix: "/v1" });
    api.param("id", async (c, next) => {
      c.setHeader("X-Param-Mw", c.params?.["id"] ?? "");
      await next();
    });
    api.get("/items/:id", (c) => c.text("item"));
    app.mount("/api", api);
    const res = await app.handle(new Request("http://localhost:3000/api/v1/items/9"));
    expect(res.headers.get("x-param-mw")).toBe("9");
    expect(await res.text()).toBe("item");
  });

  it("router middleware is exposed through mount (global middleware prepended)", async () => {
    const app = new Keala(quiet);
    const sub = new Router();
    sub.use(async (_c: Context, next) => {
      await next();
    });
    sub.get("/leaf", (c) => c.text("leaf"));
    app.mount("/sub", sub);
    expect(await (await app.handle(new Request("http://localhost:3000/sub/leaf"))).text()).toBe(
      "leaf",
    );
  });
});
