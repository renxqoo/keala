/**
 * Header middleware: secureHeaders, requestId, timing.
 */

import type { RouteHandler } from "../router/router.ts";
import type { Context } from "../core/context/context.ts";
import { isHttpError } from "../http/errors.ts";

/**
 * A per-header switch: `undefined` keeps the safe default, a string replaces
 * the value, `false` turns that single header off.
 */
type OverridableHeader = string | false;

export interface SecureHeadersOptions {
  /**
   * Content-Security-Policy. `undefined` ships the safe default
   * `default-src 'self'`, a string passes through verbatim, `false` omits
   * the header. `{nonce}` in the policy is replaced per request when a
   * `nonce` callback is configured.
   */
  csp?: string | false;
  /** Content-Security-Policy-Report-Only — never set unless given a string. */
  cspReportOnly?: string | false;
  /**
   * Per-request nonce source. Called BEFORE downstream runs so handlers can
   * embed the value in the page they render; the value lands on
   * `c.state.cspNonce` and in every `{nonce}` slot of the policies.
   */
  nonce?: (c: Context) => string;
  /** Permissions-Policy allowlists (`{ camera: ["self"] }`); absent unless set. */
  permissionsPolicy?: Record<string, string[]> | false;
  /** Cross-Origin-Opener-Policy — `same-origin` unless overridden/disabled. */
  crossOriginOpenerPolicy?: OverridableHeader;
  /** Cross-Origin-Embedder-Policy — off by default (`require-corp` breaks embeds). */
  crossOriginEmbedderPolicy?: OverridableHeader;
  /** Cross-Origin-Resource-Policy — `same-origin` unless overridden/disabled. */
  crossOriginResourcePolicy?: OverridableHeader;
  /** X-Frame-Options — `DENY` unless overridden/disabled. */
  xFrameOptions?: OverridableHeader;
  /** X-Content-Type-Options — `nosniff` unless overridden/disabled. */
  xContentTypeOptions?: OverridableHeader;
  /** Referrer-Policy — `no-referrer` unless overridden/disabled. */
  referrerPolicy?: OverridableHeader;
  /** X-Permitted-Cross-Domain-Policies — off unless given a value. */
  permittedCrossDomainPolicies?: OverridableHeader;
  /** X-DNS-Prefetch-Control — `off` unless overridden/disabled. */
  xDnsPrefetchControl?: OverridableHeader;
  /** X-XSS-Protection — `0` (disable the legacy auditor) unless overridden. */
  xXssProtection?: OverridableHeader;
  /** HSTS max-age in seconds. Off by default — only meaningful behind TLS. */
  hsts?: number | false;
  /** Extra `Strict-Transport-Security` directives (includeSubDomains…). */
  hstsExtras?: string[];
}

/** Resolve one overridable header: default → string override → null (off). */
const resolveHeader = (
  value: OverridableHeader | undefined,
  fallback: string | null,
): string | null => (value === false ? null : value !== undefined ? value : fallback);

/**
 * camelCase directive names → kebab-case (`displayCapture` →
 * `display-capture`); already-kebab names pass through untouched.
 */
const camelToKebab = (directive: string): string =>
  directive.replace(/([a-z\d])([A-Z])/g, "$1-$2").toLowerCase();

/**
 * Build the Permissions-Policy value from per-directive allowlists, hono's
 * secure-headers semantics: `[]`/`["none"]` deny (`dir=()`), `["*"]` allows
 * everyone, `self`/`src` stay bare and everything else is quoted.
 */
const buildPermissionsPolicy = (policy: Record<string, string[]>): string =>
  Object.entries(policy)
    .map(([directive, allowlist]) => {
      const name = camelToKebab(directive);
      if (allowlist.length === 0) return `${name}=()`;
      if (allowlist.length === 1 && allowlist[0] === "*") return `${name}=*`;
      if (allowlist.length === 1 && allowlist[0] === "none") return `${name}=()`;
      const items = allowlist.map((item) =>
        item === "self" || item === "src" ? item : `"${item}"`,
      );
      return `${name}=(${items.join(" ")})`;
    })
    .join(", ");

/**
 * Safe response headers by default: CSP, nosniff, frame guard, referrer
 * policy, XSS-auditor disable, DNS-prefetch off, COOP/CORP — every header
 * individually switchable (`name: false`) or overridable (`name: "value"`).
 * HSTS is opt-in (`hsts: 31536000`) because sending it over plain HTTP can
 * brick development environments.
 *
 * Two contracts on the write path:
 *  - the writes run in a `finally`: a throwing downstream must still get the
 *    guards on its error response (koa-helmet parity);
 *  - every write is if-absent per NAME: a header the handler (or an inner
 *    middleware, or the handler's own returned Response) already set is the
 *    developer's explicit decision and is never stomped.
 */
export const secureHeaders = (options: SecureHeadersOptions = {}): RouteHandler => {
  const headers: Array<[string, string]> = [];
  const add = (name: string, value: string | null): void => {
    if (value !== null) headers.push([name, value]);
  };

  add("X-Content-Type-Options", resolveHeader(options.xContentTypeOptions, "nosniff"));
  add("X-Frame-Options", resolveHeader(options.xFrameOptions, "DENY"));
  add("Referrer-Policy", resolveHeader(options.referrerPolicy, "no-referrer"));
  add("X-DNS-Prefetch-Control", resolveHeader(options.xDnsPrefetchControl, "off"));
  add("X-XSS-Protection", resolveHeader(options.xXssProtection, "0"));
  add("Cross-Origin-Opener-Policy", resolveHeader(options.crossOriginOpenerPolicy, "same-origin"));
  // COEP is opt-in: `require-corp` breaks every page embedding cross-origin
  // resources, which is not a safe default for a general-purpose middleware.
  add("Cross-Origin-Embedder-Policy", resolveHeader(options.crossOriginEmbedderPolicy, null));
  add(
    "Cross-Origin-Resource-Policy",
    resolveHeader(options.crossOriginResourcePolicy, "same-origin"),
  );
  add(
    "X-Permitted-Cross-Domain-Policies",
    resolveHeader(options.permittedCrossDomainPolicies, null),
  );
  if (options.hsts !== false && options.hsts !== undefined) {
    add(
      "Strict-Transport-Security",
      `max-age=${Math.trunc(options.hsts)}${options.hstsExtras ? `; ${options.hstsExtras.join("; ")}` : ""}`,
    );
  }
  if (options.permissionsPolicy !== false && options.permissionsPolicy !== undefined) {
    add("Permissions-Policy", buildPermissionsPolicy(options.permissionsPolicy));
  }

  const csp = options.csp === false ? null : (options.csp ?? "default-src 'self'");
  const cspReportOnly = options.cspReportOnly === false ? null : (options.cspReportOnly ?? null);
  const nonce = options.nonce;

  return async (c, next) => {
    // The nonce is minted BEFORE next(): handlers embed it in the page they
    // render (`c.state.cspNonce`), so it must exist before they run — the
    // header write itself stays in the finally to cover error responses.
    let nonceValue: string | undefined;
    if (nonce !== undefined) {
      nonceValue = nonce(c);
      c.state.cspNonce = nonceValue;
    }
    const policy = (value: string): string =>
      nonceValue === undefined ? value : value.replaceAll("{nonce}", `'nonce-${nonceValue}'`);
    try {
      await next();
    } finally {
      if (csp !== null && !c.has("Content-Security-Policy")) {
        c.setHeader("Content-Security-Policy", policy(csp));
      }
      if (cspReportOnly !== null && !c.has("Content-Security-Policy-Report-Only")) {
        c.setHeader("Content-Security-Policy-Report-Only", policy(cspReportOnly));
      }
      for (const [name, value] of headers) {
        if (!c.has(name)) c.setHeader(name, value);
      }
    }
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
 * on `c.state.requestId` and echoes it on the response — on the error path
 * too (finally), so a failing request stays traceable.
 */
export const requestId = (): RouteHandler => {
  return async (c, next) => {
    const inbound = c.header("x-request-id");
    const id = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/.test(inbound) ? inbound : RANDOM_UUID();
    c.state.requestId = id;
    try {
      await next();
    } finally {
      c.setHeader("X-Request-ID", id);
    }
  };
};

/**
 * Server-Timing header with the total and optional named phases. The total
 * lands in a `finally` — a throwing downstream still gets its timing (the
 * same error-path contract as secureHeaders/requestId).
 */
export const timing = (): RouteHandler => {
  return async (c, next) => {
    const start = performance.now();
    const state = c.state as Record<string, unknown> & { timingMark?: (name: string) => void };
    state.timingMark = (name: string): void => {
      const current = c.resHeader("Server-Timing");
      const entry = `${name};dur=${(performance.now() - start).toFixed(1)}`;
      c.setHeader("Server-Timing", current.length === 0 ? entry : `${current}, ${entry}`);
    };
    try {
      await next();
    } finally {
      const total = `total;dur=${(performance.now() - start).toFixed(1)}`;
      const current = c.resHeader("Server-Timing");
      c.setHeader("Server-Timing", current.length === 0 ? total : `${total}, ${current}`);
    }
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
    // The one-line-per-request contract includes failures, like the finally
    // blocks of secureHeaders/requestId — a throwing downstream still logs.
    try {
      await next();
      const id = (c.state as { requestId?: string }).requestId ?? "-";
      write(
        `${c.method} ${c.path} -> ${c.status} ${Math.round(performance.now() - start)}ms ${id}`,
      );
    } catch (err) {
      const status = isHttpError(err) ? err.status : 500;
      const id = (c.state as { requestId?: string }).requestId ?? "-";
      write(`${c.method} ${c.path} -> ${status} ${Math.round(performance.now() - start)}ms ${id}`);
      throw err;
    }
  };
};
