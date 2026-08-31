/**
 * `app.decorate()` — extend every context with a property or method.
 *
 * Setup-time only: writes land on the app's DERIVED context prototype (never
 * the shared base — one app's extensions must not leak into another's
 * contexts), with a loud collision guard instead of last-writer-wins.
 */

import { createContext, baseContextProto } from "./context.ts";
import type { Application } from "../app.ts";

/**
 * Create the decorate function bound to one app's context prototype.
 *
 * Shadowing a core context member or a previous decoration would silently
 * change behavior under the caller's feet — refuse it loudly (Fastify-style).
 * Instance slots are probed from a real context so the guard can never drift
 * from createContext's own shape.
 */
export const createDecorator = (contextProto: object) => {
  let contextSlots: Set<string> | null = null;
  return (key: string, value: unknown, app: Application): void => {
    if (typeof key !== "string" || key.length === 0) {
      throw new TypeError("app.decorate() requires a non-empty key");
    }
    contextSlots ??= new Set(
      Object.keys(createContext(app, contextProto, new Request("http://localhost/"), undefined)),
    );
    if (
      contextSlots.has(key) ||
      key in baseContextProto ||
      Object.prototype.hasOwnProperty.call(contextProto, key)
    ) {
      throw new TypeError(
        `app.decorate(): "${key}" is already defined on the context — pick a distinct key`,
      );
    }
    // A `{ get }` object installs a lazy accessor (plugins use this for
    // request-side facades); anything else is a plain value.
    if (
      typeof value === "object" &&
      value !== null &&
      typeof (value as { get?: unknown }).get === "function"
    ) {
      Object.defineProperty(contextProto, key, {
        get: (value as { get(): unknown }).get,
        configurable: true,
        enumerable: false,
      });
      return;
    }
    Object.defineProperty(contextProto, key, {
      value,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  };
};
