/**
 * Request guards: bodyLimit and timeout.
 */

import { createError } from "../http/errors.ts";
import type { RouteHandler } from "../router/router.ts";

/**
 * Fast Content-Length pre-check: rejects oversized declared bodies before a
 * single byte is read (the bodyParser limits remain the streaming backstop).
 */
export const bodyLimit = (bytes: number): RouteHandler => {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new TypeError("bodyLimit() requires a non-negative byte count");
  }
  return async (c, next) => {
    const declared = c.reqLength;
    if (declared !== undefined && declared > bytes) {
      throw createError(413, `request body of ${declared} bytes exceeds the ${bytes} byte limit`, {
        expose: true,
      });
    }
    return next();
  };
};

/**
 * timeout — bound the downstream chain with a wall-clock deadline.
 *
 * On expiry the middleware rejects with an exposed 504; the still-running
 * downstream settles into the framework's floating-promise containment
 * (compose observes it, the process never crashes).
 */
export const timeout = (ms: number): RouteHandler => {
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new TypeError("timeout() requires a positive millisecond duration");
  }
  return async (_c, next) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(createError(504, `upstream timeout after ${ms}ms`, { expose: true }));
      }, ms);
    });
    try {
      return await Promise.race([next(), expired]);
    } finally {
      clearTimeout(timer);
    }
  };
};
