/**
 * Node adapter: `node:http` glue for running the same app under Node.
 *
 * IncomingMessage enters the lazy native RequestSource; direct bodies write
 * to ServerResponse without a WebStream bridge, while foreign streams retain
 * backpressure/cancellation. Websockets remain Bun-only and answer 501.
 */

import { createServer, type Server, type ServerOptions, type ServerResponse } from "node:http";
import type { Application } from "../core/app.ts";
import { responseFactsOf } from "../core/response-plan.ts";
import { HANDLE_REQUEST_SOURCE, type NativeApplication } from "../core/application.ts";
import type { GracefulStopOptions } from "../core/lifecycle.ts";
import { installSignalBridge } from "../core/lifecycle.ts";
import { attachServer } from "../core/server-slot.ts";
import { InvalidRequestTargetError, mayCarryBody, NodeRequestSource } from "./node-source.ts";

export interface NodeServerHandle {
  readonly port: number;
  readonly hostname: string;
  stop(closeActiveConnections?: boolean): void;
  /** In-process request handler — same shape as the Bun server handle. */
  fetch(request: Request): Promise<Response>;
  /** Resolves once the socket is bound (Node binds asynchronously). */
  ready(): Promise<NodeServerHandle>;
  /** R4.6 graceful stop: stop accepting, close idle sockets, wait for the
   * wire's last response to finish (Node's exact truth) or the app counter. */
  stopGraceful(options: GracefulStopOptions): Promise<{ timedOut: boolean }>;
}

export interface NodeListenOptions {
  /** Listen port. Default 3000 (0 picks a free port). */
  port?: number;
  /** Bind address. Default: Node's (all interfaces). */
  hostname?: string;
  /** Pass-through for node:http ServerOptions (highWaterMark, keepAlive…). */
  http?: ServerOptions;
  /**
   * R4.6 signal bridge (opt-in): SIGTERM/SIGINT drain the server via
   * `app.close()`; a second signal force-closes.
   */
  signals?: boolean;
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

// Responses this adapter has already put on a wire once. Re-sending one is
// the overload refusal-handler pattern (a cached Response reused across
// refusals): its body is one-shot and gone after the first send, so the
// re-send degrades to the original status/headers with the body-describing
// headers stripped and an empty body — coherently framed, never a desync.
// A response that arrives ALREADY consumed or locked without ever having
// been sent here stays a loud adapter error (R4.5 B45-18: the handler handed
// us a corpse with someone else's framing headers on it).
const sentResponses = new WeakSet<Response>();

const writeResponse = (
  res: Response,
  out: ServerResponse,
  closeAfter: boolean,
): void | Promise<void> => {
  const facts = responseFactsOf(res);
  if (facts?.planned === true && facts.native === undefined && facts.headerSnapshot === undefined) {
    const length = directBodyLength(facts.directBody);
    const headers: Record<string, string | number> =
      facts.implicitContentType === undefined
        ? { "content-length": length }
        : { "content-type": facts.implicitContentType, "content-length": length };
    // An unmaterialized plan is by construction the default status pair, and
    // the bare default plan needs no header collection or body stream.
    // During drain every response orders its connection closed: keep-alive
    // reuse would keep sockets warm past server.close() and stretch drains.
    if (closeAfter) headers["connection"] = "close";
    out.writeHead(200, headers);
    endDirectBody(out, facts.directBody);
    return;
  }
  if (facts === undefined && (res.bodyUsed || res.body?.locked === true)) {
    if (!sentResponses.has(res)) {
      throw new TypeError("cannot send a consumed or locked response body");
    }
    out.statusCode = res.status;
    if (res.statusText.length > 0) out.statusMessage = res.statusText;
    writeHeaders(res.headers, out);
    if (closeAfter) out.setHeader("connection", "close");
    out.removeHeader("content-length");
    out.removeHeader("transfer-encoding");
    out.removeHeader("content-encoding");
    out.end();
    return;
  }
  if (facts === undefined) sentResponses.add(res);
  out.statusCode = res.status;
  if (res.statusText.length > 0) out.statusMessage = res.statusText;
  writeHeaders(facts?.headerSnapshot ?? res.headers, out);
  if (closeAfter) out.setHeader("connection", "close");
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

  // R4.6 shutdown state: `draining` orders `connection: close` on responses;
  // `wireInFlight` counts responses not yet finished ON THE SOCKET (Node's
  // exact truth — settle-time lies about streams still flushing).
  let draining = false;
  let wireInFlight = 0;
  const wireWaiters: Array<() => void> = [];

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
    stopGraceful(grace: GracefulStopOptions): Promise<{ timedOut: boolean }> {
      return new Promise((resolve) => {
        draining = true;
        // Stop accepting; idle keep-alives go first so the drain window only
        // covers real work (draining responses carry `connection: close`, so
        // their sockets end themselves).
        server.close();
        server.closeIdleConnections();
        let done = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let appSettled = false;
        const finish = (timedOut: boolean): void => {
          if (done) return;
          done = true;
          // The waiters live for the whole close (zero-crossings re-run
          // trySettle until both conditions align — see onWireDone); retire
          // them here so a later stopGraceful starts clean.
          wireWaiters.length = 0;
          if (timer !== undefined) clearTimeout(timer);
          if (timedOut) server.closeAllConnections();
          else server.closeIdleConnections();
          resolve({ timedOut });
        };
        const trySettle = (): void => {
          if (wireInFlight === 0 && appSettled) finish(false);
        };
        // Operator escalation (second SIGTERM): kill sockets AND this wait.
        grace.registerForce?.(() => finish(true));
        // Arm the timer BEFORE the settled checks (FINDING-6): a finish on
        // the already-settled path must be able to clear it. Infinity never
        // arms (setTimeout clamps it to ~1ms — FINDING-3).
        if (grace.drain !== Number.POSITIVE_INFINITY) {
          timer = setTimeout(() => finish(true), grace.drain);
        }
        if (
          grace.onSettled(() => {
            appSettled = true;
            trySettle();
          })
        ) {
          appSettled = true;
        }
        // Subscribe to the wire's last response finishing; onWireDone wakes all
        // waiters the moment wireInFlight reaches zero.
        if (wireInFlight > 0) wireWaiters.push(trySettle);
        trySettle();
      });
    },
  };
  const server: Server = createServer(options.http ?? {}, (incoming, out) => {
    wireInFlight++;
    // Wire truth + client-disconnect bridge, one handler registered twice.
    // res 'close' fires for every STARTED response — completed OR terminated
    // prematurely — so a separate 'finish' listener is redundant, and 'close'
    // is the more honest settle point (last byte flushed, not handed to the
    // kernel). A pipelined response that never started writing gets no res
    // 'close' on socket death at all (REVIEW-SEC-17), so the SOCKET's own
    // close settles the wire count too. Idempotent through `wireDone`; the
    // socket registration is detached on first settle — a keep-alive socket
    // must not accumulate per-request listeners.
    const socket = incoming.socket;
    let source: NodeRequestSource | null = null;
    let wireDone = false;
    const onWireDone = (): void => {
      if (wireDone) return;
      wireDone = true;
      wireInFlight--;
      socket.removeListener("close", onWireDone);
      if (!out.writableEnded && source !== null) {
        source.disconnect(new DOMException("client disconnected", "AbortError"));
      }
      if (wireInFlight === 0 && wireWaiters.length > 0) {
        // Waiters stay registered (cleared only when a close finishes): a
        // zero-crossing can be unproductive — the app counter may settle
        // later, and a LATE keep-alive request can dip the wire to zero
        // again (REVIEW-BUG-9). Every zero-crossing re-runs trySettle;
        // the done-guard makes repeats free.
        for (const wake of wireWaiters) wake();
      }
    };
    out.on("close", onWireDone);
    socket.on("close", onWireDone);
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
    const answer = (response: Response): void => {
      if (source !== null && mayCarryBody(source.method)) source.cleanupUnread();
      try {
        const writing = writeResponse(response, out, draining);
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
  // Register on the app's server slot so app.close() reaches this server no
  // matter how it was started (listen() or a direct startNodeServer).
  attachServer(app, handle);
  if (options.signals === true) installSignalBridge(app);
  return handle;
};

/** `app.listen(port)`-style sugar for Node: `listen(app, 3000, "127.0.0.1")`
 * or `listen(app, { port: 3000, hostname: "127.0.0.1", signals: true })`. */
export const listen = (
  app: Application,
  portOrOptions?: number | NodeListenOptions,
  hostname?: string,
  onListen?: () => void,
): NodeServerHandle => {
  const options: NodeListenOptions =
    typeof portOrOptions === "object" && portOrOptions !== null
      ? { hostname, ...portOrOptions }
      : { port: portOrOptions, hostname };
  return startNodeServer(app, options, onListen);
};
