/**
 * One request input contract for Fetch and native transports.
 *
 * A Fetch/Bun request is used directly (zero wrapper allocation). Native
 * adapters implement the symbol-marked shape and may defer Headers, Request
 * and body-stream construction until an API actually asks for them.
 */

export const NATIVE_REQUEST_SOURCE = Symbol("keala.nativeRequestSource");

export interface NativeRequestSource {
  readonly [NATIVE_REQUEST_SOURCE]: true;
  readonly method: string;
  /** Native request-target used by routing and Koa's relative `c.url`. */
  readonly url: string;
  /** Fully-qualified URL, built lazily when a standard Request/URL API needs it. */
  absoluteUrl(): string;
  header(name: string): string | null;
  headers(): Headers;
  request(): Request;
  body(): ReadableStream<Uint8Array> | null;
  bytes(limit?: number): Promise<Uint8Array>;
  /**
   * S4: the lazy client-disconnect channel. The adapter's disconnect
   * detection drives it; the controller materializes ONLY when a consumer
   * (the admission queue, `c.signal`) actually listens — a disconnect that
   * lands first is replayed on materialization.
   */
  clientAbort(): AbortController;
}

export type RequestSource = Request | NativeRequestSource;

export const isNativeRequestSource = (source: RequestSource): source is NativeRequestSource =>
  (source as NativeRequestSource)[NATIVE_REQUEST_SOURCE] === true;

export const sourceMethod = (source: RequestSource): string => source.method;

export const sourceUrl = (source: RequestSource): string => source.url;

export const sourceAbsoluteUrl = (source: RequestSource): string =>
  isNativeRequestSource(source) ? source.absoluteUrl() : source.url;

export const sourceHeader = (source: RequestSource, name: string): string | null =>
  isNativeRequestSource(source) ? source.header(name) : source.headers.get(name);

export const sourceHeaders = (source: RequestSource): Headers =>
  isNativeRequestSource(source) ? source.headers() : source.headers;

export const sourceRequest = (source: RequestSource): Request =>
  isNativeRequestSource(source) ? source.request() : source;

export const sourceBody = (source: RequestSource): ReadableStream<Uint8Array> | null =>
  isNativeRequestSource(source) ? source.body() : source.body;

export const sourceBytes = (source: RequestSource, limit?: number): Promise<Uint8Array> =>
  isNativeRequestSource(source)
    ? source.bytes(limit)
    : (source as Request & { bytes(): Promise<Uint8Array> }).bytes();

/**
 * The source's client-disconnect signal: a Fetch Request carries one
 * natively (Bun aborts it when the client walks away); a native source
 * materializes its lazy channel — callers only pay when they listen.
 */
export const sourceSignal = (source: RequestSource): AbortSignal =>
  isNativeRequestSource(source) ? source.clientAbort().signal : source.signal;
