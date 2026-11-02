/**
 * Runtime-neutral response construction facts.
 *
 * Fetch Response deliberately hides the original string/bytes once it turns
 * them into a body stream. Keala owns that value at construction time, so it
 * records it on the Response itself: Bun can keep returning the standard
 * object, while Node writes the same bytes directly without a WebStream
 * round-trip. Foreign/clone/disturbed Responses carry no usable direct body
 * and therefore enter the single streaming path.
 */

type DirectResponseBody = string | Uint8Array;

// Bun defers string MIME inference to its server; Node exposes it in Headers.
// Resolve this once, without adding a runtime branch to every response.
const STRING_CONTENT_TYPE = new Response("").headers.get("content-type") ?? undefined;

class PlannedResponse {
  readonly directBody: DirectResponseBody;
  readonly implicitContentType: string | undefined;
  declare native?: Response;
  declare headerSnapshot?: Headers;

  constructor(body: DirectResponseBody, init?: ResponseInit, implicitContentType?: string) {
    this.directBody = typeof body === "string" ? body : new Uint8Array(body);
    this.implicitContentType =
      implicitContentType ?? (typeof body === "string" ? STRING_CONTENT_TYPE : undefined);
    if (init === undefined) return;
    // Only exact primitive defaults avoid Response construction. All other
    // statuses/reasons retain the native constructor's validation/coercion.
    if (
      (init.status !== undefined && init.status !== 200) ||
      (init.statusText !== undefined && init.statusText !== "")
    ) {
      this.#materialize(init);
    } else if (init.headers !== undefined) {
      this.headerSnapshot = this.#headers(init.headers);
    }
  }

  get status(): number {
    return this.native?.status ?? 200;
  }

  get statusText(): string {
    return this.native?.statusText ?? "";
  }

  get redirected(): boolean {
    return false;
  }

  get type(): Response["type"] {
    return "default";
  }

  get url(): string {
    return "";
  }

  get ok(): boolean {
    return this.status >= 200 && this.status <= 299;
  }

  get headers(): Headers {
    return this.#materialize().headers;
  }

  get body(): ReadableStream<Uint8Array> | null {
    return this.#materialize().body;
  }

  get bodyUsed(): boolean {
    return this.native?.bodyUsed ?? false;
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    return this.#materialize().arrayBuffer();
  }

  blob(): Promise<Blob> {
    return this.#materialize().blob();
  }

  bytes(): Promise<Uint8Array> {
    return (this.#materialize() as Response & { bytes(): Promise<Uint8Array> }).bytes();
  }

  clone(): Response {
    return this.#materialize().clone() as Response;
  }

  formData(): Promise<FormData> {
    return this.#materialize().formData() as unknown as Promise<FormData>;
  }

  json(): Promise<unknown> {
    return this.#materialize().json();
  }

  text(): Promise<string> {
    return this.#materialize().text();
  }

  get [Symbol.toStringTag](): string {
    return "Response";
  }

  #headers(input?: ResponseInit["headers"]): Headers {
    const headers = new Headers(input as ConstructorParameters<typeof Headers>[0]);
    if (this.implicitContentType !== undefined && !headers.has("content-type")) {
      headers.set("content-type", this.implicitContentType);
    }
    return headers;
  }

  #materialize(init?: ResponseInit): Response {
    if (this.native !== undefined) return this.native;
    const native = new Response(this.directBody, {
      ...init,
      headers: this.headerSnapshot ?? this.#headers(init?.headers),
    });
    // The snapshot is never publicly observed. From this point, every API
    // and the writer use the native Response's live Headers exclusively.
    delete this.headerSnapshot;
    return (this.native = native);
  }
}

// Preserve `instanceof Response` without replacing the process-global class.
Object.setPrototypeOf(PlannedResponse.prototype, Response.prototype);

export const createPlannedResponse = (
  body: DirectResponseBody,
  init?: ResponseInit,
  implicitContentType?: string,
): Response => new PlannedResponse(body, init, implicitContentType) as unknown as Response;

export const responseFactsOf = (response: Response): PlannedResponse | undefined =>
  response instanceof PlannedResponse &&
  response.native?.bodyUsed !== true &&
  response.native?.body?.locked !== true
    ? response
    : undefined;
