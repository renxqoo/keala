export type Params = Readonly<Record<string, string>>;
// Bun's ambient constructor adds textStream(); it is not a cross-runtime API.
export type WebResponse = ReturnType<Response["clone"]>;
export type Value = string | WebResponse | Reply;
export type Result = Value | PromiseLike<Value>;
export type TextResult = string | PromiseLike<string>;
export const TEXT_TYPE = "text/plain; charset=utf-8";
const emptyStatus = (status: number) => status === 204 || status === 205 || status === 304;

/** A reusable string snapshot, deliberately separate from the Fetch Response API. */
export class Reply {
  readonly body: string | null;
  readonly status: number;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  constructor(
    body: string | null,
    status = 200,
    headers?: ConstructorParameters<typeof Headers>[0],
  ) {
    if (!Number.isInteger(status) || status < 200 || status > 599)
      throw new RangeError("invalid response status");
    if (body !== null && typeof body !== "string")
      throw new TypeError("Reply body must be a string or null");
    if (body !== null && emptyStatus(status))
      throw new TypeError("null-body status cannot contain a body");
    const normalized = new Headers(headers);
    if (body !== null && !normalized.has("content-type")) normalized.set("content-type", TEXT_TYPE);
    const entries: Array<readonly [string, string]> = [];
    for (const [key, value] of normalized)
      if (key !== "set-cookie") entries.push(Object.freeze([key, value]));
    for (const cookie of normalized.getSetCookie())
      entries.push(Object.freeze(["set-cookie", cookie]));
    this.body = body;
    this.status = status;
    this.headers = Object.freeze(entries);
    Object.freeze(this);
  }
}
export const json = (value: unknown, status = 200): Reply => {
  const body = JSON.stringify(value);
  if (body === undefined) throw new TypeError("value is not JSON serializable");
  return new Reply(body, status, { "content-type": "application/json; charset=utf-8" });
};
export const isPromise = (value: unknown): value is PromiseLike<Value> =>
  value !== null &&
  (typeof value === "object" || typeof value === "function") &&
  typeof (value as { then?: unknown }).then === "function";
export const ERROR_REPLY = new Reply("Internal Server Error", 500);
export const PATH_ERROR = new Reply("Bad Request", 400);

export const toResponse = (value: Value, head = false): Response => {
  if (typeof value === "string")
    return head
      ? new Response(null, {
          headers: {
            "content-type": TEXT_TYPE,
            "content-length": String(new TextEncoder().encode(value).length),
          },
        })
      : new Response(value);
  if (value instanceof Reply) {
    const headers = new Headers(value.headers as Array<[string, string]>);
    if (head && value.body !== null)
      headers.set("content-length", String(new TextEncoder().encode(value.body).length));
    return new Response(head ? null : value.body, { status: value.status, headers });
  }
  if (!(value instanceof Response))
    throw new TypeError("handler must return string, Reply or Response");
  const status = value.status;
  if (!Number.isInteger(status) || status < 200 || status > 599)
    throw new RangeError("invalid response status");
  if (value.bodyUsed || value.body?.locked)
    throw new TypeError("response body has already been used or locked");
  if (!head && !emptyStatus(status)) return value;
  const headers = new Headers(value.headers);
  if (emptyStatus(status)) {
    headers.delete("content-length");
    headers.delete("content-type");
    headers.delete("transfer-encoding");
  }
  if (value.body !== null) void value.body.cancel().catch(() => undefined);
  return new Response(null, { status, statusText: value.statusText, headers });
};
