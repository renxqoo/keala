/**
 * Node adapter: `node:http` glue for running the same app under Node.
 *
 * IncomingMessage enters the lazy native RequestSource; direct bodies write
 * to ServerResponse without a WebStream bridge, while foreign streams retain
 * backpressure/cancellation. Websockets remain Bun-only and answer 501.
 */

import type { Server, ServerOptions, IncomingMessage, ServerResponse } from "node:http";
import { Server as HttpServer } from "node:http";
import { serve as serveNode } from "srvx/node";
import {
  failNodeSend,
  prepareNodeResponse,
  sendPreparedNodeResponse,
  tryWriteBareNodeResponse,
} from "./node-response.ts";
import type { Application } from "../core/app.ts";
import { consoleFallback } from "../core/error-response.ts";
import { toHttpError } from "../http/errors.ts";
import { HANDLE_REQUEST_SOURCE, type NativeApplication } from "../core/application.ts";
import type { GracefulStopOptions } from "../core/lifecycle.ts";
import { installSignalBridge } from "../core/lifecycle.ts";
import { attachServer, assertCanStart } from "../core/server-slot.ts";
import { InvalidRequestTargetError, mayCarryBody, NodeRequestSource } from "./node-source.ts";
import {
  registerSocketClose,
  unregisterSocketClose,
  type SocketCloseRegistration,
} from "./node-socket-fanout.ts";
import { createNodeDrainTracker, holdNodeClose, releaseNodeClose } from "./node-drain.ts";

const WIRE_SOURCE = Symbol("keala.wireSource");
const WIRE_FANOUT = Symbol("keala.wireFanout");
const WIRE_RELEASE = Symbol("keala.wireRelease");
type TrackedResponse = ServerResponse & {
  [WIRE_SOURCE]?: NodeRequestSource | null;
  [WIRE_FANOUT]?: SocketCloseRegistration;
  [WIRE_RELEASE]?: () => void;
};

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

const NODE_LISTEN_KEYS = new Set([
  "port",
  "hostname",
  "http",
  "signals",
  "onServeError",
  "idleTimeout",
  "maxRequestBodySize",
]);

export interface NodeListenOptions {
  /** Listen port. Default 3000 (0 picks a free port). */
  port?: number;
  /** Bind address. Default: Node's (all interfaces). */
  hostname?: string;
  /** Pass-through for node:http ServerOptions (highWaterMark, keepAlive…). */
  http?: ServerOptions;
  /**
   * Keep-alive idle timeout in SECONDS (Bun parity: the same unit
   * `listen({ idleTimeout })` uses there). Maps onto Node's
   * `keepAliveTimeout` (milliseconds); an explicit `http.keepAliveTimeout`
   * wins — a shared config object should mean the same thing on both
   * runtimes (Node default 5s, Bun 10s).
   */
  idleTimeout?: number;
  /**
   * Transport-level request-body cap in bytes (Bun parity): every body
   * read through the native source refuses beyond it with 413, regardless
   * of plugin limits — without it the Node side has NO transport cap.
   */
  maxRequestBodySize?: number;
  /**
   * R4.6 signal bridge (opt-in): SIGTERM/SIGINT drain the server via
   * `app.close()`; a second signal force-closes.
   */
  signals?: boolean;
  /**
   * Server-level error handler, mirroring the Bun adapter's option: when a
   * transport/write failure happens before any byte was sent, its Response
   * replaces the plain envelope (500s also log via the error-hook fallback).
   */
  onServeError?: (error: Error) => Response;
}

/**
 * Start a node:http server for the app. Mirrors `startBunServer`'s handle
 * shape (port/hostname/stop/fetch) so operational code stays runtime-agnostic.
 */
export const startNodeServer = (
  app: Application,
  options: NodeListenOptions = {},
  onListen?: () => void,
): NodeServerHandle => {
  // HA-3: double-start guard (app.listen() parity) — a second server used
  // to overwrite the slot, orphaning the first on a bound port, 503s forever.
  assertCanStart(app);
  for (const key of Object.keys(options)) {
    if (NODE_LISTEN_KEYS.has(key)) continue;
    // Known Bun-only keys get their migration story, not a bare "unknown
    // option" — a dual-runtime config object should fail with the reason.
    const bunOnly: Record<string, string> = {
      reusePort: "reusePort is Bun-only (SO_REUSEPORT); under Node scale with the cluster module",
      nativeRoutes:
        "nativeRoutes sinks into Bun's native routing table; the Node adapter always serves from JS",
      websocket: "websockets are Bun-only; the Node adapter answers upgrades with 501",
      development: "development mode is a Bun.serve option with no node:http equivalent",
    };
    throw new TypeError(
      bunOnly[key] ??
        `startNodeServer(): unknown option ${JSON.stringify(key)} — a typo here is silently ignored`,
    );
  }
  if (
    options.idleTimeout !== undefined &&
    (!Number.isFinite(options.idleTimeout) || options.idleTimeout < 0)
  ) {
    throw new RangeError("idleTimeout must be a non-negative number of seconds");
  }
  if (
    options.maxRequestBodySize !== undefined &&
    (!Number.isFinite(options.maxRequestBodySize) || options.maxRequestBodySize < 0)
  ) {
    throw new RangeError("maxRequestBodySize must be a non-negative byte count");
  }
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
        if (drainTracker === undefined) {
          server.close();
          server.closeIdleConnections();
        } else {
          // HTTP close() calls closeIdleConnections(), whose idle test can
          // include end()-called buffered output that has not flushed yet.
          // Replace only that synchronous step. A single HTTP close also
          // clears its request timeout interval and emits close only once.
          const idleDescriptor = Object.getOwnPropertyDescriptor(server, "closeIdleConnections");
          const replaceable =
            idleDescriptor === undefined
              ? Object.isExtensible(server)
              : idleDescriptor.configurable === true ||
                ("value" in idleDescriptor && idleDescriptor.writable === true);
          if (!replaceable) {
            // An immutable user hook retains its original close contract.
            server.close();
            drainTracker.closeIdle();
          } else {
            Object.defineProperty(server, "closeIdleConnections", {
              value: () => drainTracker.closeIdle(),
              ...(idleDescriptor === undefined ? { configurable: true } : {}),
            });
            try {
              server.close();
            } finally {
              if (idleDescriptor === undefined)
                delete (server as Partial<Server>).closeIdleConnections;
              else Object.defineProperty(server, "closeIdleConnections", idleDescriptor);
            }
          }
        }
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
          drainTracker?.stop();
          if (timer !== undefined) clearTimeout(timer);
          if (timedOut) server.closeAllConnections();
          else if (drainTracker !== undefined) drainTracker.closeIdle();
          else server.closeIdleConnections();
          resolve({ timedOut });
        };
        const trySettle = (): void => {
          if (wireInFlight === 0 && (drainTracker?.pending ?? 0) === 0 && appSettled) finish(false);
        };
        drainTracker?.start(trySettle);
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
        wireWaiters.push(trySettle);
        trySettle();
      });
    },
  };
  // idleTimeout is SECONDS (Bun's unit); keepAliveTimeout is milliseconds.
  // An explicit http.keepAliveTimeout wins — the passthrough stays the
  // escape hatch for every other node:http knob.
  const httpOptions: ServerOptions = { ...options.http };
  // Custom response classes may transform write() or flush headers in their
  // constructor. Preserve their srvx write(body) + end() contract verbatim.
  const directBufferedResponses = httpOptions.ServerResponse === undefined;
  if (options.idleTimeout !== undefined && httpOptions.keepAliveTimeout === undefined) {
    httpOptions.keepAliveTimeout = options.idleTimeout * 1000;
  }
  const transport = serveNode({
    port: options.port ?? 3000,
    ...(options.hostname === undefined ? {} : { hostname: options.hostname }),
    // Explicit undefined preserves Node's native all-interface default over srvx HOST.
    node: { ...httpOptions, host: options.hostname },
    manual: true,
    silent: true,
    gracefulShutdown: false,
    fetch: (request) => {
      const { req, res } = request.runtime!.node!;
      return dispatch(req as IncomingMessage, res as ServerResponse);
    },
  });
  const server = transport.node!.server as Server;
  // Real Node assigns the active response to its socket before emitting
  // request, and its own socket-close handler emits that response's close.
  // Only queued pipeline responses need the extra socket fanout. Preserve
  // the conservative bridge for custom response classes and Bun's shim.
  const boundResponseClose =
    directBufferedResponses && process.versions.bun === undefined && server instanceof HttpServer;
  const drainTracker = boundResponseClose ? createNodeDrainTracker(server) : undefined;
  function onWireDone(this: TrackedResponse): void {
    const source = this[WIRE_SOURCE];
    if (source === undefined) return;
    this[WIRE_SOURCE] = undefined;
    wireInFlight--;
    const release = this[WIRE_RELEASE];
    if (release !== undefined) {
      this[WIRE_RELEASE] = undefined;
      release();
    }
    const fanout = this[WIRE_FANOUT];
    if (fanout !== undefined) {
      this[WIRE_FANOUT] = undefined;
      unregisterSocketClose(fanout);
    }
    if (!this.writableEnded && source !== null) {
      source.disconnect(new DOMException("client disconnected", "AbortError"));
    }
    if (wireInFlight === 0 && wireWaiters.length > 0) {
      for (const wake of wireWaiters) wake();
    }
  }
  const trackWire = (
    incoming: IncomingMessage,
    out: TrackedResponse,
    source: NodeRequestSource | null,
  ): void => {
    out[WIRE_SOURCE] = source;
    if (drainTracker !== undefined) out[WIRE_RELEASE] = drainTracker.queue(incoming);
    out.on("close", onWireDone);
    if (!boundResponseClose || out.socket !== incoming.socket) {
      out[WIRE_FANOUT] = registerSocketClose(incoming.socket, () => onWireDone.call(out));
    }
  };
  const envelope = (error: unknown): Response => {
    const status = error instanceof InvalidRequestTargetError ? 400 : 500;
    const message = status === 400 ? "Bad Request" : "Internal Server Error";
    return new Response(message, {
      status,
      statusText: message,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "content-length": String(Buffer.byteLength(message)),
      },
    });
  };
  const fail = (error: unknown, out: ServerResponse): Response | Promise<Response> => {
    consoleFallback(app, undefined, toHttpError(error));
    if (!(error instanceof InvalidRequestTargetError) && options.onServeError !== undefined) {
      try {
        const mapped = prepareNodeResponse(options.onServeError(toHttpError(error)), out, draining);
        return mapped instanceof Promise ? mapped.catch(() => envelope(error)) : mapped;
      } catch {
        /* A hostile mapper must not break the transport envelope. */
      }
    }
    return envelope(error);
  };
  const answer = (
    response: Response,
    source: NodeRequestSource,
    out: ServerResponse,
    direct: boolean,
  ): Response | void | Promise<Response> => {
    const abandonedRead = source.hasPendingOwnedRead();
    if (mayCarryBody(source.method)) source.cleanupUnread();
    if (abandonedRead) {
      const socket = out.socket ?? source.incoming.socket;
      holdNodeClose(out);
      out.once("close", () => {
        try {
          source.disconnect(new DOMException("early answer abandoned the body", "AbortError"));
          socket?.destroy();
        } finally {
          releaseNodeClose(out);
        }
      });
    }
    const closeAfter = draining || abandonedRead;
    if (direct && directBufferedResponses && tryWriteBareNodeResponse(response, out, closeAfter))
      return;
    return prepareNodeResponse(response, out, closeAfter);
  };
  function dispatch(incoming: IncomingMessage, out: ServerResponse): Response | Promise<Response>;
  function dispatch(
    incoming: IncomingMessage,
    out: ServerResponse,
    direct: true,
  ): Response | void | Promise<Response | void>;
  function dispatch(
    incoming: IncomingMessage,
    out: ServerResponse,
    direct = false,
  ): Response | void | Promise<Response | void> {
    // A queued response may close before it is ever assigned a socket;
    // that is not a FIFO finish and cannot stand for its predecessor.
    const connectionTracked = drainTracker !== undefined && out.socket === incoming.socket;
    if (connectionTracked) drainTracker.track(incoming, out);
    else wireInFlight++;
    let tracked = false;
    try {
      const source = new NodeRequestSource(incoming, handle, options.maxRequestBodySize, out);
      if (!connectionTracked) {
        tracked = true;
        trackWire(incoming, out, source);
      }
      const result = (app as NativeApplication)[HANDLE_REQUEST_SOURCE](source);
      if (result instanceof Promise) {
        return result
          .then((response) => answer(response, source, out, direct))
          .catch((error: unknown) => fail(error, out));
      }
      const prepared = answer(result, source, out, direct);
      return prepared instanceof Promise
        ? prepared.catch((error: unknown) => fail(error, out))
        : prepared;
    } catch (error) {
      if (!tracked && !connectionTracked) trackWire(incoming, out, null);
      return fail(error, out);
    }
  }

  // Keala already owns a lazy IncomingMessage source. Origin-form requests
  // need neither a second srvx Request nor a second buffered Response. Keep
  // srvx's full handler for every other target so its absolute-form/protocol
  // validation and error envelopes remain authoritative and unchanged.
  const nativeHandler = transport.node!.handler;
  server.removeListener("request", nativeHandler);
  server.on("request", (incoming: IncomingMessage, out: ServerResponse) => {
    if (incoming.url?.charCodeAt(0) !== 47) return nativeHandler(incoming, out);
    try {
      const result = dispatch(incoming, out, true);
      if (result instanceof Promise) {
        void result.then(
          (response) => {
            if (response !== undefined) sendPreparedNodeResponse(out, response);
          },
          () => failNodeSend(out),
        );
      } else if (result !== undefined) sendPreparedNodeResponse(out, result);
    } catch {
      failNodeSend(out);
    }
  });

  server.on("listening", () => {
    const addr = server.address();
    if (typeof addr === "object" && addr !== null) {
      address = { port: addr.port, address: addr.address };
    }
    settled?.();
    if (onListen !== undefined) {
      // Same containment as the Bun adapter: a throwing callback dies in
      // the console, not as an uncaughtException inside 'listening'.
      try {
        onListen();
      } catch (error) {
        console.error("onListen callback threw:", error);
      }
    }
  });
  server.on("error", (error: Error) => {
    failed?.(error);
  });
  // Malformed HTTP: answer 400 and drop the connection (Node's default
  // would just destroy the socket); `end` flushes the reply first.
  server.on("clientError", (_err, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  // With an 'upgrade' listener present, upgrades never reach 'request';
  // websockets are Bun-only — answer the wire-level refusal here.
  server.on("upgrade", (_req, socket) => {
    socket.end("HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\n");
  });

  void Promise.resolve(transport.serve()).catch((error: unknown) => {
    failed?.(error instanceof Error ? error : new Error(String(error)));
  });
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
