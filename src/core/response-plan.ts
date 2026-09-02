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

export type DirectResponseBody = string | Uint8Array;
export type ResponseHeadersInit = unknown;

export interface ResponseFacts {
  readonly directBody: DirectResponseBody;
  readonly implicitContentType?: string;
  readonly responseStatus?: number;
  readonly responseStatusText?: string;
  headersInit?: ResponseHeadersInit;
  headersResolved?: true;
  native?: Response;
  readonly planned?: true;
}

const RESPONSE_FACTS = Symbol("keala.responseFacts");

type ResponseWithFacts = Response & { [RESPONSE_FACTS]?: ResponseFacts };

class PlannedResponse {
  readonly directBody: DirectResponseBody;
  readonly responseStatus: number;
  readonly responseStatusText: string;
  readonly implicitContentType: string | undefined;
  headersInit: ResponseHeadersInit;
  declare headersResolved?: true;
  declare native?: Response;

  get planned(): true {
    return true;
  }

  constructor(body: DirectResponseBody, init: ResponseInit = {}, implicitContentType?: string) {
    this.directBody = body;
    this.responseStatus = init.status ?? 200;
    this.responseStatusText = init.statusText ?? "";
    this.implicitContentType = implicitContentType;
    this.headersInit = init.headers;
  }

  get status(): number {
    return this.responseStatus;
  }

  get statusText(): string {
    return this.responseStatusText;
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
    if (this.headersResolved === true) return this.headersInit as Headers;
    const headers = new Headers(this.headersInit as ConstructorParameters<typeof Headers>[0]);
    if (this.implicitContentType !== undefined && !headers.has("content-type")) {
      headers.set("content-type", this.implicitContentType);
    }
    this.headersInit = headers;
    this.headersResolved = true;
    return headers;
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
    if (this.bodyUsed) throw new TypeError("Body is unusable");
    return createPlannedResponse(
      this.directBody,
      {
        status: this.status,
        statusText: this.statusText,
        headers: this.headers,
      },
      this.implicitContentType,
    );
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

  #materialize(): Response {
    if (this.native !== undefined) return this.native;
    return (this.native = new Response(this.directBody, {
      status: this.status,
      statusText: this.statusText,
      headers: this.headers,
    }));
  }
}

// Preserve `instanceof Response` without replacing the process-global class.
Object.setPrototypeOf(PlannedResponse.prototype, Response.prototype);

export const createPlannedResponse = (
  body: DirectResponseBody,
  init: ResponseInit = {},
  implicitContentType?: string,
): Response => new PlannedResponse(body, init, implicitContentType) as unknown as Response;

export const responseFactsOf = (response: Response): ResponseFacts | undefined => {
  if (response instanceof PlannedResponse) {
    return response.native?.bodyUsed === true || response.native?.body?.locked === true
      ? undefined
      : response;
  }
  const facts = (response as ResponseWithFacts)[RESPONSE_FACTS];
  if (response.bodyUsed || response.body?.locked === true) return undefined;
  return facts;
};

/** Preserve construction facts only when a rebuild keeps the same body. */
export const inheritResponseFacts = (target: Response, source: Response): Response => {
  const facts = responseFactsOf(source);
  if (facts !== undefined) {
    // A rebuilt native Response owns its new header set. Only carry the
    // byte-exact body facts; carrying a planned response's original header
    // init would make the Node writer skip the rebuild's late mutations.
    (target as ResponseWithFacts)[RESPONSE_FACTS] = {
      directBody: facts.directBody,
      ...(facts.implicitContentType === undefined
        ? {}
        : { implicitContentType: facts.implicitContentType }),
    };
  }
  return target;
};
