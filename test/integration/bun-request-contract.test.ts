import { describe, expect, it } from "vitest";
import http from "node:http";
import { Keala } from "../../src/core/app.ts";
import type { Context } from "../../src/core/context/context.ts";

const rawGet = (port: number, path: string, host?: string) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = http.get(
      { hostname: "127.0.0.1", port, path, headers: host ? { host } : {}, timeout: 2000 },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode!, body }));
      },
    );
    request.on("timeout", () => request.destroy(new Error("test HTTP timeout")));
    request.on("error", reject);
  });

describe.skipIf(typeof Bun === "undefined")("Bun request compatibility contracts", () => {
  it("preserves raw Request surface, descriptors, clone, body, signal and IP", async () => {
    for (const nativeRoutes of [false, true]) {
      const app = new Keala({ env: "test" });
      app.post("/user", async (c) => {
        const raw = c.raw as Request & {
          params?: unknown;
          cookies?: unknown;
          ip?: string;
          runtime?: { name: string };
          waitUntil?: unknown;
        };
        const clone = raw.clone();
        expect(Object.getPrototypeOf(raw)).toBe(Request.prototype);
        expect(Object.getPrototypeOf(clone)).toBe(Request.prototype);
        expect(raw.params).toBeUndefined();
        expect(raw.cookies).toBeUndefined();
        expect(Object.keys(raw)).toEqual(["runtime", "ip"]);
        expect(Reflect.ownKeys(raw)).toEqual(["waitUntil", "runtime", "ip"]);
        expect(Object.getOwnPropertyDescriptor(raw, "runtime")).toMatchObject({
          enumerable: true,
          configurable: false,
          writable: false,
        });
        expect(Object.getOwnPropertyDescriptor(raw, "waitUntil")).toMatchObject({
          enumerable: false,
          configurable: false,
          writable: false,
        });
        expect(Object.getOwnPropertyDescriptor(raw, "ip")).toMatchObject({
          enumerable: true,
          configurable: true,
        });
        expect(raw.runtime?.name).toBe("bun");
        expect(typeof raw.waitUntil).toBe("function");
        expect(raw.ip).toBe(c.ip);
        expect(raw.signal).toBeInstanceOf(AbortSignal);
        expect(raw.signal.aborted).toBe(false);
        return c.json({
          original: await raw.text(),
          cloned: await clone.text(),
          path: c.path,
          url: c.url,
          query: c.query("q"),
        });
      });
      const server = app.listen({ port: 0, hostname: "127.0.0.1", nativeRoutes });
      try {
        const response = await fetch(`http://127.0.0.1:${server.port}/user?q=1`, {
          method: "POST",
          body: "payload",
        });
        expect(await response.json()).toEqual({
          original: "payload",
          cloned: "payload",
          path: "/user",
          url: "/user?q=1",
          query: "1",
        });
      } finally {
        await app.close({ drain: 100 });
      }
    }
  });

  it("matches JS dispatch for encoded/raw targets, methods and malformed Host", async () => {
    const apps = [false, true].map((nativeRoutes) => {
      const app = new Keala({ env: "test" });
      app.use(async (c, next) => {
        c.setHeader("x-policy", "yes");
        await next();
      });
      app.get("named", "/user", (c) =>
        c.json({
          path: c.path,
          url: c.url,
          query: c.querystring,
          pattern: c.routePath,
          name: c.routeName,
        }),
      );
      app.get("/user/:id", (c) => c.text(c.params("id") ?? "missing"));
      const server = app.listen({ port: 0, hostname: "127.0.0.1", nativeRoutes });
      return { app, server };
    });
    try {
      for (const path of [
        "/user",
        "/user?x=1&x=2",
        "/%75ser",
        "/u%73er",
        "/user/",
        "//user",
        "/User",
        "/user%2F",
        "/user//",
        "/user/../user",
        "/user#fragment",
        "http://other.test/user?x=1",
      ]) {
        const results = await Promise.all(apps.map(({ server }) => rawGet(server.port, path)));
        expect(results[1], path).toEqual(results[0]);
      }
      for (const host of [
        "example.test",
        "example.test/x",
        "example.test?x",
        "example.test#x",
        "example.test:9999",
        "[::1]:1234",
      ]) {
        const results = await Promise.all(
          apps.map(({ server }) => rawGet(server.port, "/user?x=1", host)),
        );
        expect(results[1], host).toEqual(results[0]);
      }
      for (const method of ["GET", "HEAD", "POST", "OPTIONS", "PATCH"]) {
        const results = await Promise.all(
          apps.map(async ({ server }) => {
            const response = await fetch(`http://127.0.0.1:${server.port}/user`, { method });
            return [
              response.status,
              response.headers.get("allow"),
              response.headers.get("x-policy"),
              await response.text(),
            ];
          }),
        );
        expect(results[1], method).toEqual(results[0]);
      }
    } finally {
      await Promise.all(apps.map(({ app }) => app.close({ drain: 100 })));
    }
  });

  it("observes same-target registration, middleware rebuild and new paths", async () => {
    const app = new Keala({ env: "test" });
    app.get("seed", "/user", (_c, next) => next());
    const server = app.listen({ port: 0, hostname: "127.0.0.1" });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      expect((await fetch(base + "/user")).status).toBe(404);
      app.get("last", "/user", (c) => c.text(c.routeName + ":" + c.path));
      expect(await (await fetch(base + "/user")).text()).toBe("last:/user");
      app.use(async (c, next) => {
        await next();
        c.setHeader("x-live", "yes");
      });
      const response = await fetch(base + "/user");
      expect(await response.text()).toBe("last:/user");
      expect(response.headers.get("x-live")).toBe("yes");
      app.get("/late", (c) => c.text("late"));
      expect(await (await fetch(base + "/late")).text()).toBe("late");
    } finally {
      await app.close({ drain: 100 });
    }
  });

  it("preserves native fetch-only reload replacement behavior", async () => {
    const app = new Keala({ env: "test" });
    app.get("/user", (c) => c.text("original"));
    app.sink("/sink", new Response("sink"));
    const server = app.listen({ port: 0, hostname: "127.0.0.1" });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      expect(await (await fetch(base + "/user")).text()).toBe("original");
      expect(await (await fetch(base + "/sink")).text()).toBe("sink");
      server.reload({
        fetch: (request: Request) => {
          expect(Object.getPrototypeOf(request)).toBe(Request.prototype);
          expect(Reflect.ownKeys(request)).toEqual([]);
          return new Response("reloaded");
        },
      });
      expect(await (await fetch(base + "/user")).text()).toBe("reloaded");
      expect(await (await fetch(base + "/other")).text()).toBe("reloaded");
      expect(await (await fetch(base + "/sink")).text()).toBe("reloaded");
    } finally {
      await app.close({ drain: 100 });
    }
  });

  it("supports late first URL observation after response completion", async () => {
    const app = new Keala({ env: "test" });
    let saved: Context | undefined;
    app.get("/user", (c) => {
      saved = c;
      return c.text(c.path);
    });
    const server = app.listen({ port: 0, hostname: "127.0.0.1" });
    try {
      expect(await (await fetch(`http://127.0.0.1:${server.port}/user?q=late`)).text()).toBe(
        "/user",
      );
      expect(saved!.url).toBe("/user?q=late");
      expect(saved!.query("q")).toBe("late");
    } finally {
      await app.close({ drain: 100 });
    }
  });

  it("uses ordinary dispatch for direct server.fetch and custom Request sources", async () => {
    const app = new Keala({ env: "test" });
    app.get("/user", (c) => c.json({ path: c.path }));
    const server = app.listen({ port: 0, hostname: "127.0.0.1" });
    class CustomRequest extends Request {
      marker = "custom";
    }
    try {
      const raw = new CustomRequest(`http://127.0.0.1:${server.port}/user`);
      expect(await (await server.fetch(raw)).json()).toEqual({ path: "/user" });
      expect(Object.getPrototypeOf(raw)).toBe(CustomRequest.prototype);
    } finally {
      await app.close({ drain: 100 });
    }
  });
});
