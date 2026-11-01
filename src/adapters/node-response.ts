/** Keala framing and response ownership at the srvx sender boundary. */
import { NodeResponse, sendNodeResponse } from "srvx/node";
import type { ServerResponse } from "node:http";
import { responseFactsOf } from "../core/response-plan.ts";
import { discardBody } from "../utils/streams.ts";
import { statusMessage } from "../http/status.ts";

/** Same silent physical-send failure contract as srvx's Node listener. */
export const failNodeSend = (out: ServerResponse): void => {
  if (out.writableEnded) return;
  if (out.headersSent) out.destroy();
  else {
    out.statusCode = 500;
    if (out.req.httpVersion !== "2.0") out.statusMessage = "";
    out.end();
  }
};

/** Send an already prepared general response through srvx, including streams. */
export const sendPreparedNodeResponse = (out: ServerResponse, response: Response): void => {
  if (out.destroyed) {
    discardBody(response);
    return;
  }
  void sendNodeResponse(out, response).catch(() => failNodeSend(out));
};

/**
 * Only an unobserved default plan has no live Headers or native body stream.
 * end(body) lets node:http coalesce UTF-8 headers/body into one write instead
 * of constructing a second response and buffering write(body) + end().
 */
export const tryWriteBareNodeResponse = (
  response: Response,
  out: ServerResponse,
  closeAfter: boolean,
): boolean => {
  if (out.destroyed || response.status !== 200) return false;
  const facts = responseFactsOf(response);
  if (facts?.planned !== true || facts.native !== undefined || facts.headerSnapshot !== undefined)
    return false;
  const body = facts.directBody;
  const headers: Record<string, string> = {};
  if (facts.implicitContentType !== undefined) headers["content-type"] = facts.implicitContentType;
  if (closeAfter) headers["connection"] = "close";
  headers["content-length"] = String(
    typeof body === "string" ? Buffer.byteLength(body) : body.byteLength,
  );
  // Preparation errors belong to Keala's mapper; physical writes retain
  // srvx's silent-send failure contract, even with a custom ServerResponse.
  try {
    if (!out.headersSent) {
      if (out.req.httpVersion === "2.0") out.writeHead(200, headers);
      else out.writeHead(200, "OK", headers);
    }
    out.end(body);
  } catch {
    failNodeSend(out);
  }
  return true;
};

export const prepareNodeResponse = (
  response: Response,
  out: ServerResponse,
  closeAfter: boolean,
): Response | Promise<Response> => {
  if (out.destroyed) {
    discardBody(response);
    return new NodeResponse(null);
  }
  if (response.status < 200 || response.status > 599) {
    throw new RangeError("cannot send an error or invalid-status response");
  }
  const facts = responseFactsOf(response);
  if (facts?.planned === true && facts.native === undefined && facts.headerSnapshot === undefined) {
    // srvx infers the byte-exact length; avoid calculating it twice.
    const headers: Record<string, string> = {};
    if (facts.implicitContentType !== undefined)
      headers["content-type"] = facts.implicitContentType;
    if (closeAfter) headers["connection"] = "close";
    return new NodeResponse(facts.directBody, { statusText: "OK", headers });
  }
  if (facts === undefined && (response.bodyUsed || response.body?.locked === true)) {
    throw new TypeError(
      "cannot send a consumed or locked response body — build a fresh Response per call",
    );
  }
  const sourceHeaders = facts?.headerSnapshot ?? response.headers;
  if (
    facts?.planned === true &&
    facts.native === undefined &&
    facts.headerSnapshot !== undefined &&
    !closeAfter &&
    !sourceHeaders.has("transfer-encoding") &&
    !sourceHeaders.has("content-length")
  ) {
    // Only this private snapshot has no public aliases. Live Headers need
    // the clone below: user microtasks can mutate them before srvx sends.
    // srvx already knows this finite body's exact length.
    const body =
      typeof facts.directBody === "string" && !sourceHeaders.has("content-type")
        ? Buffer.from(facts.directBody)
        : facts.directBody;
    return new NodeResponse(body, {
      status: response.status,
      statusText: response.statusText || statusMessage(response.status),
      headers: sourceHeaders,
    });
  }
  const headers = new Headers(sourceHeaders);
  if (closeAfter) headers.set("connection", "close");
  if (headers.has("transfer-encoding")) headers.delete("content-length");
  const init = {
    status: response.status,
    statusText: response.statusText || statusMessage(response.status),
    headers,
  };
  if (facts !== undefined) {
    if (headers.has("transfer-encoding")) {
      // srvx infers CL for buffered bodies. Keep explicit TE on its stream
      // path so the sender can never emit both framing headers.
      const bytes =
        typeof facts.directBody === "string" ? Buffer.from(facts.directBody) : facts.directBody;
      return new NodeResponse(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        init,
      );
    }
    if (!headers.has("transfer-encoding")) {
      headers.set(
        "content-length",
        String(
          typeof facts.directBody === "string"
            ? Buffer.byteLength(facts.directBody)
            : facts.directBody.byteLength,
        ),
      );
    }
    const body =
      typeof facts.directBody === "string" && !headers.has("content-type")
        ? Buffer.from(facts.directBody)
        : facts.directBody;
    return new NodeResponse(body, init);
  }
  if (response.body === null) {
    // A real empty body must not consume the next keep-alive response.
    // HEAD retains the representation length computed by the core.
    if (out.req.method !== "HEAD") {
      headers.delete("transfer-encoding");
      if (response.status !== 204 && response.status !== 304) headers.set("content-length", "0");
    }
    return new NodeResponse(null, init);
  }
  // Foreign streams cannot prove a caller's Content-Length. Preserve safe
  // keep-alive framing and map errors before the first byte through Keala.
  headers.delete("content-length");
  return prepareStream(response.body, out).then((body) => new NodeResponse(body, init));
};

const prepareStream = async (
  body: ReadableStream<Uint8Array>,
  out: ServerResponse,
): Promise<ReadableStream<Uint8Array>> => {
  const reader = body.getReader();
  let done = false;
  const cleanup = (): void => {
    out.off("close", cancel);
  };
  const cancel = (): void => {
    void reader.cancel("client disconnected").catch(() => undefined);
  };
  out.once("close", cancel);
  if (out.destroyed) cancel();
  try {
    const first = await reader.read();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        if (first.done) {
          done = true;
          cleanup();
          controller.close();
        } else controller.enqueue(first.value);
      },
      async pull(controller) {
        if (done) return;
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            done = true;
            cleanup();
            controller.close();
          } else controller.enqueue(chunk.value);
        } catch (error) {
          done = true;
          cleanup();
          controller.error(error);
        }
      },
      cancel(reason) {
        done = true;
        cleanup();
        return reader.cancel(reason);
      },
    });
  } catch (error) {
    cleanup();
    void reader.cancel(error).catch(() => undefined);
    throw error;
  }
};
