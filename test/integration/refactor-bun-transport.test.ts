import { describe, expect, it, vi } from "vitest";
import { Keala } from "../../src/core/app.ts";
import { streamSSE } from "../../src/helpers/streams.ts";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(typeof Bun === "undefined")("srvx Bun transport and policy parity", () => {
  it("leaves startup ownership with a loader-provided handle without a URL", async () => {
    const app = new Keala({ env: "test" });
    const handle = {
      port: 54321,
      hostname: "127.0.0.1",
      stop: vi.fn(),
      reload: vi.fn(),
      fetch: async () => new Response("loader"),
    };
    vi.stubGlobal("__srvxLoader__", ({ server }: { server: { bun: { server?: unknown } } }) => {
      server.bun.server = handle;
    });
    try {
      expect(app.listen({ port: 0, hostname: "127.0.0.1" })).toBe(handle);
      expect(await (await handle.fetch()).text()).toBe("loader");
    } finally {
      vi.unstubAllGlobals();
      await app.close({ drain: 0 });
      handle.stop(true);
    }
  });

  it("preserves request metadata descriptors, isolation and waitUntil shutdown", async () => {
    type TransportRequest = Request & {
      waitUntil(task: Promise<void>): void;
      runtime: { name: string; bun: { server: unknown }; marker?: string };
      readonly ip: string;
    };
    const app = new Keala({ env: "test" });
    const requests: TransportRequest[] = [];
    const addresses: string[] = [];
    let release!: () => void;
    const task = new Promise<void>((resolve) => {
      release = resolve;
    });
    app.get("/", (c) => {
      const raw = c.raw as TransportRequest;
      requests.push(raw);
      if (requests.length === 1) {
        raw.waitUntil(task);
        raw.runtime.bun.server = null;
      }
      // Bun owns the peer address while the request is active.
      addresses.push(raw.ip);
      return c.text("ok");
    });
    const server = app.listen({ port: 0, hostname: "127.0.0.1" });
    try {
      const url = `http://127.0.0.1:${server.port}/`;
      expect(await (await fetch(url)).text()).toBe("ok");
      const first = requests[0]!;
      expect(Object.getOwnPropertyDescriptor(first, "runtime")).toEqual({
        value: first.runtime,
        writable: false,
        enumerable: true,
        configurable: false,
      });
      expect(Object.getOwnPropertyDescriptor(first, "waitUntil")).toMatchObject({
        value: first.waitUntil,
        writable: false,
        enumerable: false,
        configurable: false,
      });
      expect(Object.getOwnPropertyDescriptor(first, "ip")).toMatchObject({
        get: expect.any(Function),
        enumerable: true,
        configurable: true,
      });
      expect(Object.getOwnPropertyDescriptor(first, "ip")!.get!.name).toBe("get");
      first.runtime.marker = "first";
      expect(addresses[0]).toBe("127.0.0.1");
      expect(await (await fetch(url)).text()).toBe("ok");
      const second = requests[1]!;
      expect(second.runtime).not.toBe(first.runtime);
      expect(second.runtime.name).toBe("bun");
      expect(second.runtime.marker).toBeUndefined();
      expect(second.runtime.bun.server).toBe(server);
      expect(second.waitUntil).toBe(first.waitUntil);
      let closed = false;
      const closing = app.close({ drain: 500 }).then((status) => {
        closed = true;
        return status;
      });
      await delay(20);
      expect(closed).toBe(false);
      release();
      expect((await closing).timedOut).toBe(false);
    } finally {
      release();
      await app.close({ drain: 0 });
      server.stop(true);
    }
  });

  it("keeps descriptor values isolated through synchronous metadata reentry and errors", async () => {
    type Fetch = (
      request: Request,
      server: { requestIP(request: Request): { address: string } },
    ) => Response | Promise<Response>;
    let dispatch!: Fetch;
    const nativeServe = Bun.serve;
    const serve = vi.spyOn(Bun, "serve").mockImplementation(((options: { fetch: Fetch }) => {
      dispatch = options.fetch;
      return Reflect.apply(nativeServe, Bun, [options]);
    }) as typeof Bun.serve);
    const app = new Keala({ env: "test" });
    app.get("/", (c) => c.text(c.ip!));
    const server = app.listen({ port: 0, hostname: "127.0.0.1" });
    serve.mockRestore();
    const outer = new Request("http://example.test/");
    const inner = new Request("http://example.test/");
    const outerHost = {
      requestIP: (request: Request) => ({ address: request === outer ? "outer" : "wrong" }),
    };
    const innerHost = {
      requestIP: (request: Request) => ({ address: request === inner ? "inner" : "wrong" }),
    };
    const nativeDefine = Object.defineProperty;
    let nested: Response | Promise<Response> | undefined;
    const define = vi
      .spyOn(Object, "defineProperty")
      .mockImplementation((target, key, descriptor) => {
        if (target === outer && key === "runtime") nested = dispatch(inner, innerHost);
        return nativeDefine(target, key, descriptor);
      });
    try {
      const response = dispatch(outer, outerHost);
      define.mockRestore();
      expect(await (await response).text()).toBe("outer");
      expect(await (await nested!).text()).toBe("inner");
      expect(Reflect.get(outer, "runtime").bun.server).toBe(outerHost);
      expect(Reflect.get(inner, "runtime").bun.server).toBe(innerHost);
      expect(Object.getOwnPropertyDescriptor(outer, "ip")!.get!.call(inner)).toBe("outer");
      const rejected = new Request("http://example.test/");
      const fault = new Error("metadata fault");
      const fail = vi
        .spyOn(Object, "defineProperty")
        .mockImplementation((target, key, descriptor) => {
          if (target === rejected && key === "runtime") throw fault;
          return nativeDefine(target, key, descriptor);
        });
      try {
        expect(() => dispatch(rejected, outerHost)).toThrow(fault);
      } finally {
        fail.mockRestore();
      }
      const after = new Request("http://example.test/");
      const afterHost = { requestIP: () => ({ address: "after" }) };
      expect(await (await dispatch(after, afterHost)).text()).toBe("after");
      expect(Reflect.get(after, "runtime").bun.server).toBe(afterHost);
    } finally {
      define.mockRestore();
      serve.mockRestore();
      await app.close({ drain: 100 });
      server.stop(true);
    }
  });

  it("keeps Host protection on native sink mirrors, including late registrations", async () => {
    const app = new Keala({ env: "test", trustedHosts: ["trusted.test"] });
    app.sink("/early", () => new Response("protected"));
    const server = app.listen({ port: 0, hostname: "127.0.0.1" });
    app.sink("/late", () => new Response("protected"));
    try {
      for (const path of ["/early", "/late"]) {
        const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
          headers: { host: "evil.test" },
        });
        expect(response.status).toBe(403);
        await response.text();
      }
    } finally {
      await app.close({ drain: 100 });
    }
  });
  it("applies concurrency and deadlines to a sunk function", async () => {
    const app = new Keala({ env: "test", overload: { maxConcurrency: 1 }, requestTimeout: 20 });
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    app.sink("/slow", async () => {
      enter();
      await gate;
      return new Response("late");
    });
    const server = app.listen({ port: 0, hostname: "127.0.0.1" });
    try {
      const first = fetch(`http://127.0.0.1:${server.port}/slow`);
      await entered;
      const second = await fetch(`http://127.0.0.1:${server.port}/slow`);
      expect(second.status).toBe(503);
      await second.text();
      const timedOut = await first;
      expect(timedOut.status).toBe(504);
      await timedOut.text();
    } finally {
      release();
      await app.close({ drain: 100 });
    }
  });
  it("waits for a stream started before close before running shutdown hooks", async () => {
    const app = new Keala({ env: "test" });
    let release!: () => void;
    let hooks = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    app.get("/events", (c) =>
      streamSSE(
        c,
        async (writer) => {
          writer.send({ data: "first" });
          await gate;
          writer.send({ data: "last" });
        },
        { heartbeat: 0 },
      ),
    );
    app.onShutdown(() => {
      hooks++;
    });
    const server = app.listen({ port: 0, hostname: "127.0.0.1" });
    const response = await fetch(`http://127.0.0.1:${server.port}/events`);
    const reader = response.body!.getReader();
    await reader.read();
    let closed = false;
    const closing = app.close({ drain: 500 }).then((status) => {
      closed = true;
      return status;
    });
    try {
      await delay(10);
      expect(closed).toBe(false);
      expect(hooks).toBe(0);
      release();
      while (!(await reader.read()).done) {
        /* consume the remaining frames */
      }
      expect((await closing).timedOut).toBe(false);
      expect(hooks).toBe(1);
    } finally {
      release();
      await reader.cancel().catch(() => undefined);
      server.stop(true);
      await closing;
    }
  });
  it("closes a late websocket upgrade before awaiting native transport shutdown", async () => {
    const app = new Keala({ env: "test" });
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    app.use("/ws", async (_c, next) => {
      entered();
      await gate;
      await next();
    });
    app.ws("/ws", {});
    const server = app.listen({ port: 0, hostname: "127.0.0.1" });
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    const closed = new Promise<number>((resolve, reject) => {
      socket.onclose = (event) => resolve(event.code);
      socket.onerror = () => reject(new Error("websocket handshake failed"));
    });
    try {
      await waiting;
      const closing = app.close({ drain: 500 });
      release();
      expect(await closed).toBe(1001);
      expect((await closing).timedOut).toBe(false);
    } finally {
      release();
      socket.close();
      server.stop(true);
    }
  });
  it("forces an existing SSE closed at the drain deadline", async () => {
    const app = new Keala({ env: "test" });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    app.get("/events", (c) =>
      streamSSE(
        c,
        async (writer) => {
          writer.send({ data: "first" });
          await gate;
        },
        { heartbeat: 0 },
      ),
    );
    const server = app.listen({ port: 0, hostname: "127.0.0.1" });
    const response = await fetch(`http://127.0.0.1:${server.port}/events`);
    const reader = response.body!.getReader();
    await reader.read();
    try {
      const status = await app.close({ drain: 20 });
      expect(status.timedOut).toBe(true);
      const result = await reader.read().then(
        (read) => read.done,
        () => true,
      );
      expect(result).toBe(true);
    } finally {
      finish();
      await reader.cancel().catch(() => undefined);
      server.stop(true);
    }
  });
  it("keeps Bun's native default bind address when HOST is present", async () => {
    const previous = process.env.HOST;
    process.env.HOST = "127.0.0.1";
    const app = new Keala({ env: "test" });
    const native = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    try {
      const server = app.listen({ port: 0 });
      expect(server.hostname).toBe(native.hostname);
    } finally {
      if (previous === undefined) delete process.env.HOST;
      else process.env.HOST = previous;
      await app.close({ drain: 100 });
      await native.stop(true);
    }
  });
});
