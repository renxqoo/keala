/**
 * HTTP error factory — functional replacement for the `http-errors` package
 * used by Koa (`ctx.throw`). Errors are plain objects created by a factory,
 * never classes.
 */

import type { HeaderMap } from "../types.ts";
import { isValidErrorStatus, statusMessage } from "./status.ts";

export interface HttpError extends Error {
  /** HTTP status code (400-599). */
  status: number;
  /** Whether the error message is safe to show to clients. */
  expose: boolean;
  /** Machine-readable identifier when the throw site provided one (DOGFOOD-R2 C4). */
  code?: string;
  /** Extra headers to attach to the error response. */
  headers?: HeaderMap;
}

const ERROR_NAMES: Readonly<Record<number, string>> = {
  400: "BadRequestError",
  401: "UnauthorizedError",
  402: "PaymentRequiredError",
  403: "ForbiddenError",
  404: "NotFoundError",
  405: "MethodNotAllowedError",
  406: "NotAcceptableError",
  407: "ProxyAuthenticationRequiredError",
  408: "RequestTimeoutError",
  409: "ConflictError",
  410: "GoneError",
  411: "LengthRequiredError",
  412: "PreconditionFailedError",
  413: "PayloadTooLargeError",
  414: "URITooLongError",
  415: "UnsupportedMediaTypeError",
  416: "RangeNotSatisfiableError",
  417: "ExpectationFailedError",
  418: "ImATeapotError",
  421: "MisdirectedRequestError",
  422: "UnprocessableEntityError",
  423: "LockedError",
  424: "FailedDependencyError",
  425: "TooEarlyError",
  426: "UpgradeRequiredError",
  428: "PreconditionRequiredError",
  429: "TooManyRequestsError",
  431: "RequestHeaderFieldsTooLargeError",
  451: "UnavailableForLegalReasonsError",
  500: "InternalServerError",
  501: "NotImplementedError",
  502: "BadGatewayError",
  503: "ServiceUnavailableError",
  504: "GatewayTimeoutError",
  505: "HTTPVersionNotSupportedError",
  506: "VariantAlsoNegotiatesError",
  507: "InsufficientStorageError",
  508: "LoopDetectedError",
  510: "NotExtendedError",
  511: "NetworkAuthenticationRequiredError",
};

export interface HttpErrorProps {
  message?: string;
  expose?: boolean;
  headers?: HeaderMap;
  /**
   * Machine-readable error identifier (e.g. "invalid_json", "payload_too_large")
   * — lets consumers branch on `error.code` instead of matching message text
   * (DOGFOOD-R2 C4). Free-form; keala's own throw sites use snake_case.
   */
  code?: string;
  [key: string]: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Create an `HttpError`.
 *
 * ```ts
 * throw createError(404, "user not found", { headers: { "x-reason": "gone" } })
 * ```
 */
export const createError = (
  status: unknown,
  messageOrError?: string | Error | HttpErrorProps,
  props?: HttpErrorProps,
): HttpError => {
  let resolvedStatus = typeof status === "number" && isValidErrorStatus(status) ? status : 500;
  let message: string | undefined;
  let source: Error | undefined;
  let extra: Record<string, unknown> | undefined;

  if (typeof messageOrError === "string") {
    message = messageOrError;
  } else if (messageOrError instanceof Error) {
    source = messageOrError;
    const sourceStatus = (messageOrError as Partial<HttpError>).status;
    const candidate = isValidStatusLike(sourceStatus) ? sourceStatus : undefined;
    if (candidate !== undefined) resolvedStatus = candidate;
    if (isRecord((messageOrError as HttpError).headers)) {
      extra = { headers: (messageOrError as HttpError).headers };
    }
  } else if (isRecord(messageOrError)) {
    extra = messageOrError;
  }
  if (isRecord(props)) {
    extra = { ...extra, ...props };
  }

  const finalMessage =
    (typeof extra?.["message"] === "string" ? (extra["message"] as string) : undefined) ??
    message ??
    source?.message ??
    // statusMessage returns "" (never nullish) for valid-but-unnamed statuses
    // — the http-errors fallback for those is the status digits themselves.
    (statusMessage(resolvedStatus) || String(resolvedStatus));

  const error = new Error(finalMessage) as HttpError;
  error.name = ERROR_NAMES[resolvedStatus] ?? "HttpError";
  error.status = resolvedStatus;
  error.expose =
    typeof extra?.["expose"] === "boolean" ? (extra["expose"] as boolean) : resolvedStatus < 500;
  if (source !== undefined) {
    error.cause = source;
  }
  for (const [key, value] of Object.entries(extra ?? {})) {
    // `status` and its legacy `statusCode` alias are reserved: letting props
    // set them independently would mint an internally inconsistent HttpError.
    if (key === "message" || key === "expose" || key === "status" || key === "statusCode") continue;
    (error as unknown as Record<string, unknown>)[key] = value;
  }
  return error;
};

/** 400-599 integer check shared by `.status` reads. */
const isValidStatusLike = (value: unknown): value is number =>
  typeof value === "number" && isValidErrorStatus(value);

export const isHttpError = (value: unknown): value is HttpError =>
  value instanceof Error &&
  typeof (value as Partial<HttpError>).status === "number" &&
  isValidErrorStatus((value as Partial<HttpError>).status as number);

/** Wrap non-Error throwables so downstream handling always sees an Error. */
export const normalizeError = (value: unknown): Error => {
  // Cross-realm Errors (vm contexts, structured clones) fail instanceof but
  // are Errors by the toString contract — treat them as the real thing.
  if (value instanceof Error) return value;
  if (Object.prototype.toString.call(value) === "[object Error]") return value as Error;
  // TOTAL function: BigInt and circular structures make JSON.stringify
  // throw — the error path must never fail while normalizing a throwable.
  let message: string;
  if (typeof value === "string") {
    message = value;
  } else {
    try {
      message = JSON.stringify(value) ?? String(value);
    } catch {
      message = String(value);
    }
  }
  return new Error(message, { cause: value });
};

/**
 * The error-funnel entry contract (R4.3): everything downstream — the error
 * mapper, the built-in response — sees an HttpError. Throwables without a
 * valid `.status` are classified IN PLACE as an unexposed 500: minting a
 * wrapper Error would capture a fresh stack at funnel depth (~µs per error)
 * just to restate what the funnel already knows. A real Error keeps its own
 * identity, name and stack; only non-Error throwables go through
 * normalizeError (whose single capture is unavoidable) and carry `cause`.
 */
export const toHttpError = (value: unknown): HttpError => {
  const error = normalizeError(value);
  if (isHttpError(error)) return error;
  try {
    const classified = error as HttpError;
    classified.status = 500;
    classified.expose = false;
    return classified;
  } catch {
    // Frozen/sealed error singletons (shared error constants are a real
    // pattern): classify WITHOUT mutating. Rare path — the wrapper's extra
    // stack capture is acceptable here; cause keeps the original reachable.
    const wrapped = createError(500, error.message);
    wrapped.cause = error;
    return wrapped;
  }
};
