/**
 * Node adapter: `node:http` glue for running the same app under Node.
 *
 * The framework stays fetch-shaped: an IncomingMessage is bridged to a web
 * Request (the body streams through, it is never buffered by the adapter),
 * and the returned web Response is piped into the ServerResponse with
 * set-cookie fanout. Websockets are Bun-only: this handle exposes no
 * `upgrade`, so `app.ws()` routes answer 501 and raw Upgrade requests are
 * refused before routing.
 *
 * ```ts
 * import { Honu } from "@renxqoo/honu";
 * import { listen } from "@renxqoo/honu/node";
 *
 * const app = new Honu();
 * app.get("/", (c) => { c.body = "hello"; });
 * listen(app, 3000);
 * ```
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerOptions,
  type ServerResponse,
} from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Application } from "../core/app.ts";

export interface NodeServerHandle {
  readonly port: number;
  readonly hostname: string;
  stop(closeActiveConnections?: boolean): void;
  /** In-process request handler — same shape as the Bun server handle. */
  fetch(request: Request): Response | Promise<Response>;
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

const requestOf = (incoming: IncomingMessage, fallbackHost: string): Request => {
  const method = incoming.method ?? "GET";
  const headers = new Headers();
  // Node joins repeated request headers into one value at runtime (the
  // array shape in the type is response-side); the join keeps even a
  // hypothetical request-side array correct.
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  // Origin-form is prefixed with an authority: the request's own Host header
  // when present (`c.host` and same-origin checks must see it), else the
  // bound address. An absolute-form target (proxy-style requests) is used
  // verbatim — its own authority IS the identity. `OPTIONS *` (server-wide
  // options, RFC 7231 §4.3.7) addresses the whole server, not a path — map
  // it to "/" so the router decides instead of the URL constructor throwing.
  const target = incoming.url ?? "/";
  const requestTarget = target === "*" ? "/" : target;
  const url = /^https?:\/\//i.test(requestTarget)
    ? requestTarget
    : `http://${incoming.headers.host ?? fallbackHost}${requestTarget}`;
  const declared = incoming.headers["content-length"];
  const chunked = incoming.headers["transfer-encoding"] !== undefined;
  if (!mayCarryBody(method) || (declared === undefined && !chunked) || declared === "0") {
    return new Request(url, { method, headers });
  }
  return new Request(url, {
    method,
    headers,
    body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>,
    duplex: "half",
  });
};

const writeResponse = async (res: Response, out: ServerResponse): Promise<void> => {
  out.statusCode = res.status;
  if (res.statusText.length > 0) out.statusMessage = res.statusText;
  const cookies = res.headers.getSetCookie();
  for (const [name, value] of res.headers) {
    if (name === "set-cookie") continue;
    out.setHeader(name, value);
  }
  if (cookies.length > 0) out.setHeader("set-cookie", cookies);
  if (res.body === null) {
    out.end();
    return;
  }
  // pipeline() propagates backpressure and destroys the source when the
  // client disconnects mid-stream.
  await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), out);
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
    void (async () => {
      try {
        const fallbackHost = authorityOf(handle.hostname, handle.port);
        const remote = incoming.socket.remoteAddress;
        const response = await app.handle(requestOf(incoming, fallbackHost), {
          server: handle,
          ...(remote !== undefined ? { remote } : {}),
        });
        await writeResponse(response, out);
      } catch {
        // app.handle itself never rejects — this is a bridge failure (socket
        // torn down mid-body, unwritable response).
        if (!out.headersSent) {
          out.statusCode = 500;
          out.setHeader("content-type", "text/plain; charset=utf-8");
          out.end("Internal Server Error");
        } else {
          out.destroy();
        }
      }
    })();
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
