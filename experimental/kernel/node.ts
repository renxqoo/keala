/**
 * Experimental native node:http executor. No TLS, upgrades, overload policy,
 * custom body limits or per-handler deadlines. Fetch bodies use standard
 * Request/Response; native text never constructs either object.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { Kernel } from "./kernel.ts";
import { ERROR_REPLY, PATH_ERROR, Reply, TEXT_TYPE, isPromise, type Value } from "./reply.ts";
import { nodeDrain } from "./node-drain.ts";

export interface NodeOptions {
  port?: number;
  hostname?: string;
}
export interface NodeHandle {
  readonly port: number;
  close(graceMs?: number): Promise<{ forced: boolean }>;
}
const EXCHANGE = Symbol("kernel.fetchExchange");
class InvalidTargetError extends Error {}
type Outgoing = ServerResponse & { [EXCHANGE]?: Exchange };
type UploadReader = Pick<
  ReadableStreamDefaultReader<Uint8Array>,
  "read" | "cancel" | "releaseLock"
>;
const emptyStatus = (status: number) => status === 204 || status === 205 || status === 304;
const hasBody = (incoming: IncomingMessage): boolean =>
  incoming.headers["transfer-encoding"] !== undefined ||
  (incoming.headers["content-length"] !== undefined && incoming.headers["content-length"] !== "0");
const stopBody = (response: Response): void => {
  if (response.body !== null) void response.body.cancel().catch(() => undefined);
};

/** Fetch-only request state; listeners remain until physical output completes. */
class Exchange {
  readonly controller = new AbortController();
  readonly request: Request;
  readonly incoming: IncomingMessage;
  readonly out: Outgoing;
  early = false;
  uploadReader?: UploadReader;
  constructor(incoming: IncomingMessage, out: Outgoing, url: string) {
    this.incoming = incoming;
    this.out = out;
    const headers = new Headers();
    for (let i = 0; i < incoming.rawHeaders.length; i += 2)
      headers.append(incoming.rawHeaders[i]!, incoming.rawHeaders[i + 1]!);
    const method = incoming.method ?? "GET";
    const body =
      method !== "GET" && method !== "HEAD" && hasBody(incoming)
        ? (Readable.toWeb(incoming) as ReadableStream<Uint8Array>)
        : undefined;
    this.request = new Request(url, {
      method,
      headers,
      signal: this.controller.signal,
      ...(body === undefined ? {} : { body, duplex: "half" }),
    });
    out[EXCHANGE] = this;
    incoming.once("aborted", this.aborted);
    out.once("finish", this.finished);
    out.once("close", this.closed);
    if (incoming.destroyed || out.destroyed) this.aborted();
  }
  aborted = (): void => {
    if (!this.controller.signal.aborted)
      this.controller.abort(new DOMException("client disconnected", "AbortError"));
    void this.uploadReader?.cancel("client disconnected").catch(() => undefined);
  };
  drainUnread(): void {
    if (!this.request.body || this.request.body.locked || this.uploadReader) return;
    const reader = this.request.body.getReader();
    this.uploadReader = reader;
    void this.drainUpload(reader);
  }
  async drainUpload(reader: UploadReader): Promise<void> {
    try {
      while (!(await reader.read()).done) {
        /* discard an unclaimed body */
      }
    } catch {
      this.aborted();
    } finally {
      reader.releaseLock();
      this.uploadReader = undefined;
      if (this.out.writableFinished) this.incoming.off("aborted", this.aborted);
    }
  }
  finishStream(): void {
    if (this.incoming.readableEnded) {
      this.early = false;
      return;
    }
    const body = this.request.body;
    if (body && (body.locked || this.request.bodyUsed) && !this.uploadReader) {
      this.early = true;
      this.out.shouldKeepAlive = false;
    } else this.drainUnread();
  }
  finished = (): void => {
    if (this.early && !this.incoming.readableEnded) {
      this.aborted();
      this.incoming.destroy();
    }
    if (!this.uploadReader) this.incoming.off("aborted", this.aborted);
    this.out.off("finish", this.finished);
    this.out.off("close", this.closed);
    this.out[EXCHANGE] = undefined;
  };
  closed = (): void => {
    if (!this.out.writableFinished) this.aborted();
    this.finished();
  };
}

const requestUrl = (incoming: IncomingMessage, port: number): string => {
  const target = incoming.url === "*" ? "/" : (incoming.url ?? "/");
  if (target.startsWith("/")) {
    const host = incoming.headers.host ?? `127.0.0.1:${port}`;
    if (/[/\\?#@\s]/.test(host)) throw new InvalidTargetError("invalid Host authority");
    try {
      return `${new URL(`http://${host}`).origin}${target}`;
    } catch {
      throw new InvalidTargetError("invalid Host authority");
    }
  }
  if (/^https?:\/\//.test(target) && !target.includes("\\")) return target;
  throw new InvalidTargetError("unsupported request target");
};

/** Immutable snapshots avoid observing live Headers again after an await. */
const snapshot = (headers: Headers, status: number, head: boolean, body: boolean): string[] => {
  const output: string[] = [];
  for (const [name, value] of headers) {
    if (name === "set-cookie" || name === "transfer-encoding" || name === "connection") continue;
    if (emptyStatus(status) && (name === "content-type" || name === "content-length")) continue;
    if (name === "content-length" && body && !head) continue;
    output.push(name, value);
  }
  for (const cookie of headers.getSetCookie()) output.push("set-cookie", cookie);
  return output;
};

const waitForDrain = (out: ServerResponse): Promise<void> =>
  new Promise((resolve, reject) => {
    const cleanup = () => {
      out.off("drain", drained);
      out.off("close", closed);
      out.off("error", failed);
    };
    const drained = () => {
      cleanup();
      resolve();
    };
    const closed = () => {
      cleanup();
      reject(new Error("client disconnected"));
    };
    const failed = (error: Error) => {
      cleanup();
      reject(error);
    };
    out.once("drain", drained);
    out.once("close", closed);
    out.once("error", failed);
    if (out.destroyed) closed();
  });

const streamResponse = async (
  response: Response,
  out: ServerResponse,
  headers: string[],
  exchange?: Exchange,
): Promise<void> => {
  const reader = response.body!.getReader();
  const cancel = () => {
    void reader.cancel("client disconnected").catch(() => undefined);
  };
  out.once("close", cancel);
  if (out.destroyed) cancel();
  try {
    // A producer error before commitment can still use the kernel error mapper.
    let chunk = await reader.read();
    if (out.destroyed) return;
    out.writeHead(response.status, response.statusText || undefined, headers);
    while (!chunk.done) {
      if (!out.write(chunk.value)) await waitForDrain(out);
      chunk = await reader.read();
      if (out.destroyed) return;
    }
    exchange?.finishStream();
    out.end();
  } catch (error) {
    void reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    out.off("close", cancel);
    reader.releaseLock();
  }
};

export const listenNode = async (
  kernel: Kernel,
  options: NodeOptions = {},
): Promise<NodeHandle> => {
  const executable = kernel.build();
  let port = options.port ?? 3000;
  let closing: Promise<{ forced: boolean }> | undefined;
  let resolveClose: ((value: { forced: boolean }) => void) | undefined;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  let stopping = false,
    forced = false,
    serverClosed = false,
    asynchronous = 0;
  const server = createServer(dispatch);
  const drain = nodeDrain(server, checkClose);

  function checkClose(): void {
    if (!stopping) return;
    drain.closeIdle();
    if (serverClosed && (forced || asynchronous === 0)) {
      clearTimeout(forceTimer);
      resolveClose?.({ forced });
      resolveClose = undefined;
    }
  }
  function force(): void {
    forced = true;
    drain.force();
    checkClose();
  }
  function prepare(incoming: IncomingMessage, out: Outgoing, response?: Response): void {
    // An output stream may depend on the upload through an opaque transform.
    // Give it ownership until EOF; never race it with our discard reader.
    const exchange = out[EXCHANGE];
    if (!incoming.readableEnded && hasBody(incoming)) {
      const body = exchange?.request.body;
      const claimed =
        exchange && (exchange.request.bodyUsed || body?.locked) && !exchange.uploadReader;
      const streaming =
        response?.body !== null &&
        response !== undefined &&
        incoming.method !== "HEAD" &&
        !emptyStatus(response.status);
      if (claimed && body !== response?.body) {
        exchange.early = true;
        out.shouldKeepAlive = false;
        out.setHeader("connection", "close");
      }
      if (!streaming && !claimed) {
        if (exchange) exchange.drainUnread();
        else incoming.resume();
      }
    }
    if (stopping) {
      out.shouldKeepAlive = false;
      out.setHeader("connection", "close");
    }
  }
  function text(incoming: IncomingMessage, out: Outgoing, body: string): void {
    if (out.destroyed) return;
    prepare(incoming, out);
    out.setHeader("content-type", TEXT_TYPE);
    out.setHeader("content-length", String(Buffer.byteLength(body)));
    out.end(incoming.method === "HEAD" ? undefined : body);
  }
  function write(incoming: IncomingMessage, out: Outgoing, value: Value): void | Promise<void> {
    if (out.destroyed) {
      if (value instanceof Response) stopBody(value);
      return;
    }
    if (typeof value === "string") return text(incoming, out, value);
    const head = incoming.method === "HEAD";
    if (value instanceof Reply) {
      const headers: string[] = [];
      for (const [name, content] of value.headers) {
        if (name === "content-length" || name === "transfer-encoding" || name === "connection")
          continue;
        if (emptyStatus(value.status) && name === "content-type") continue;
        headers.push(name, content);
      }
      if (!emptyStatus(value.status))
        headers.push("content-length", String(Buffer.byteLength(value.body ?? "")));
      prepare(incoming, out);
      out.writeHead(value.status, headers);
      out.end(head ? undefined : (value.body ?? undefined));
      return;
    }
    if (!(value instanceof Response)) throw new TypeError("invalid handler result");
    if (value.status < 200 || value.status > 599) throw new RangeError("invalid response status");
    if (value.bodyUsed || value.body?.locked)
      throw new TypeError("response body is consumed or locked");
    const headers = snapshot(value.headers, value.status, head, value.body !== null);
    prepare(incoming, out, value);
    if (head || emptyStatus(value.status) || value.body === null) {
      if (!head && !emptyStatus(value.status)) {
        for (let i = headers.length - 2; i >= 0; i -= 2)
          if (headers[i] === "content-length") headers.splice(i, 2);
        headers.push("content-length", "0");
      }
      stopBody(value);
      out.writeHead(value.status, value.statusText || undefined, headers);
      out.end();
      return;
    }
    return streamResponse(value, out, headers, out[EXCHANGE]);
  }
  function failed(
    incoming: IncomingMessage,
    out: Outgoing,
    error: unknown,
    fallback = false,
  ): void {
    if (out.destroyed) return;
    if (out.headersSent) {
      out.destroy();
      return;
    }
    if (fallback) {
      try {
        prepare(incoming, out);
        out.writeHead(500, { "content-type": TEXT_TYPE, "content-length": "21" });
        out.end(incoming.method === "HEAD" ? undefined : "Internal Server Error");
      } catch {
        out.destroy();
      }
      return;
    }
    try {
      result(
        incoming,
        out,
        error instanceof InvalidTargetError ? PATH_ERROR : executable.fail(error),
        true,
      );
    } catch {
      result(incoming, out, ERROR_REPLY, true);
    }
  }
  function result(
    incoming: IncomingMessage,
    out: Outgoing,
    value: unknown,
    fallback = false,
  ): void {
    try {
      if (isPromise(value)) {
        asynchronous++;
        void Promise.resolve(value)
          .then(
            (settled) => result(incoming, out, settled, fallback),
            (error: unknown) => failed(incoming, out, error, fallback),
          )
          .finally(() => {
            asynchronous--;
            checkClose();
          });
        return;
      }
      const pending = write(incoming, out, value as Value);
      if (pending) {
        asynchronous++;
        void pending
          .catch((error: unknown) => failed(incoming, out, error, fallback))
          .finally(() => {
            asynchronous--;
            checkClose();
          });
      }
    } catch (error) {
      failed(incoming, out, error, fallback);
    }
  }
  function dispatch(incoming: IncomingMessage, out: Outgoing): void {
    drain.track(incoming, out);
    try {
      if (stopping) {
        result(incoming, out, new Reply("Service Unavailable", 503));
        return;
      }
      const target = incoming.url === "*" ? "/" : (incoming.url ?? "/");
      if (!target.startsWith("/") && (!/^https?:\/\//.test(target) || target.includes("\\")))
        throw new InvalidTargetError("unsupported request target");
      const selection = executable.select(incoming.method ?? "GET", target);
      if (!executable.needsRequest(selection)) {
        const value = executable.invoke(selection);
        if (typeof value === "string") text(incoming, out, value);
        else result(incoming, out, value);
      } else {
        const exchange = new Exchange(incoming, out, requestUrl(incoming, port));
        result(incoming, out, executable.invoke(selection, exchange.request));
      }
    } catch (error) {
      failed(incoming, out, error);
    }
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, options.hostname, () => {
      server.off("error", reject);
      port = (server.address() as { port: number }).port;
      resolve();
    });
  });
  return {
    port,
    close(graceMs = 5000): Promise<{ forced: boolean }> {
      if (!Number.isFinite(graceMs) || graceMs < 0)
        return Promise.reject(new RangeError("invalid graceMs"));
      if (closing) {
        if (graceMs === 0) force();
        return closing;
      }
      stopping = true;
      closing = new Promise((resolve) => {
        resolveClose = resolve;
      });
      forceTimer = setTimeout(force, graceMs);
      drain.start();
      server.close(() => {
        serverClosed = true;
        checkClose();
      });
      checkClose();
      return closing;
    },
  };
};
