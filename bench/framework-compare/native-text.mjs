/**
 * Engine-isolation probe for synchronous Kernel text routes, not a general
 * framework backend. Fetch, middleware and async results deliberately get 501.
 * Unlike the Node executor it offers no async HTTP pipeline or graceful drain
 * contract: close() force-closes the native app, including buffered output.
 * Native req/res never escape their callback, including rejection observers.
 */
const TEXT_TYPE = "text/plain; charset=utf-8";
const UNSUPPORTED = "Native text probe supports synchronous text only";
const ERROR = "Internal Server Error";
const REASONS = Object.freeze({
  200: "OK",
  201: "Created",
  204: "No Content",
  205: "Reset Content",
  304: "Not Modified",
  400: "Bad Request",
  404: "Not Found",
  405: "Method Not Allowed",
  500: "Internal Server Error",
  501: "Not Implemented",
});
const emptyStatus = (status) => status === 204 || status === 205 || status === 304;
const noop = () => undefined;
const discard = (value) => {
  try {
    if (value instanceof Response && value.body && !value.body.locked)
      void value.body.cancel().catch(noop);
  } catch {
    /* Disposal cannot change the synchronous rejection response. */
  }
};
const promise = (value) =>
  value !== null &&
  (typeof value === "object" || typeof value === "function") &&
  typeof value.then === "function";
const rejectCapability = (response, head, value) => {
  if (promise(value)) void Promise.resolve(value).then(discard, noop);
  else discard(value);
  response.writeStatus("501 Not Implemented").writeHeader("content-type", TEXT_TYPE);
  if (head) response.endWithoutBody(Buffer.byteLength(UNSUPPORTED));
  else response.end(UNSUPPORTED);
};
const text = (response, head, body) => {
  response.writeHeader("content-type", TEXT_TYPE);
  if (head) response.endWithoutBody(Buffer.byteLength(body));
  else response.end(body);
};
// Reply is an immutable snapshot. Structural validation keeps this probe free
// of a second Kernel import when benchmarks inject the compiled executable.
const replySnapshot = (value) => {
  if (value === null || typeof value !== "object" || !Object.isFrozen(value)) return;
  const status = value.status,
    body = value.body,
    input = value.headers;
  if (
    !Number.isInteger(status) ||
    status < 200 ||
    status > 599 ||
    (body !== null && typeof body !== "string") ||
    !Array.isArray(input)
  )
    return;
  if (body !== null && emptyStatus(status)) throw new TypeError("null-body status has a body");
  const entries = [],
    count = input.length;
  if (!Number.isSafeInteger(count) || count < 0) throw new TypeError("invalid header count");
  for (let i = 0; i < count; i++) {
    const entry = input[i];
    if (!Array.isArray(entry) || entry.length !== 2) throw new TypeError("invalid header tuple");
    const name = entry[0],
      content = entry[1];
    if (typeof name !== "string" || typeof content !== "string")
      throw new TypeError("invalid header type");
    entries.push([name, content]);
  }
  // Freeze does not make getters pure or nested tuples immutable. Validate
  // only our copied strings, before the first writeStatus/writeHeader call.
  const validated = new Headers(entries),
    headers = [];
  for (const [name, content] of validated)
    if (name !== "set-cookie") headers.push([name, Buffer.from(content, "latin1")]);
  for (const cookie of validated.getSetCookie())
    headers.push(["set-cookie", Buffer.from(cookie, "latin1")]);
  return { status, body, headers };
};
const send = (response, head, value) => {
  if (typeof value === "string") {
    text(response, head, value);
    return;
  }
  if (promise(value) || value instanceof Response) {
    rejectCapability(response, head, value);
    return;
  }
  const snapshot = replySnapshot(value);
  if (!snapshot) {
    rejectCapability(response, head, value);
    return;
  }
  const { status, body, headers } = snapshot,
    empty = emptyStatus(status);
  response.writeStatus(`${status} ${REASONS[status] ?? ""}`);
  for (const [name, content] of headers) {
    if (name === "content-length" || name === "transfer-encoding" || name === "connection")
      continue;
    if (empty && name === "content-type") continue;
    response.writeHeader(name, content);
  }
  if (status === 205) response.end("");
  else if (empty) response.endWithoutBody();
  else if (head) response.endWithoutBody(Buffer.byteLength(body ?? ""));
  else response.end(body ?? "");
};

export const listenNativeText = (executable, uws, options = {}) =>
  new Promise((resolve, reject) => {
    const app = uws.App();
    let closed = false;
    const close = () => {
      if (!closed) {
        closed = true;
        app.close();
      }
    };
    app.any("/*", (response, request) => {
      let head = false;
      try {
        // getMethod/getUrl return owned JS strings; the stack-native request is
        // deliberately never stored or passed to an asynchronous continuation.
        const method = request.getMethod().toUpperCase(),
          url = request.getUrl();
        head = method === "HEAD";
        const selection = executable.select(method, url);
        if (executable.needsRequest(selection)) {
          rejectCapability(response, head);
          return;
        }
        send(response, head, executable.invoke(selection));
      } catch (error) {
        try {
          send(response, head, executable.fail(error));
        } catch {
          response.writeStatus("500 Internal Server Error").writeHeader("content-type", TEXT_TYPE);
          if (head) response.endWithoutBody(Buffer.byteLength(ERROR));
          else response.end(ERROR);
        }
      }
    });
    try {
      app.listen(options.hostname ?? "127.0.0.1", options.port ?? 0, (socket) => {
        if (!socket) {
          close();
          reject(new Error("native text listen failed"));
          return;
        }
        try {
          const port = uws.us_socket_local_port(socket);
          if (!Number.isInteger(port) || port < 1) throw new Error("invalid native listen port");
          resolve({ port, close });
        } catch (error) {
          close();
          reject(error);
        }
      });
    } catch (error) {
      close();
      reject(error);
    }
  });
