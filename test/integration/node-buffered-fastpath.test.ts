import {
  Agent,
  request,
  ServerResponse,
  type IncomingMessage,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
  type OutgoingHttpHeader,
} from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Keala } from "../../src/core/app.ts";
import { createPlannedResponse } from "../../src/core/response-plan.ts";
import { startNodeServer, type NodeServerHandle } from "../../src/adapters/node.ts";

const servers: NodeServerHandle[] = [];
const agents: Agent[] = [];
afterEach(() => {
  for (const agent of agents.splice(0)) agent.destroy();
  for (const server of servers.splice(0)) server.stop(true);
});
const start = async (app: Keala) => {
  const server = await startNodeServer(app, { port: 0, hostname: "127.0.0.1" }).ready();
  servers.push(server);
  return server;
};
const read = (server: NodeServerHandle, agent: Agent, path = "/", method = "GET") =>
  new Promise<{
    status: number;
    statusMessage: string;
    headers: IncomingHttpHeaders;
    body: Buffer;
    socket: unknown;
  }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: server.port, path, method, agent }, (res) => {
      const chunks: Buffer[] = [];
      const socket = res.socket;
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () =>
        resolve({
          status: res.statusCode!,
          statusMessage: res.statusMessage!,
          headers: res.headers,
          body: Buffer.concat(chunks),
          socket,
        }),
      );
    });
    req.on("error", reject);
    req.setTimeout(2000, () => req.destroy(new Error("response did not complete")));
    req.end();
  });
const client = () => {
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  agents.push(agent);
  return agent;
};

describe("Node buffered response compatibility", () => {
  it("retains write transformations from an explicitly supplied ServerResponse", async () => {
    class UppercaseResponse<R extends IncomingMessage = IncomingMessage> extends ServerResponse<R> {
      override write(
        chunk: unknown,
        encoding?: BufferEncoding | ((error?: Error | null) => void),
        callback?: (error?: Error | null) => void,
      ): boolean {
        const body = typeof chunk === "string" ? chunk.toUpperCase() : chunk;
        return typeof encoding === "string"
          ? super.write(body, encoding, callback)
          : super.write(body, encoding);
      }
    }
    const app = new Keala({ env: "test" });
    app.get("/", (c) => c.text("hello"));
    const server = await startNodeServer(app, {
      port: 0,
      hostname: "127.0.0.1",
      http: { ServerResponse: UppercaseResponse },
    }).ready();
    servers.push(server);
    const result = await read(server, client());
    expect(result.status).toBe(200);
    expect(result.body.toString()).toBe("HELLO");
  });
  it("preserves headers flushed by a custom ServerResponse before dispatch", async () => {
    class FlushedResponse<R extends IncomingMessage = IncomingMessage> extends ServerResponse<R> {
      constructor(req: R) {
        super(req);
        this.statusCode = 202;
        this.setHeader("x-pre", "yes");
        this.flushHeaders();
      }
    }
    const app = new Keala({ env: "test" });
    app.get("/", (c) => c.text("hello"));
    const server = await startNodeServer(app, {
      port: 0,
      hostname: "127.0.0.1",
      http: { ServerResponse: FlushedResponse },
    }).ready();
    servers.push(server);
    const result = await read(server, client());
    expect(result.status).toBe(202);
    expect(result.headers["x-pre"]).toBe("yes");
    expect(result.headers["content-type"]).toBeUndefined();
    expect(result.body.toString()).toBe("hello");
  });
  it("preserves the default reason phrase with a custom ServerResponse", async () => {
    class CustomReason<R extends IncomingMessage = IncomingMessage> extends ServerResponse<R> {
      constructor(req: R) {
        super(req);
        this.statusMessage = "Custom";
      }
    }
    const app = new Keala({ env: "test" });
    app.get("/", (c) => c.text("hello"));
    const server = await startNodeServer(app, {
      port: 0,
      hostname: "127.0.0.1",
      http: { ServerResponse: CustomReason },
    }).ready();
    servers.push(server);
    const result = await read(server, client());
    expect(result.statusMessage).toBe("OK");
    expect(result.body.toString()).toBe("hello");
  });
  it("keeps native sending failures outside the application error mapper", async () => {
    class FailingWrite<R extends IncomingMessage = IncomingMessage> extends ServerResponse<R> {
      override writeHead(
        status: number,
        message?: string,
        headers?: OutgoingHttpHeaders | OutgoingHttpHeader[],
      ): this;
      override writeHead(
        status: number,
        headers?: OutgoingHttpHeaders | OutgoingHttpHeader[],
      ): this;
      override writeHead(
        status: number,
        message?: string | OutgoingHttpHeaders | OutgoingHttpHeader[],
        headers?: OutgoingHttpHeaders | OutgoingHttpHeader[],
      ): this {
        if (status === 200) throw new Error("native write failure");
        return typeof message === "string"
          ? super.writeHead(status, message, headers)
          : super.writeHead(status, message);
      }
    }
    let mapped = 0;
    const app = new Keala({ env: "test" });
    app.get("/", (c) => c.text("hello"));
    const server = await startNodeServer(app, {
      port: 0,
      hostname: "127.0.0.1",
      http: { ServerResponse: FailingWrite },
      onServeError: () => {
        mapped++;
        return new Response("mapped", { status: 503 });
      },
    }).ready();
    servers.push(server);
    const result = await read(server, client());
    expect(result.status).toBe(500);
    expect(result.body.length).toBe(0);
    expect(mapped).toBe(0);
  });
  for (const body of ["", "Hello 世界 🌍", "\ud800"]) {
    it(`frames UTF-8 text ${JSON.stringify(body)} and reuses the connection`, async () => {
      const app = new Keala({ env: "test" });
      app.get("/", (c) => c.text(body));
      const server = await start(app);
      const agent = client();
      const first = await read(server, agent);
      const second = await read(server, agent);
      expect(first.status).toBe(200);
      expect(first.headers["content-type"]).toBe("text/plain; charset=utf-8");
      expect(first.headers["content-length"]).toBe(String(Buffer.byteLength(body)));
      expect(first.headers["transfer-encoding"]).toBeUndefined();
      expect(first.body).toEqual(Buffer.from(body));
      expect(second.body).toEqual(first.body);
      expect(second.socket).toBe(first.socket);
      const head = await read(server, agent, "/", "HEAD");
      expect(head.body.length).toBe(0);
      expect(head.headers["content-length"]).toBe(first.headers["content-length"]);
    });
  }
  for (const bytes of [new Uint8Array(), new Uint8Array([0, 128, 255])]) {
    it(`preserves ${bytes.length}-byte planned body ownership`, async () => {
      const expected = Buffer.from(bytes);
      const app = new Keala({ env: "test" });
      app.get("/", () => {
        const value = new Uint8Array(bytes);
        const response = createPlannedResponse(value);
        value.fill(42);
        return response;
      });
      const response = await read(await start(app), client());
      expect(response.status).toBe(200);
      expect(response.headers["content-length"]).toBe(String(bytes.byteLength));
      expect(response.headers["content-type"]).toBeUndefined();
      expect(response.body).toEqual(expected);
    });
  }
  it("closes a draining connection after its pending buffered response completes", async () => {
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = new Keala({ env: "test" });
    app.get("/", async (c) => {
      entered();
      await gate;
      return c.text("complete 世界");
    });
    const server = await start(app);
    const response = read(server, client());
    await waiting;
    const closing = app.close({ drain: 500 });
    release();
    const result = await response;
    expect(result.status).toBe(200);
    expect(result.headers["connection"]).toBe("close");
    expect(result.body.toString()).toBe("complete 世界");
    expect((await closing).timedOut).toBe(false);
  });
  it("retains absolute-form serving and rejects unsupported schemes before dispatch", async () => {
    const app = new Keala({ env: "test" });
    let handled = 0;
    app.get("/", (c) => {
      handled++;
      return c.text("absolute");
    });
    const server = await start(app);
    const agent = client();
    const valid = await read(server, agent, "http://example.test/");
    expect(valid.status).toBe(200);
    expect(valid.body.toString()).toBe("absolute");
    const invalid = await read(server, agent, "ftp://example.test/");
    expect(invalid.status).toBe(400);
    expect(invalid.body.length).toBe(0);
    expect(handled).toBe(1);
  });
});
