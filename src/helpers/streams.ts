/**
 * Streaming helpers: `stream`, `streamText` and `streamSSE`.
 *
 * All three return a Response built around a ReadableStream the callback
 * writes into. The writer exposes `desiredSize` for backpressure awareness
 * and `onAbort` for client-disconnect cleanup; SSE adds field sanitization
 * (event/id can never smuggle CR/LF) and an optional heartbeat comment that
 * keeps idle connections alive under Bun's default 10s idleTimeout.
 */

import type { Context } from "../core/context/context.ts";

/**
 * Disable Bun's per-request idle timeout (`server.timeout(req, 0)`) for a
 * long-lived response. No-op without a Bun server handle (Node, tests).
 */
export const disableIdleTimeout = (c: Context): void => {
  const server = c.runtime?.server as
    | { timeout?(request: Request, seconds: number): void }
    | undefined;
  server?.timeout?.(c.raw, 0);
};

export interface StreamWriter {
  /** Enqueue one chunk. Returns the controller's desiredSize afterwards. */
  write(chunk: string | Uint8Array): void;
  /** Close the stream; further writes throw. */
  close(): void;
  /** Backpressure signal: negative when the consumer is behind. */
  readonly desiredSize: number | null;
  /** Register cleanup for client disconnects (stream cancel). */
  onAbort(fn: () => void): void;
}

interface WriterInternal extends StreamWriter {
  _aborts: (() => void)[];
}

/** Run one cleanup handler; a throwing one must never break the cancel path. */
const runCleanup = (fn: () => void): void => {
  try {
    fn();
  } catch {
    // cleanup handlers must not break the cancel path
  }
};

const makeStream = (
  start: (writer: WriterInternal) => Promise<void> | void,
  headers: Record<string, string>,
  onError?: (error: unknown) => void,
): Response => {
  const aborts: (() => void)[] = [];
  // Cancellation is STATE, not just an event: a producer that registers its
  // onAbort AFTER the consumer cancelled (any await before the first
  // registration) must still run its cleanup immediately.
  let cancelled = false;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  const encoder = new TextEncoder();
  const writer: WriterInternal = {
    _aborts: aborts,
    write(chunk) {
      controllerRef?.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
    },
    close() {
      try {
        controllerRef?.close();
      } catch {
        // already closed by the consumer — nothing to do
      }
    },
    get desiredSize() {
      return controllerRef?.desiredSize ?? null;
    },
    onAbort(fn) {
      if (cancelled) {
        runCleanup(fn);
        return;
      }
      aborts.push(fn);
    },
  };
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controllerRef = controller;
      try {
        await start(writer);
        writer.close();
      } catch (err) {
        onError?.(err);
        // The client must never see the internal error text.
        try {
          controller.error(err);
        } catch {
          // consumer already closed us
        }
      }
    },
    cancel(reason) {
      controllerRef = null;
      cancelled = true;
      for (const fn of aborts.splice(0)) runCleanup(fn);
      void reason;
    },
  });
  return new Response(body, { headers });
};

/** Generic streaming response (binary chunks). */
export const stream = (
  _c: Context,
  start: (writer: StreamWriter) => Promise<void> | void,
): Response =>
  makeStream(start, {
    "content-type": "application/octet-stream",
    "x-content-type-options": "nosniff",
  });

/** Text streaming response. */
export const streamText = (
  _c: Context,
  start: (writer: StreamWriter) => Promise<void> | void,
): Response =>
  makeStream(start, {
    "content-type": "text/plain; charset=utf-8",
    "x-content-type-options": "nosniff",
  });

export interface SSEMessage {
  event?: string;
  data: unknown;
  id?: string;
  retry?: number;
}

export interface SSEWriter {
  send(message: SSEMessage): void;
  /** Raw comment line (keepalives). */
  comment(text: string): void;
  onAbort(fn: () => void): void;
  readonly desiredSize: number | null;
}

export interface StreamSSEOptions {
  /** Heartbeat comment interval in ms (0 disables). Default 5000 — Bun's
   *  idleTimeout kills silent SSE connections at 10s by default. */
  heartbeat?: number;
}

/** Serialize one event per the SSE wire format (multi-line data supported). */
const sseSanitize = (value: string): string => value.replaceAll(/[\r\n]/g, " ");

const sseFrame = (message: SSEMessage): string => {
  let frame = "";
  if (message.event !== undefined) frame += `event: ${sseSanitize(message.event)}\n`;
  if (message.id !== undefined) frame += `id: ${sseSanitize(message.id)}\n`;
  if (message.retry !== undefined && Number.isFinite(message.retry)) {
    frame += `retry: ${Math.trunc(message.retry)}\n`;
  }
  const data =
    typeof message.data === "string" ? message.data : (JSON.stringify(message.data) ?? "null");
  // Real line breaks (\r\n, \n) split data lines; a LONE \r is also a spec
  // line terminator — neutralize it so it can never forge event/id/retry
  // fields downstream of a parser that treats it as a break.
  for (const line of data.split(/\r\n|\n/).map((part) => part.replaceAll("\r", " "))) {
    frame += `data: ${line}\n`;
  }
  return `${frame}\n`;
};

/** Server-Sent Events response with sanitization, heartbeat and abort cleanup. */
export const streamSSE = (
  c: Context,
  start: (sse: SSEWriter) => Promise<void> | void,
  options: StreamSSEOptions = {},
): Response => {
  // The official SSE remedy: Bun drops idle connections after 10s by default.
  disableIdleTimeout(c);
  const heartbeat = options.heartbeat ?? 5000;
  let timer: ReturnType<typeof setInterval> | null = null;
  const res = makeStream(
    async (writer) => {
      const sse: SSEWriter = {
        send: (message) => writer.write(sseFrame(message)),
        comment: (text) => writer.write(`: ${text.replaceAll(/[\r\n]/g, " ")}\n\n`),
        onAbort: (fn) => writer.onAbort(fn),
        get desiredSize() {
          return writer.desiredSize;
        },
      };
      if (heartbeat > 0) {
        timer = setInterval(() => {
          // A heartbeat on a closed controller must never crash the process.
          try {
            writer.write(": ping\n\n");
          } catch {
            if (timer !== null) clearInterval(timer);
          }
        }, heartbeat);
      }
      writer.onAbort(() => {
        if (timer !== null) clearInterval(timer);
      });
      await start(sse);
      if (timer !== null) clearInterval(timer);
    },
    {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-content-type-options": "nosniff",
    },
    () => {
      if (timer !== null) clearInterval(timer);
    },
  );
  return res;
};
