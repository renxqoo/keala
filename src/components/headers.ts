/**
 * Header middleware: secureHeaders, requestId, timing.
 */

import type { RouteHandler } from "../router/router.ts";

export interface SecureHeadersOptions {
  /** HSTS max-age in seconds. Off by default — only meaningful behind TLS. */
  hsts?: number;
  /** Extra `Strict-Transport-Security` directives (includeSubDomains…). */
  hstsExtras?: string[];
  referrerPolicy?: string;
  permittedCrossDomainPolicies?: string;
}

/**
 * Safe response headers by default: nosniff, frame guard, referrer policy.
 * HSTS is opt-in (`hsts: 31536000`) because sending it over plain HTTP can
 * brick development environments.
 */
export const secureHeaders = (options: SecureHeadersOptions = {}): RouteHandler => {
  const hstsValue =
    options.hsts !== undefined
      ? `max-age=${Math.trunc(options.hsts)}${options.hstsExtras ? `; ${options.hstsExtras.join("; ")}` : ""}`
      : null;
  return async (c, next) => {
    await next();
    c.set("X-Content-Type-Options", "nosniff");
    c.set("X-Frame-Options", "DENY");
    c.set("Referrer-Policy", options.referrerPolicy ?? "no-referrer");
    if (options.permittedCrossDomainPolicies !== undefined) {
      c.set("X-Permitted-Cross-Domain-Policies", options.permittedCrossDomainPolicies);
    }
    if (hstsValue !== null) c.set("Strict-Transport-Security", hstsValue);
  };
};

const RANDOM_UUID =
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? (): string => crypto.randomUUID()
    : (): string =>
        `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-${Math.random()
          .toString(16)
          .slice(2)}`;

/**
 * Request correlation: honors an inbound id, generates otherwise, exposes it
 * on `c.state.requestId` and echoes it on the response.
 */
export const requestId = (): RouteHandler => {
  return async (c, next) => {
    const inbound = c.get("x-request-id");
    const id = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/.test(inbound) ? inbound : RANDOM_UUID();
    c.state.requestId = id;
    await next();
    c.set("X-Request-ID", id);
  };
};

/**
 * Server-Timing header with the total and optional named phases.
 */
export const timing = (): RouteHandler => {
  return async (c, next) => {
    const start = performance.now();
    const state = c.state as Record<string, unknown> & { timingMark?: (name: string) => void };
    state.timingMark = (name: string): void => {
      const current = c.resHeader("Server-Timing");
      const entry = `${name};dur=${(performance.now() - start).toFixed(1)}`;
      c.set("Server-Timing", current.length === 0 ? entry : `${current}, ${entry}`);
    };
    await next();
    const total = `total;dur=${(performance.now() - start).toFixed(1)}`;
    const current = c.resHeader("Server-Timing");
    c.set("Server-Timing", current.length === 0 ? total : `${total}, ${current}`);
  };
};

/** Structured request logging (`logger()` writes one line per request). */
export interface LoggerOptions {
  /** Override the sink (default console.log). */
  write?: (line: string) => void;
}

export const logger = (options: LoggerOptions = {}): RouteHandler => {
  const write = options.write ?? ((line: string): void => console.log(line));
  return async (c, next) => {
    const start = performance.now();
    await next();
    const id = (c.state as { requestId?: string }).requestId ?? "-";
    write(`${c.method} ${c.path} -> ${c.status} ${Math.round(performance.now() - start)}ms ${id}`);
  };
};
