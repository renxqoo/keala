import { describe, expect, it } from "vitest";

import { registerBranch, drainBranches } from "../src/core/branches.ts";
import { direct, NOOP_TAIL, type MiddlewareContext } from "../src/core/compose.ts";
import { baseContextProto, createContext } from "../src/core/context/context.ts";
import { createPool, deadProtoFor } from "../src/core/context/pool.ts";
import { FLAG_DEV_CHAIN } from "../src/core/context/state.ts";
import { settleNativeHandle } from "../src/core/dispatch.ts";
import { Keala } from "../src/core/app.ts";
import {
  NATIVE_REQUEST_SOURCE,
  sourceAbsoluteUrl,
  sourceBody,
  sourceBytes,
  sourceHeader,
  sourceHeaders,
  sourceRequest,
  type NativeRequestSource,
} from "../src/core/request-source.ts";
import { createPlannedResponse } from "../src/core/response-plan.ts";
import { createRouterState, registerDef } from "../src/router/router.ts";

describe("R4.5 internal lifecycle contracts", () => {
  it("rejects invalid direct return values instead of treating them as response bodies", async () => {
    for (const value of [0, false, "body", {}]) {
      const app = new Keala({ env: "test" });
      const errors: string[] = [];
      app.onError((error) => {
        errors.push(error.message);
      });
      app.get("/invalid", () => value as never);
      const response = await app.handle(new Request("http://localhost/invalid"));
      expect(response.status).toBe(500);
      expect(errors).toEqual([
        `handler returned ${typeof value}; only Response, undefined or null are valid`,
      ]);
      expect(await response.text()).toBe("Internal Server Error");
    }
  });
  it("rejects a non-Promise thenable from a direct handler through the same error funnel", async () => {
    const app = new Keala({ env: "test" });
    const errors: string[] = [];
    app.onError((error) => {
      errors.push(error.message);
    });
    // Deliberately malformed handler result: exercise the rejection guard.
    // oxlint-disable-next-line unicorn/no-thenable
    app.get("/thenable", () => ({ then: () => undefined }) as never);
    const response = await app.handle(new Request("http://localhost/thenable"));
    expect(response.status).toBe(500);
    expect(errors).toEqual(["handler returned a promise — await it inside the handler instead"]);
    expect(await response.text()).toBe("Internal Server Error");
  });
  it("B45-15: async direct response inspection failures never reject handle", async () => {
    const app = new Keala({ env: "test" });
    const seen: string[] = [];
    app.onError((error) => {
      seen.push(error.message);
    });
    app.get(
      "/getter",
      async () =>
        new Proxy(new Response("body"), {
          get(target, key) {
            if (key === "status") throw new Error("response getter failed");
            return Reflect.get(target, key, target) as unknown;
          },
        }),
    );
    const result = await app.handle(new Request("http://localhost/getter"));
    expect(result.status).toBe(500);
    expect(seen).toEqual(["response getter failed"]);
    expect(await result.text()).not.toContain("response getter failed");
  });

  it("keeps the exported direct chain async commit behavior", async () => {
    const context: MiddlewareContext = { state: Object.create(null), _res: undefined };
    const chain = direct(async () => new Response("async"));
    await chain(context, NOOP_TAIL);
    expect(await context._res?.text()).toBe("async");
  });

  it("drains multiple floating branches including rejection", async () => {
    const host = {};
    registerBranch(host, Promise.resolve("ok"));
    registerBranch(host, Promise.reject(new Error("observed")));
    await expect(drainBranches(host)).resolves.toBeUndefined();
  });

  it("creates an exported development context with tracing enabled", () => {
    const app = new Keala({ env: "development" });
    const context = createContext(
      app,
      baseContextProto,
      new Request("http://localhost/"),
      undefined,
    );
    expect(context.flags & FLAG_DEV_CHAIN).toBe(FLAG_DEV_CHAIN);
    expect(() => settleNativeHandle(null, true, context, new Response(null))).toThrow(
      "pooling dispatch requires a context pool",
    );
  });

  it("reuses one native materialization and rejects invalid router handlers", () => {
    const response = createPlannedResponse("body");
    const body = response.body;
    expect(response.body).toBe(body);
    body?.getReader().releaseLock();

    expect(() =>
      registerDef(createRouterState(), "GET", "/bad", [1 as unknown as () => undefined]),
    ).toThrow("Route handlers must be functions");
  });

  it("dispatches every request-source accessor without materializing native inputs", async () => {
    const raw = new Request("http://localhost/fetch", {
      method: "POST",
      headers: { "x-source": "fetch" },
      body: "fetch-body",
    });
    expect(sourceHeader(raw, "x-source")).toBe("fetch");
    expect(sourceAbsoluteUrl(raw)).toBe(raw.url);
    expect(sourceHeaders(raw)).toBe(raw.headers);
    expect(sourceRequest(raw)).toBe(raw);
    expect(sourceBody(raw)).toBe(raw.body);
    expect(new TextDecoder().decode(await sourceBytes(raw))).toBe("fetch-body");

    const nativeRequest = new Request("http://localhost/native");
    const nativeHeaders = new Headers({ "x-source": "native" });
    const nativeBody = new ReadableStream<Uint8Array>();
    const native: NativeRequestSource = {
      [NATIVE_REQUEST_SOURCE]: true,
      method: "GET",
      url: nativeRequest.url,
      absoluteUrl: () => nativeRequest.url,
      header: (name) => nativeHeaders.get(name),
      headers: () => nativeHeaders,
      request: () => nativeRequest,
      body: () => nativeBody,
      bytes: async () => new TextEncoder().encode("native-body"),
    };
    expect(sourceHeader(native, "x-source")).toBe("native");
    expect(sourceAbsoluteUrl(native)).toBe(nativeRequest.url);
    expect(sourceHeaders(native)).toBe(nativeHeaders);
    expect(sourceRequest(native)).toBe(nativeRequest);
    expect(sourceBody(native)).toBe(nativeBody);
    expect(new TextDecoder().decode(await sourceBytes(native, 32))).toBe("native-body");
  });

  it("keeps an empty pool observable and builds a write-only dead prototype", () => {
    const app = new Keala({ env: "test" });
    const live = Object.create(null) as object;
    const dead = deadProtoFor(live) as { status: number };
    expect(dead.status).toBeUndefined();
    expect(() => {
      dead.status = 200;
    }).toThrow("context retired");

    const pool = createPool(app, live);
    expect(pool.size).toBe(0);
    expect(pool.acquire()).toBeUndefined();
    const context = Object.create(live);
    pool.release(context);
    expect(pool.size).toBe(1);
    expect(pool.acquire()).toBe(context);
    expect(pool.size).toBe(0);
  });

  it("normalizes record-form numeric and boolean response headers", async () => {
    const app = new Keala({ env: "test" });
    app.get("/headers", (c) => {
      c.set({ "x-count": 2, "x-enabled": true } as never);
      return c.text("ok");
    });
    const response = await app.handle(new Request("http://localhost/headers"));
    expect(response.headers.get("x-count")).toBe("2");
    expect(response.headers.get("x-enabled")).toBe("true");
    expect(await response.text()).toBe("ok");
  });

  it("rejects ambiguous singleton response-header writes", () => {
    const app = new Keala({ env: "test" });
    const context = createContext(
      app,
      baseContextProto,
      new Request("http://localhost/"),
      undefined,
    );
    expect(() => context.set("content-type", ["text/plain", "application/json"])).toThrow(
      "singleton header",
    );
    expect(() => context.append("content-length", ["1", "2"])).toThrow("singleton header");
    context.set("content-type", "text/plain");
    expect(() => context.append("content-type", "application/json")).toThrow("cannot be appended");
    context.set("x-undefined", undefined as unknown as string);
    context.set("x-null", null as unknown as string);
    expect(context.resHeader("x-undefined")).toBe("");
    expect(context.resHeader("x-null")).toBe("");
  });

  it("restores an implicit text content-type before a post-commit header write", async () => {
    const app = new Keala({ env: "test" });
    app.get("/bun-text-compat", (c) => {
      const response = c.text("body");
      response.headers.delete("content-type");
      c._res = response;
      c.set("x-after-commit", "yes");
    });
    const response = await app.handle(new Request("http://localhost/bun-text-compat"));
    expect(response.headers.get("content-type")).toMatch(/^text\/plain/i);
    expect(response.headers.get("x-after-commit")).toBe("yes");
    expect(await response.text()).toBe("body");
  });
});
