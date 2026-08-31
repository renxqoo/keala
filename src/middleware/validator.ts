/**
 * validator — Standard Schema middleware (zod 4 / valibot / typebox …).
 *
 * `app.post("/users", validator(schema), handler)` reads and validates the
 * JSON body; failures short-circuit with an exposed 400 listing the issues.
 * The parsed value lands on `c.valid` (a decorated getter), typed `unknown`
 * at the framework level — cast or narrow in the handler.
 */

import { createError } from "../http/errors.ts";
import { readBodyLimited } from "../plugins/body-parser.ts";
import type { RouteHandler } from "../router/router.ts";
import type { Application } from "../core/app.ts";
import type { Context } from "../core/context/context.ts";

/** The Standard Schema v1 interface every modern validator exposes. */
export interface StandardSchema {
  readonly "~standard": {
    readonly version: 1;
    validate(
      value: unknown,
    ):
      | { readonly value?: unknown }
      | { readonly issues: unknown[] }
      | Promise<{ readonly value?: unknown } | { readonly issues: unknown[] }>;
  };
}

const isStandardSchema = (value: unknown): value is StandardSchema => {
  const holder = (value as { "~standard"?: { validate?: unknown } })["~standard"];
  return typeof holder === "object" && holder !== null && typeof holder.validate === "function";
};

const decoder = new TextDecoder();
const KIB = 1024;

/**
 * One c.valid installation per app, shared by EVERY validator() instance —
 * apps routinely validate several routes with several schemas, and a
 * per-instance registry would re-decorate and explode against
 * app.decorate()'s already-defined guard at request time (500s).
 */
const VALIDATOR_APPS = new WeakSet<Application>();
const issueLines = (issues: unknown[]): string => {
  const parts: string[] = [];
  for (const issue of issues.slice(0, 10)) {
    const message = (issue as { message?: unknown }).message;
    const path = (issue as { path?: unknown[] }).path;
    const at = Array.isArray(path) && path.length > 0 ? ` at ${path.join(".")}` : "";
    parts.push(`${typeof message === "string" ? message : "invalid value"}${at}`);
  }
  return parts.join("; ");
};

/** Context extended with the installed `c.valid` getter. */
export type ContextWithValid<T = unknown> = Context & { valid: T };

/**
 * Create the validation middleware. Installs the `c.valid` getter on first
 * use so handlers can read the parsed value without importing anything.
 */
export const validator = (schema: StandardSchema): RouteHandler => {
  if (!isStandardSchema(schema)) {
    throw new TypeError("validator() requires a Standard Schema (zod 4, valibot, typebox…)");
  }
  const ensureGetter = (c: Context): void => {
    const app = c.app;
    if (VALIDATOR_APPS.has(app)) return;
    VALIDATOR_APPS.add(app);
    app.decorate("valid", {
      get(this: Context): unknown {
        return (this as { validValue?: unknown }).validValue;
      },
    });
  };

  return async (c, next) => {
    ensureGetter(c);
    // Align with the app's bodyParser limit when installed; default 1MB.
    const limit = (c as { bodyJsonLimit?: number }).bodyJsonLimit ?? KIB * KIB;
    const bytes = await readBodyLimited(c, limit);
    let parsed: unknown;
    if (bytes.byteLength === 0) {
      parsed = null;
    } else {
      try {
        parsed = JSON.parse(decoder.decode(bytes));
      } catch {
        c.throw(400, "request body is not valid JSON");
      }
    }
    // The spec allows validate() to return a Promise (async refinements) —
    // await it, or a rejected payload would sail through unvalidated.
    const result = await schema["~standard"].validate(parsed);
    if ("issues" in result) {
      const lines = issueLines(result.issues as unknown[]);
      throw createError(400, lines.length > 0 ? lines : "validation failed", { expose: true });
    }
    (c as { validValue?: unknown }).validValue = "value" in result ? result.value : parsed;
    return next();
  };
};
