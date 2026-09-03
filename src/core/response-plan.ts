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

export interface ResponseFacts {
  readonly directBody: DirectResponseBody;
  readonly implicitContentType?: string;
  native?: Response;
  readonly planned?: true;
}

const RESPONSE_FACTS = Symbol("keala.responseFacts");

type ResponseWithFacts = Response & { [RESPONSE_FACTS]?: ResponseFacts };

class PlannedResponse {
  readonly directBody: DirectResponseBody;
  readonly implicitContentType: string | undefined;
  declare native?: Response;

  get planned(): true {
    return true;
  }

  constructor(body: DirectResponseBody, init: ResponseInit = {}, implicitContentType?: string) {
    this.directBody = typeof body === "string" ? body : new Uint8Array(body);
    this.implicitContentType = implicitContentType;
    // Non-default init needs the native constructor's eager validation and
    // snapshot/coercion rules. The untouched default string path stays lazy.
    if (init.status !== undefined || init.statusText !== undefined || init.headers !== undefined) {
      this.#materialize(init);
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

  #materialize(init?: ResponseInit): Response {
    if (this.native !== undefined) return this.native;
    const headers = new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]);
    if (this.implicitContentType !== undefined && !headers.has("content-type")) {
      headers.set("content-type", this.implicitContentType);
    }
    const native = new Response(this.directBody, {
      ...init,
      headers,
    });
    return (this.native = native);
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
