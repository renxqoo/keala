/**
 * Node adapter: `node:http` glue for running the same app under Node.
 *
 * IncomingMessage enters the lazy native RequestSource; direct bodies write
 * to ServerResponse without a WebStream bridge, while foreign streams retain
 * backpressure/cancellation. Websockets remain Bun-only and answer 501.
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerOptions,
  type ServerResponse,
} from "node:http";
import { Readable } from "node:stream";
import type { Application } from "../core/app.ts";
import { responseFactsOf } from "../core/response-plan.ts";
import { HANDLE_REQUEST_SOURCE, type NativeApplication } from "../core/application.ts";
import { NATIVE_REQUEST_SOURCE, type NativeRequestSource } from "../core/request-source.ts";
import { createError } from "../http/errors.ts";

export interface NodeServerHandle {
  readonly port: number;
  readonly hostname: string;
  stop(closeActiveConnections?: boolean): void;
  /** In-process request handler — same shape as the Bun server handle. */
  fetch(request: Request): Promise<Response>;
  /** Resolves once the socket is bound (Node binds asynchronously). */
  ready(): Promise<NodeServerHandle>;
}

export interface NodeListenOptions {
  /** Listen port. Default 3000 (0 picks a free port). */
  port?: number;
  /** Bind address. Default: Node's (all interfaces). */
  hostname?: string;
  /** Pass-through for node:http ServerOptions (highWaterMark, keepAlive…). */
  http?: ServerOptions;
}

/** Methods whose Request body must stay undefined (the constructor rejects it). */
const mayCarryBody = (method: string): boolean => method !== "GET" && method !== "HEAD";

/** `host:port` authority with IPv6 addresses bracketed (`[::1]:3000`). */
const authorityOf = (host: string, port: number): string =>
  host.includes(":") && !host.startsWith("[") ? `[${host}]:${port}` : `${host}:${port}`;

class InvalidRequestTargetError extends Error {}

class NodeRequestSource implements NativeRequestSource {
  readonly [NATIVE_REQUEST_SOURCE] = true as const;
  readonly method: string;
  readonly url: string;
  readonly incoming: IncomingMessage;
  readonly server: NodeServerHandle;
  // Cold transport state is added only when an API consumes it. `declare`
  // emits no class fields, keeping GET/probe sources at four own slots.
  declare _body?: ReadableStream<Uint8Array> | null;
  declare _bodySet?: true;
  declare _request?: Request;
  declare _bytes?: Promise<Uint8Array>;
  declare _bodyOwned?: true;

  get remote(): string | undefined {
    return this.incoming.socket.remoteAddress;
  }

  constructor(incoming: IncomingMessage, server: NodeServerHandle) {
    this.incoming = incoming;
    this.server = server;
    this.method = incoming.method ?? "GET";
    // Origin-form is prefixed with the request Host (or bound address), while
    // proxy absolute-form stays verbatim. OPTIONS * addresses the server root.
    const target = incoming.url ?? "/";
    const requestTarget = target === "*" ? "/" : target;
    if (requestTarget.charCodeAt(0) === 47 /* "/" */) {
      this.url = requestTarget;
    } else if (requestTarget.startsWith("http://") || requestTarget.startsWith("https://")) {
      this.url = requestTarget;
    } else {
      throw new InvalidRequestTargetError("unsupported HTTP request-target");
    }
  }

  absoluteUrl(): string {
    if (this.url.charCodeAt(0) !== 47 /* "/" */) return this.url;
    const fallbackHost = authorityOf(this.server.hostname, this.server.port);
    return `http://${this.incoming.headers.host ?? fallbackHost}${this.url}`;
  }

  header(name: string): string | null {
    if (this._request !== undefined) return this._request.headers.get(name);
    const value = this.incoming.headers[name.toLowerCase()];
    if (value === undefined) return null;
    return Array.isArray(value) ? value.join(", ") : value;
  }

  headers(): Headers {
    return this.request().headers;
  }

  body(): ReadableStream<Uint8Array> | null {
    if (this._bodySet === true) return this._body as ReadableStream<Uint8Array> | null;
    this._bodySet = true;
    const declared = this.incoming.headers["content-length"];
    const chunked = this.incoming.headers["transfer-encoding"] !== undefined;
    if (!mayCarryBody(this.method) || (declared === undefined && !chunked) || declared === "0") {
      return (this._body = null);
    }
    this._bodyOwned = true;
    return (this._body = Readable.toWeb(this.incoming) as ReadableStream<Uint8Array>);
  }

  request(): Request {
    if (this._request !== undefined) return this._request;
    const headers = new Headers();
    for (const [name, value] of Object.entries(this.incoming.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    if (this._bytes !== undefined && mayCarryBody(this.method)) {
      // The native source already owns/consumed the IncomingMessage. Expose a
      // standards-shaped consumed Request: bodyUsed is true and every second
      // reader rejects, matching Request.bytes() ownership semantics without
      // re-wrapping or copying the original payload.
      const consumed = new Request(this.absoluteUrl(), {
        method: this.method,
        headers,
        body: new Uint8Array(0),
        duplex: "half",
      });
      void consumed.arrayBuffer().catch(() => undefined);
      return (this._request = consumed);
    }
    const body = this.body();
    return (this._request = new Request(this.absoluteUrl(), {
      method: this.method,
      headers,
      ...(body === null ? {} : { body, duplex: "half" }),
    }));
  }

  bytes(limit = Number.MAX_SAFE_INTEGER): Promise<Uint8Array> {
    if (this._bytes !== undefined) return this._bytes;
    this._bodyOwned = true;
    if (this._request !== undefined || this._bodySet === true) {
      const body = this.request().body;
      if (body === null) return (this._bytes = Promise.resolve(new Uint8Array(0)));
      return (this._bytes = this.#readWebBody(body, limit));
    }
    const declared = this.incoming.headers["content-length"];
    const chunked = this.incoming.headers["transfer-encoding"] !== undefined;
    if (!mayCarryBody(this.method) || (declared === undefined && !chunked) || declared === "0") {
      return (this._bytes = Promise.resolve(new Uint8Array(0)));
    }
    return (this._bytes = this.#readIncoming(limit));
  }

  /** Drain an unread request so the keep-alive connection can parse its next message. */
  cleanupUnread(): void {
    if (this._bodyOwned === true || this.incoming.readableEnded || this.incoming.destroyed) return;
    this.incoming.resume();
  }

  #tooLarge(limit: number): Error {
    return createError(413, `request body exceeds the ${limit} byte limit`, {
      expose: true,
      code: "payload_too_large",
    });
  }

  #readIncoming(limit: number): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let settled = false;
      const cleanup = (): void => {
        this.incoming.off("data", onData);
        this.incoming.off("end", onEnd);
        this.incoming.off("aborted", onAborted);
        this.incoming.off("error", onError);
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onData = (chunk: Buffer): void => {
        total += chunk.byteLength;
        if (total > limit) {
          fail(this.#tooLarge(limit));
          // Keep consuming without buffering so Node can safely reuse the
          // connection after the early 413 response.
          this.incoming.resume();
          return;
        }
        chunks.push(chunk);
      };
      const onEnd = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (chunks.length === 0) resolve(new Uint8Array(0));
        else if (chunks.length === 1) resolve(chunks[0] as Buffer);
        else resolve(Buffer.concat(chunks, total));
      };
      const onAborted = (): void => fail(new Error("client disconnected while reading request"));
      const onError = (error: Error): void => fail(error);
      this.incoming.on("data", onData);
      this.incoming.once("end", onEnd);
      this.incoming.once("aborted", onAborted);
      this.incoming.once("error", onError);
    });
  }

  async #readWebBody(body: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw this.#tooLarge(limit);
      }
      chunks.push(value);
    }
    if (chunks.length === 0) return new Uint8Array(0);
    if (chunks.length === 1) return chunks[0] as Uint8Array;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }
}

const writeHeaders = (headers: Headers, out: ServerResponse): void => {
  const cookies = headers.getSetCookie();
  for (const [name, value] of headers) {
    if (name === "set-cookie") continue;
    out.setHeader(name, value);
  }
  if (cookies.length > 0) out.setHeader("set-cookie", cookies);
};

const directBodyLength = (body: string | Uint8Array): number =>
  typeof body === "string" ? Buffer.byteLength(body) : body.byteLength;

const endDirectBody = (out: ServerResponse, body: string | Uint8Array): void => {
  if (typeof body === "string") out.end(body);
  else out.end(Buffer.from(body.buffer, body.byteOffset, body.byteLength));
};

const waitForDrain = (out: ServerResponse): Promise<void> =>
  new Promise((resolve, reject) => {
    const cleanup = (): void => {
      out.off("drain", drained);
      out.off("close", closed);
      out.off("error", failed);
    };
    const drained = (): void => {
      cleanup();
      resolve();
    };
    const closed = (): void => {
      cleanup();
      reject(new Error("client disconnected while streaming response"));
    };
    const failed = (error: Error): void => {
      cleanup();
      reject(error);
    };
    out.once("drain", drained);
    out.once("close", closed);
    out.once("error", failed);
  });

const writeStream = async (
  body: ReadableStream<Uint8Array>,
  out: ServerResponse,
): Promise<void> => {
  const reader = body.getReader();
  let completed = false;
  const cancel = (): void => {
    if (!completed) void reader.cancel("client disconnected").catch(() => undefined);
  };
  out.once("close", cancel);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        out.end();
        return;
      }
      if (!out.write(value)) await waitForDrain(out);
    }
  } finally {
    out.off("close", cancel);
    try {
      reader.releaseLock();
    } catch {
      // A failed/cancelled reader can already be detached.
    }
  }
};

const writeResponse = (res: Response, out: ServerResponse): void | Promise<void> => {
  const facts = responseFactsOf(res);
  if (facts?.planned === true && facts.native === undefined && facts.headerSnapshot === undefined) {
    const length = directBodyLength(facts.directBody);
    const headers =
      facts.implicitContentType === undefined
        ? { "content-length": length }
        : { "content-type": facts.implicitContentType, "content-length": length };
    // The bare default plan needs no header collection or body stream.
    out.writeHead(200, headers);
    endDirectBody(out, facts.directBody);
    return;
  }
  if (facts === undefined && (res.bodyUsed || res.body?.locked === true)) {
    throw new TypeError("cannot send a consumed or locked response body");
  }
  out.statusCode = res.status;
  if (res.statusText.length > 0) out.statusMessage = res.statusText;
  writeHeaders(facts?.headerSnapshot ?? res.headers, out);
  // Never emit ambiguous framing, including for a foreign streaming Response.
  const hasTransferEncoding = out.hasHeader("transfer-encoding");
  if (hasTransferEncoding) out.removeHeader("content-length");
  if (facts === undefined && res.body === null) {
    out.end();
    return;
  }
  if (facts !== undefined) {
    // The byte-exact body is already known. A fixed length avoids chunk
    // framing and also replaces an application-supplied stale length, which
    // must never desynchronize a keep-alive connection.
    if (!hasTransferEncoding) {
      out.setHeader("content-length", directBodyLength(facts.directBody));
    }
    endDirectBody(out, facts.directBody);
    return;
  }
  return writeStream(res.body as ReadableStream<Uint8Array>, out);
};

/**
 * Start a node:http server for the app. Mirrors `startBunServer`'s handle
 * shape (port/hostname/stop/fetch) so operational code stays runtime-agnostic.
 */
export const startNodeServer = (
  app: Application,
  options: NodeListenOptions = {},
  onListen?: () => void,
): NodeServerHandle => {
  let address: { port: number; address: string } | null = null;
  let settled: (() => void) | null = null;
  let failed: ((error: Error) => void) | null = null;
  const bound = new Promise<void>((resolve) => {
    settled = resolve;
  });
  // Bind failures (EADDRINUSE…) must reach `ready()` instead of surfacing as
  // an unhandled 'error' event (process death). The permanent catch keeps a
  // later runtime error from becoming an unhandled rejection.
  const failedBind = new Promise<never>((_resolve, reject) => {
    failed = reject;
  });
  failedBind.catch(() => undefined);

  const handle: NodeServerHandle = {
    get port(): number {
      // The requested port until the socket is bound — `ready()` is the
      // synchronization point (Node binds asynchronously).
      return address?.port ?? options.port ?? 3000;
    },
    get hostname(): string {
      return address?.address ?? options.hostname ?? "localhost";
    },
    stop(closeActiveConnections = false) {
      if (closeActiveConnections) server.closeAllConnections();
      server.close();
    },
    fetch: (request) => app.handle(request),
    async ready() {
      await Promise.race([bound, failedBind]);
      return handle;
    },
  };
  const server: Server = createServer(options.http ?? {}, (incoming, out) => {
    const fail = (error: unknown): void => {
      // app dispatch itself never rejects — failures here are native source
      // validation, socket teardown or response writer failures.
      if (!out.headersSent) {
        // A failed writer may already have staged another body's framing,
        // encoding, cookies and reason phrase. None describes this envelope.
        for (const name of out.getHeaderNames()) out.removeHeader(name);
        out.statusCode = error instanceof InvalidRequestTargetError ? 400 : 500;
        out.statusMessage =
          error instanceof InvalidRequestTargetError ? "Bad Request" : "Internal Server Error";
        out.setHeader("content-type", "text/plain; charset=utf-8");
        out.setHeader("content-length", Buffer.byteLength(out.statusMessage));
        out.end(out.statusMessage);
      } else {
        out.destroy();
      }
    };
    let source: NodeRequestSource | null = null;
    const answer = (response: Response): void => {
      if (source !== null && mayCarryBody(source.method)) source.cleanupUnread();
      try {
        const writing = writeResponse(response, out);
        if (writing instanceof Promise) void writing.catch(fail);
      } catch (error) {
        fail(error);
      }
    };
    try {
      source = new NodeRequestSource(incoming, handle);
      // The native source is also the Runtime view (`server` + `remote`), so
      // the adapter does not allocate a second request-local carrier object.
      const result = (app as NativeApplication)[HANDLE_REQUEST_SOURCE](source);
      if (result instanceof Promise) void result.then(answer, fail);
      else answer(result);
    } catch (error) {
      fail(error);
    }
  });

  server.on("listening", () => {
    const addr = server.address();
    if (typeof addr === "object" && addr !== null) {
      address = { port: addr.port, address: addr.address };
    }
    settled?.();
    if (onListen !== undefined) onListen();
  });
  server.on("error", (error: Error) => {
    failed?.(error);
  });
  // Malformed HTTP: answer 400 and drop the connection (Node's default would
  // just destroy the socket). `end` flushes the reply before closing.
  server.on("clientError", (_err, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  // With an 'upgrade' listener present, upgrades never reach 'request' —
  // websockets are Bun-only, so answer the wire-level refusal here.
  server.on("upgrade", (_req, socket) => {
    socket.end("HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\n");
  });

  server.listen(options.port ?? 3000, options.hostname);
  return handle;
};

/** `app.listen(port)`-style sugar for Node: `listen(app, 3000, "127.0.0.1")`. */
export const listen = (
  app: Application,
  port?: number,
  hostname?: string,
  onListen?: () => void,
): NodeServerHandle => startNodeServer(app, { port, hostname }, onListen);
