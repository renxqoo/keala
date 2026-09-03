/**
 * The Node transport's lazy NativeRequestSource: IncomingMessage wrapped
 * without materializing Headers/Request/body until an API asks for them.
 * Extracted from node.ts for the 500-line budget.
 */

import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { NATIVE_REQUEST_SOURCE, type NativeRequestSource } from "../core/request-source.ts";
import { createError } from "../http/errors.ts";
import type { NodeServerHandle } from "./node.ts";

export class InvalidRequestTargetError extends Error {}

/** Methods whose Request body must stay undefined (the constructor rejects it). */
export const mayCarryBody = (method: string): boolean => method !== "GET" && method !== "HEAD";

/** `host:port` authority with IPv6 addresses bracketed (`[::1]:3000`). */
export const authorityOf = (host: string, port: number): string =>
  host.includes(":") && !host.startsWith("[") ? `[${host}]:${port}` : `${host}:${port}`;

export class NodeRequestSource implements NativeRequestSource {
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
  // S4 lazy client-disconnect channel: the adapter's socket-close detection
  // drives `disconnect()`; consumers (the admission queue, `c.signal`)
  // materialize the controller on demand. A disconnect that lands before
  // anyone subscribed is remembered and replayed on first materialization.
  declare _abort?: AbortController;
  declare _disconnected?: unknown;

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

  /**
   * Materialize (or return) the client-disconnect AbortController. Calling
   * this is the ONLY way the channel allocates — requests nobody listens on
   * never pay for it.
   */
  clientAbort(): AbortController {
    if (this._abort === undefined) {
      const controller = new AbortController();
      this._abort = controller;
      if (this._disconnected !== undefined) controller.abort(this._disconnected);
    }
    return this._abort;
  }

  /** The adapter's disconnect detection (socket gone before the response finished). */
  disconnect(reason: unknown): void {
    if (this._disconnected !== undefined) return;
    this._disconnected = reason;
    this._abort?.abort(reason);
  }

  absoluteUrl(): string {
    if (this.url.charCodeAt(0) !== 47 /* "/" */) return this.url;
    const fallbackHost = authorityOf(this.server.hostname, this.server.port);
    return `http://${this.incoming.headers.host ?? fallbackHost}${this.url}`;
  }

  header(name: string): string | null {
    // Once a Request materializes, its Headers are the single source of truth
    // — every view (raw header(), Headers facade, Request) must observe the
    // same mutations (R4.5 header ownership, B45-16).
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
