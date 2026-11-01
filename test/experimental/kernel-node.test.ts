import { afterEach, describe, expect, it } from "vitest";
import { Agent, request } from "node:http";
import { connect, type Socket } from "node:net";
import { once } from "node:events";
import { Kernel } from "../../experimental/kernel/kernel.ts";
import { Reply } from "../../experimental/kernel/reply.ts";
import { listenNode, type NodeHandle } from "../../experimental/kernel/node.ts";

const handles: NodeHandle[] = [],
  sockets: Socket[] = [],
  agents: Agent[] = [];
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const start = async (kernel: Kernel) => {
  const server = await listenNode(kernel, { port: 0, hostname: "127.0.0.1" });
  handles.push(server);
  return server;
};
const get = (port: number, path = "/", method = "GET", body?: string, agent?: Agent) =>
  new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: string }>(
    (resolve, reject) => {
      const outgoing = request(
        {
          host: "127.0.0.1",
          port,
          path,
          method,
          agent,
          headers: body === undefined ? {} : { "content-length": Buffer.byteLength(body) },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.once("error", reject);
          response.once("end", () =>
            resolve({
              status: response.statusCode!,
              headers: response.headers,
              body: Buffer.concat(chunks).toString(),
            }),
          );
        },
      );
      outgoing.once("error", reject);
      outgoing.end(body);
    },
  );
const connection = async (port: number) => {
  const socket = connect(port, "127.0.0.1");
  sockets.push(socket);
  socket.on("error", () => undefined);
  await once(socket, "connect");
  return socket;
};
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const agent of agents.splice(0)) agent.destroy();
  await Promise.all(handles.splice(0).map((handle) => handle.close(0)));
});

describe.skipIf(process.versions.bun !== undefined)("experimental native Node kernel", () => {
  it("applies scoped policy after standard pathname normalization", async () => {
    const kernel = new Kernel()
      .use("/secure", () => new Reply("denied", 403))
      .route("GET", "/*", (req) => new Response(new URL(req.url).pathname));
    const server = await start(kernel);
    for (const target of [
      "/secure/secret",
      "/public/../secure/secret",
      "/public/%2e%2e/secure/secret",
      "/public\\..\\secure/secret",
    ])
      expect(await get(server.port, target)).toMatchObject({ status: 403, body: "denied" });
  });
  it("serves UTF-8 text and params without constructing Fetch objects", async () => {
    const kernel = new Kernel()
      .text("GET", "/", () => "你好")
      .text("GET", "/user/:name", (params) => params.name!);
    const server = await start(kernel);
    const NativeRequest = globalThis.Request,
      NativeResponse = globalThis.Response;
    let requests = 0,
      responses = 0;
    globalThis.Request = new Proxy(NativeRequest, {
      construct() {
        requests++;
        throw new Error("unexpected Request");
      },
    });
    globalThis.Response = new Proxy(NativeResponse, {
      construct() {
        responses++;
        throw new Error("unexpected Response");
      },
    });
    try {
      const result = await get(server.port);
      expect(result).toMatchObject({
        status: 200,
        body: "你好",
        headers: { "content-length": "6", "content-type": "text/plain; charset=utf-8" },
      });
      expect((await get(server.port, "/user/a%2Fb?q=x")).body).toBe("a/b");
      expect([requests, responses]).toEqual([0, 0]);
    } finally {
      globalThis.Request = NativeRequest;
      globalThis.Response = NativeResponse;
    }
  });

  it("settles async text and maps rejected handlers", async () => {
    const kernel = new Kernel()
      .text("GET", "/", async () => {
        await Promise.resolve();
        return "ASYNC";
      })
      .text("GET", "/bad", () => Promise.reject(new Error("failure")))
      .onError(() => new Reply("mapped", 502));
    const server = await start(kernel);
    expect(await get(server.port)).toMatchObject({ status: 200, body: "ASYNC" });
    expect(await get(server.port, "/bad")).toMatchObject({ status: 502, body: "mapped" });
  });

  it("materializes standard Fetch Request only for Fetch routes and echoes POST", async () => {
    const kernel = new Kernel().route("POST", "/echo/:id", async (incoming, params) => {
      expect(Object.getPrototypeOf(incoming)).toBe(Request.prototype);
      expect(Reflect.ownKeys(incoming)).not.toContain("runtime");
      expect(incoming.url).toContain("/echo/7?q=yes");
      expect(incoming.signal.aborted).toBe(false);
      return new Response(params.id + ":" + (await incoming.text()), {
        status: 201,
        headers: { "x-result": "fetch" },
      });
    });
    const server = await start(kernel);
    expect(await get(server.port, "/echo/7?q=yes", "POST", "payload")).toMatchObject({
      status: 201,
      body: "7:payload",
      headers: { "x-result": "fetch" },
    });
  });

  it("strips HEAD bodies and supplies 404/405/OPTIONS with independent expectations", async () => {
    const kernel = new Kernel().text("GET", "/hello", () => "hello");
    const server = await start(kernel);
    expect(await get(server.port, "/hello", "HEAD")).toMatchObject({
      status: 200,
      body: "",
      headers: { "content-length": "5" },
    });
    expect(await get(server.port, "/hello", "POST")).toMatchObject({
      status: 405,
      body: "Method Not Allowed",
      headers: { allow: "GET, HEAD, OPTIONS" },
    });
    expect(await get(server.port, "/hello", "OPTIONS")).toMatchObject({
      status: 204,
      body: "",
      headers: { allow: "GET, HEAD, OPTIONS" },
    });
    expect(await get(server.port, "/absent")).toMatchObject({ status: 404, body: "Not Found" });
    expect(await get(server.port, "/broken%XX")).toMatchObject({
      status: 400,
      body: "Bad Request",
    });
  });

  it("runs matching middleware around text and method misses", async () => {
    const events: string[] = [];
    const kernel = new Kernel()
      .use("/scoped", async (_incoming, next) => {
        events.push("before");
        const response = await next();
        events.push("after");
        response.headers.set("x-middleware", "yes");
        return response;
      })
      .text("GET", "/scoped/hello", () => {
        events.push("handler");
        return "hello";
      })
      .text("GET", "/other", () => "other");
    const server = await start(kernel);
    expect(await get(server.port, "/scoped/hello")).toMatchObject({
      body: "hello",
      headers: { "x-middleware": "yes" },
    });
    expect(events).toEqual(["before", "handler", "after"]);
    expect(await get(server.port, "/scoped/hello", "POST")).toMatchObject({
      status: 405,
      headers: { "x-middleware": "yes" },
    });
    expect((await get(server.port, "/other")).headers["x-middleware"]).toBeUndefined();
  });

  it("snapshots repeated Set-Cookie and owns framing for streamed Responses", async () => {
    const kernel = new Kernel().route("GET", "/", () => {
      const headers = new Headers({ "content-length": "999", "transfer-encoding": "chunked" });
      headers.append("set-cookie", "a=1; Path=/");
      headers.append("set-cookie", "b=2; Path=/");
      return new Response("correct", { headers });
    });
    const server = await start(kernel);
    const result = await get(server.port);
    expect(result.body).toBe("correct");
    expect(result.headers["content-length"]).toBeUndefined();
    expect(result.headers["set-cookie"]).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });

  it("maps invalid results and failures before the first stream byte", async () => {
    const kernel = new Kernel()
      .route(
        "GET",
        "/",
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error("producer"));
              },
            }),
          ),
      )
      .text("GET", "/invalid", (() => 17) as unknown as () => string)
      .onError(() => new Reply("safe", 500));
    const server = await start(kernel);
    expect(await get(server.port)).toMatchObject({ status: 500, body: "safe" });
    expect(await get(server.port, "/invalid")).toMatchObject({ status: 500, body: "safe" });
  });

  it("contains a failing error mapper", async () => {
    const server = await start(
      new Kernel()
        .text("GET", "/", () => {
          throw new Error("bad");
        })
        .onError(() => {
          throw new Error("mapper");
        }),
    );
    expect(await get(server.port)).toMatchObject({ status: 500, body: "Internal Server Error" });
  });

  it("keeps handler URIError in the 500 path", async () => {
    const server = await start(
      new Kernel().text("GET", "/", () => {
        throw new URIError("application bug");
      }),
    );
    expect(await get(server.port)).toMatchObject({ status: 500, body: "Internal Server Error" });
  });

  it("cancels the Fetch signal and stream when the client disconnects", async () => {
    const cancelled = deferred(),
      entered = deferred();
    let signal!: AbortSignal;
    const server = await start(
      new Kernel().route("GET", "/", (incoming) => {
        signal = incoming.signal;
        entered.resolve();
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("first"));
            },
            cancel() {
              cancelled.resolve();
            },
          }),
        );
      }),
    );
    const socket = await connection(server.port);
    socket.write("GET / HTTP/1.1\r\nHost: test\r\n\r\n");
    await entered.promise;
    await once(socket, "data");
    socket.destroy();
    await cancelled.promise;
    expect(signal.aborted).toBe(true);
    expect(await server.close(1000)).toEqual({ forced: false });
  });

  it("keeps successful Fetch signals live after ordinary keep-alive closure", async () => {
    let signal!: AbortSignal;
    const server = await start(
      new Kernel().route("GET", "/", (incoming) => {
        signal = incoming.signal;
        return new Response("ok");
      }),
    );
    const agent = new Agent({ keepAlive: true });
    agents.push(agent);
    expect((await get(server.port, "/", "GET", undefined, agent)).body).toBe("ok");
    agent.destroy();
    expect(await server.close(1000)).toEqual({ forced: false });
    expect(signal.aborted).toBe(false);
  });

  it(
    "waits for paused-client pipeline output after both text handlers return",
    { timeout: 10000 },
    async () => {
      const entered = deferred(),
        body = "x".repeat(8 * 1024 * 1024);
      const server = await start(
        new Kernel()
          .text("GET", "/large", () => body)
          .text("GET", "/last", () => {
            entered.resolve();
            return "LAST";
          }),
      );
      const socket = await connection(server.port);
      socket.pause();
      socket.write(
        "GET /large HTTP/1.1\r\nHost: test\r\n\r\nGET /last HTTP/1.1\r\nHost: test\r\n\r\n",
      );
      await entered.promise;
      let completed = false;
      const closing = server.close(5000).then((result) => {
        completed = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(completed).toBe(false);
      const chunks: Buffer[] = [];
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      const ended = once(socket, "end");
      socket.resume();
      await ended;
      expect(await closing).toEqual({ forced: false });
      const wire = Buffer.concat(chunks).toString();
      expect(wire.match(/HTTP\/1\.1 200/g)).toHaveLength(2);
      expect(wire).toContain(body);
      expect(wire.endsWith("LAST")).toBe(true);
    },
  );

  it("bounds forced closure and cancels a pending producer", async () => {
    const cancelled = deferred();
    let signal!: AbortSignal;
    const server = await start(
      new Kernel().route("GET", "/", (incoming) => {
        signal = incoming.signal;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([65]));
            },
            cancel() {
              cancelled.resolve();
            },
          }),
        );
      }),
    );
    const socket = await connection(server.port);
    socket.write("GET / HTTP/1.1\r\nHost: test\r\n\r\n");
    await once(socket, "data");
    expect(await server.close(20)).toEqual({ forced: true });
    await cancelled.promise;
    expect(signal.aborted).toBe(true);
  });

  it("drains an unread Fetch upload before the next request on its connection", async () => {
    const server = await start(
      new Kernel()
        .route("POST", "/early", () => new Response("EARLY"))
        .text("GET", "/last", () => "LAST"),
    );
    const socket = await connection(server.port);
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    const ended = once(socket, "end");
    const body = "x".repeat(256 * 1024);
    socket.write(
      `POST /early HTTP/1.1\r\nHost: test\r\nContent-Length: ${body.length}\r\n\r\n${body}GET /last HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n`,
    );
    await ended;
    const wire = Buffer.concat(chunks).toString();
    expect(wire.match(/HTTP\/1\.1 200/g)).toHaveLength(2);
    expect(wire).toContain("EARLY");
    expect(wire.endsWith("LAST")).toBe(true);
  });

  it("abandons a pending upload reader after an early response", async () => {
    const failed = deferred();
    let signal!: AbortSignal;
    const server = await start(
      new Kernel().route("POST", "/", (incoming) => {
        signal = incoming.signal;
        void incoming.text().catch(() => failed.resolve());
        return new Response("EARLY", { headers: { connection: "keep-alive" } });
      }),
    );
    const socket = await connection(server.port);
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    const ended = once(socket, "end");
    socket.write("POST / HTTP/1.1\r\nHost: test\r\nContent-Length: 1000000\r\n\r\nx");
    await ended;
    await failed.promise;
    expect(Buffer.concat(chunks).toString()).toContain("EARLY");
    expect(signal.aborted).toBe(true);
    expect(await server.close(1000)).toEqual({ forced: false });
  });

  it.each(["direct", "through", "piped"])(
    "streams a %s request body without stealing its reader",
    async (mode) => {
      let signal!: AbortSignal;
      const server = await start(
        new Kernel().route("POST", "/", (incoming) => {
          signal = incoming.signal;
          const body = incoming.body!;
          if (mode === "direct") return new Response(body);
          const transform = new TransformStream<Uint8Array, Uint8Array>();
          if (mode === "through") return new Response(body.pipeThrough(transform));
          void body.pipeTo(transform.writable).catch(() => undefined);
          return new Response(transform.readable);
        }),
      );
      const payload = "echo".repeat(32 * 1024);
      expect(await get(server.port, "/", "POST", payload)).toMatchObject({
        status: 200,
        body: payload,
      });
      expect(signal.aborted).toBe(false);
    },
  );

  it("closes an abandoned reader that was locked without a read", async () => {
    let held!: { read(): Promise<unknown>; releaseLock(): void }, signal!: AbortSignal;
    const server = await start(
      new Kernel().route("POST", "/", (incoming) => {
        held = incoming.body!.getReader();
        signal = incoming.signal;
        return new Response("EARLY");
      }),
    );
    const socket = await connection(server.port),
      chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    const ended = once(socket, "end");
    socket.write("POST / HTTP/1.1\r\nHost: test\r\nContent-Length: 1000000\r\n\r\nx");
    await ended;
    expect(Buffer.concat(chunks).toString()).toContain("EARLY");
    expect(signal.aborted).toBe(true);
    await expect(held.read()).rejects.toThrow();
    held.releaseLock();
  });

  it("rejects Host delimiters before constructing a Fetch request", async () => {
    let called = 0;
    const server = await start(
      new Kernel().route("GET", "/", () => {
        called++;
        return new Response("unsafe");
      }),
    );
    for (const host of ["x/evil", "x?query", "x#hash", "a@b", "x\\bad", "["]) {
      const socket = await connection(server.port),
        chunks: Buffer[] = [];
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      const ended = once(socket, "end");
      socket.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
      await ended;
      expect(Buffer.concat(chunks).toString()).toMatch(/^HTTP\/1\.1 400/);
    }
    expect(called).toBe(0);
  });

  it("is idempotent and can force an already pending close", async () => {
    const entered = deferred(),
      release = deferred();
    const server = await start(
      new Kernel().text("GET", "/", async () => {
        entered.resolve();
        await release.promise;
        return "late";
      }),
    );
    const socket = await connection(server.port);
    socket.write("GET / HTTP/1.1\r\nHost: test\r\n\r\n");
    await entered.promise;
    const closing = server.close(5000);
    expect(server.close(0)).toBe(closing);
    expect(await closing).toEqual({ forced: true });
    release.resolve();
    await expect(server.close()).resolves.toEqual({ forced: true });
  });
});
