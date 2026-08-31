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
  /** Alias of `status` kept for ecosystem compatibility. */
  statusCode: number;
  /** Whether the error message is safe to show to clients. */
  expose: boolean;
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
    const sourceStatusCode = (messageOrError as Partial<HttpError>).statusCode;
    const candidate = isValidStatusLike(sourceStatus)
      ? sourceStatus
      : isValidStatusLike(sourceStatusCode)
        ? sourceStatusCode
        : undefined;
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
  error.statusCode = resolvedStatus;
  error.expose =
    typeof extra?.["expose"] === "boolean" ? (extra["expose"] as boolean) : resolvedStatus < 500;
  if (source !== undefined) {
    error.cause = source;
  }
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (key === "message" || key === "expose" || key === "status") continue;
    (error as unknown as Record<string, unknown>)[key] = value;
  }
  return error;
};

/** 400-599 integer check shared by `.status` and `.statusCode` reads. */
const isValidStatusLike = (value: unknown): value is number =>
  typeof value === "number" && isValidErrorStatus(value);

export const isHttpError = (value: unknown): value is HttpError =>
  value instanceof Error &&
  typeof (value as Partial<HttpError>).status === "number" &&
  isValidErrorStatus((value as Partial<HttpError>).status as number);

/** Wrap non-Error throwables so downstream handling always sees an Error. */
export const normalizeError = (value: unknown): Error => {
  if (value instanceof Error) return value;
  const message = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  return new Error(message, { cause: value });
};
