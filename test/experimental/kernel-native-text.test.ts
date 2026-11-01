import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { Agent, request } from "node:http";
import { Kernel, type Executable } from "../../experimental/kernel/kernel.ts";
import { Reply } from "../../experimental/kernel/reply.ts";

interface Handle {
  port: number;
  close(): void;
}
type Listen = (
  executable: Executable,
  uws: unknown,
  options?: { port?: number; hostname?: string },
) => Promise<Handle>;
const probeUrl = new URL("../../bench/framework-compare/native-text.mjs", import.meta.url).href;
const { listenNativeText } = (await import(probeUrl)) as { listenNativeText: Listen };
const modulePath = process.env.KERNEL_UWS_MODULE;
const uws =
  modulePath && !process.versions.bun
    ? (createRequire(import.meta.url)(modulePath) as unknown)
    : undefined;
const servers: Handle[] = [];
const start = async (kernel: Kernel) => {
  const server = await listenNativeText(kernel.build(), uws);
  servers.push(server);
  return server;
};
const get = (port: number, path = "/", method = "GET", agent: Agent | false = false) =>
  new Promise<{
    status: number;
    headers: import("node:http").IncomingHttpHeaders;
    body: string;
    reusedSocket: boolean;
  }>((resolve, reject) => {
    const outgoing = request({ host: "127.0.0.1", port, path, method, agent }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.once("error", reject);
      incoming.once("end", () =>
        resolve({
          status: incoming.statusCode!,
          headers: incoming.headers,
          body: Buffer.concat(chunks).toString(),
          reusedSocket: outgoing.reusedSocket,
        }),
      );
    });
    outgoing.once("error", reject);
    outgoing.setTimeout(2000, () => outgoing.destroy(new Error("native HTTP test timeout")));
    outgoing.end();
  });
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

describe.skipIf(!uws)("native sync text probe (requires KERNEL_UWS_MODULE on Node)", () => {
  it("serves Hello without constructing Fetch objects", async () => {
    const server = await start(new Kernel().text("GET", "/", () => "Hello World"));
    const NativeRequest = globalThis.Request,
      NativeResponse = globalThis.Response;
    globalThis.Request = new Proxy(NativeRequest, {
      construct() {
        throw new Error("unexpected Request");
      },
    });
    globalThis.Response = new Proxy(NativeResponse, {
      construct() {
        throw new Error("unexpected Response");
      },
    });
    try {
      expect(await get(server.port)).toMatchObject({
        status: 200,
        body: "Hello World",
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    } finally {
      globalThis.Request = NativeRequest;
      globalThis.Response = NativeResponse;
    }
  });

  it("executes all twelve benchmark routes with independent expected values", async () => {
    const kernel = new Kernel()
      .text("GET", "/user", () => "user")
      .text("GET", "/user/comments", () => "user/comments")
      .text("GET", "/user/avatar", () => "user/avatar")
      .text("GET", "/user/lookup/username/:username", (p) => p.username!)
      .text("GET", "/user/lookup/email/:address", (p) => p.address!)
      .text("GET", "/event/:id", (p) => p.id!)
      .text("GET", "/event/:id/comments", (p) => p.id!)
      .text("POST", "/event/:id/comment", (p) => `${p.id} comment`)
      .text("GET", "/map/:location/events", (p) => p.location!)
      .text("GET", "/status", () => "status")
      .text("GET", "/very/deeply/nested/route/hello/there", () => "hello there")
      .text("GET", "/static/*", (p) => p.wildcard!);
    const server = await start(kernel);
    for (const [method, path, expected] of [
      ["GET", "/user", "user"],
      ["GET", "/user/comments", "user/comments"],
      ["GET", "/user/avatar", "user/avatar"],
      ["GET", "/user/lookup/username/ada", "ada"],
      ["GET", "/user/lookup/email/a%40b.test", "a@b.test"],
      ["GET", "/event/42", "42"],
      ["GET", "/event/a%2Fb/comments", "a/b"],
      ["POST", "/event/42/comment", "42 comment"],
      ["GET", "/map/singapore/events", "singapore"],
      ["GET", "/status", "status"],
      ["GET", "/very/deeply/nested/route/hello/there", "hello there"],
      ["GET", "/static/a/b.txt", "a/b.txt"],
    ])
      expect(await get(server.port, path, method)).toMatchObject({ status: 200, body: expected });
  });

  it("calls the handler on each request instead of caching its result", async () => {
    let count = 0;
    const server = await start(new Kernel().text("GET", "/", () => String(++count)));
    expect((await get(server.port)).body).toBe("1");
    expect((await get(server.port)).body).toBe("2");
    expect(count).toBe(2);
  });

  it("handles UTF-8 HEAD, misses, Allow and OPTIONS through the same Kernel", async () => {
    const server = await start(new Kernel().text("GET", "/", () => "你好"));
    expect(await get(server.port, "/", "HEAD")).toMatchObject({
      status: 200,
      body: "",
      headers: { "content-length": "6" },
    });
    expect(await get(server.port, "/", "POST")).toMatchObject({
      status: 405,
      body: "Method Not Allowed",
      headers: { allow: "GET, HEAD, OPTIONS" },
    });
    expect(await get(server.port, "/", "OPTIONS")).toMatchObject({
      status: 204,
      body: "",
      headers: { allow: "GET, HEAD, OPTIONS" },
    });
    expect(await get(server.port, "/missing")).toMatchObject({ status: 404, body: "Not Found" });
    expect(await get(server.port, "/bad%XX")).toMatchObject({ status: 400, body: "Bad Request" });
  });

  it("does not invoke handlers or bypass applicable middleware on a capability refusal", async () => {
    let calls = 0;
    const server = await start(
      new Kernel()
        .use("/secure", (_incoming, next) => {
          calls++;
          return next();
        })
        .text("GET", "/secure/value", () => {
          calls++;
          return "private";
        })
        .route("GET", "/fetch", () => {
          calls++;
          return new Response("fetch");
        })
        .text("GET", "/public", () => "public"),
    );
    for (const path of ["/secure/value", "/secure/miss", "/fetch"])
      expect(await get(server.port, path)).toMatchObject({ status: 501 });
    expect(calls).toBe(0);
    expect(await get(server.port, "/public")).toMatchObject({ status: 200, body: "public" });
  });

  it("rejects both resolving and rejected async handlers with 501 and observes rejection", async () => {
    const server = await start(
      new Kernel()
        .text("GET", "/async", async () => "later")
        .text("GET", "/reject", () => Promise.reject(new Error("observed"))),
    );
    expect(await get(server.port, "/async")).toMatchObject({ status: 501 });
    expect(await get(server.port, "/reject")).toMatchObject({ status: 501 });
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it("writes synchronous Reply snapshots including duplicate cookies and HEAD length", async () => {
    const headers = new Headers({ "x-label": "é" });
    headers.append("set-cookie", "a=1; Path=/");
    headers.append("set-cookie", "b=2; Path=/");
    const server = await start(
      new Kernel()
        .text("GET", "/", () => {
          throw new Error("mapped");
        })
        .onError(() => new Reply("你好", 418, headers)),
    );
    expect(await get(server.port)).toMatchObject({
      status: 418,
      body: "你好",
      headers: { "x-label": "é", "set-cookie": ["a=1; Path=/", "b=2; Path=/"] },
    });
    expect(await get(server.port, "/", "HEAD")).toMatchObject({
      status: 418,
      body: "",
      headers: { "content-length": "6" },
    });
  });

  it("validates all snapshot headers before any response bytes are committed", async () => {
    const invalid = Object.freeze({
      status: 200,
      body: "ok",
      headers: [["x-label", "safe\r\nx-injected: yes"]] as Array<[string, string]>,
    });
    const server = await start(
      new Kernel()
        .text("GET", "/", () => {
          throw new Error("mapped");
        })
        .onError(() => invalid),
    );
    const result = await get(server.port);
    expect(result).toMatchObject({ status: 500, body: "Internal Server Error" });
    expect(result.headers["x-injected"]).toBeUndefined();
    expect(result.headers["x-label"]).toBeUndefined();
  });

  it("reads snapshot fields and tuple values once before validating the copy", async () => {
    const reads = { status: 0, body: 0, headers: 0, value: 0 };
    const tuple: [string, string] = ["x-label", "safe"];
    Object.defineProperty(tuple, 1, {
      get() {
        reads.value++;
        return reads.value === 1 ? "safe" : "unsafe\r\nx-injected: yes";
      },
    });
    const value = Object.freeze({
      get status() {
        reads.status++;
        return 200;
      },
      get body() {
        reads.body++;
        return "ok";
      },
      get headers() {
        reads.headers++;
        return [tuple];
      },
    });
    const server = await start(
      new Kernel()
        .text("GET", "/", () => {
          throw new Error("mapped");
        })
        .onError(() => value),
    );
    expect(await get(server.port)).toMatchObject({
      status: 200,
      body: "ok",
      headers: { "x-label": "safe" },
    });
    expect(reads).toEqual({ status: 1, body: 1, headers: 1, value: 1 });
  });

  it("frames 205 with zero length and reuses keep-alive for 204/205/304", async () => {
    const server = await start(
      new Kernel()
        .text("GET", "/status/:code", (params) => {
          throw Number(params.code);
        })
        .text("GET", "/ok", () => "next")
        .onError((code) => new Reply(null, Number(code), { "content-type": "remove-me" })),
    );
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    try {
      for (const code of [204, 205, 304]) {
        const result = await get(server.port, `/status/${code}`, "GET", agent);
        expect(result).toMatchObject({ status: code, body: "" });
        expect(result.headers["content-length"]).toBe(code === 205 ? "0" : undefined);
        expect(result.headers["transfer-encoding"]).toBeUndefined();
        expect(result.headers["content-type"]).toBeUndefined();
        expect(await get(server.port, "/ok", "GET", agent)).toMatchObject({
          status: 200,
          body: "next",
          reusedSocket: true,
        });
      }
    } finally {
      agent.destroy();
    }
  });

  it("explicitly rejects a Response from the error mapper and cancels its body", async () => {
    let cancelled = false;
    const server = await start(
      new Kernel()
        .text("GET", "/", () => {
          throw new Error("bad");
        })
        .onError(
          () =>
            new Response(
              new ReadableStream({
                cancel() {
                  cancelled = true;
                },
              }),
            ),
        ),
    );
    expect(await get(server.port)).toMatchObject({ status: 501 });
    expect(cancelled).toBe(true);
  });

  it("rejects a failed listen without closing the server already owning that port", async () => {
    const server = await start(new Kernel().text("GET", "/", () => "owner"));
    await expect(
      listenNativeText(new Kernel().build(), uws, { port: server.port }),
    ).rejects.toThrow("listen failed");
    expect((await get(server.port)).body).toBe("owner");
    server.close();
    server.close();
    await expect(get(server.port)).rejects.toThrow();
  });
});
