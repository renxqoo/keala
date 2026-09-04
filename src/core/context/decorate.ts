/**
 * `app.decorate()` / `app.decorateLazy()` — extend every context with a
 * property, method, or lazy accessor.
 *
 * Setup-time only: writes land on the app's DERIVED context prototype (never
 * the shared base — one app's extensions must not leak into another's
 * contexts), with a loud collision guard instead of last-writer-wins.
 *
 * `decorate(key, value)` installs VALUE verbatim — there is deliberately NO
 * descriptor-shape sniffing: `{ get(key) {} }` is shape-identical to a
 * service object (any Map, any repository façade), and silently reinterpreting
 * one as the other corrupts the decoration. Lazy accessors opt in EXPLICITLY
 * via `decorateLazy(key, getter)`.
 *
 * Typing the members you install is declaration merging, not a runtime
 * concern: augment `ContextExtensions` (src/types.ts, re-exported from the
 * root entry) and `Context` picks the member up through its intersection —
 * see the EXT-1 pattern documented there.
 */

import { createContext, baseContextProto } from "./context.ts";
import type { Application } from "../app.ts";

export interface Decorators {
  decorate(key: string, value: unknown, app: Application): void;
  decorateLazy(key: string, getter: (this: never) => unknown, app: Application): void;
}

/** Create the decorate pair bound to one app's context prototype. */
export const createDecorators = (contextProto: object): Decorators => {
  // Instance slots, probed once from a real context so the guard can never
  // drift from createContext's own shape.
  let contextSlots: Set<string> | null = null;
  const guard = (key: string, app: Application, api: string): void => {
    if (typeof key !== "string" || key.length === 0) {
      throw new TypeError(`${api}() requires a non-empty key`);
    }
    contextSlots ??= new Set(
      Object.keys(createContext(app, contextProto, new Request("http://localhost/"), undefined)),
    );
    // Shadowing a core context member or a previous decoration would silently
    // change behavior under the caller's feet — refuse it loudly.
    if (
      contextSlots.has(key) ||
      key in baseContextProto ||
      Object.prototype.hasOwnProperty.call(contextProto, key)
    ) {
      throw new TypeError(
        `${api}(): "${key}" is already defined on the context — pick a distinct key`,
      );
    }
  };
  return {
    decorate(key, value, app) {
      guard(key, app, "app.decorate");
      Object.defineProperty(contextProto, key, {
        value,
        writable: true,
        configurable: true,
        enumerable: false,
      });
    },
    decorateLazy(key, getter, app) {
      guard(key, app, "app.decorateLazy");
      Object.defineProperty(contextProto, key, {
        get: getter as () => unknown,
        configurable: true,
        enumerable: false,
      });
    },
  };
};
