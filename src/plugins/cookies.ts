/**
 * cookies — the cookie facade plugin.
 *
 * `app.use(createCookies({ keys }))` installs the lazy `c.cookies` facade
 * (get/set with RFC 6265 serialization, HMAC-SHA256 signing and key
 * rotation when `keys` is provided). Installing is registration-time work
 * (the plugin protocol, same as `createBodyParser`): no per-request layer,
 * no ordering constraints — the facade materializes on first touch and
 * never costs requests that don't touch cookies.
 *
 * The type arrives with the import: this module declaration-merges
 * `cookies` into `ContextExtensions`, so `c.cookies.set(...)` type-checks
 * the moment `createCookies` is in scope — no manual `declare module`.
 *
 * Uninstalled apps carry none of this: the facade (and the signing code,
 * and the lazy crypto bridge behind it) shakes out of the closure entirely.
 */

import type { Context } from "../core/context/context.ts";
import type { Application } from "../core/app.ts";
import type { Plugin } from "../types.ts";
import type { HeaderMap } from "../types.ts";
import { createCookiesFacade, type CookiesFacade, type SigningKeys } from "../context/cookies.ts";
import { sourceHeader } from "../core/request-source.ts";

declare module "../types.ts" {
  interface ContextExtensions {
    /** Installed by `app.use(createCookies(...))` — the lazy cookie facade. */
    readonly cookies: CookiesFacade;
  }
}

export interface CookiesPluginOptions {
  /** Signing keys; the FIRST key signs, every key verifies (rotation). */
  keys?: SigningKeys;
}

export const createCookies = (options: CookiesPluginOptions = {}): Plugin => ({
  name: "cookies",
  install(app: Application): void {
    const keys = options.keys;
    app.decorateLazy("cookies", function (this: Context) {
      const c = this as Context & { cookiesValue: unknown; headersRecord: HeaderMap | null };
      // Same memo slot the old core getter used: first touch parses the
      // request header once, later touches reuse the facade.
      return (c.cookiesValue ??= createCookiesFacade({
        get cookieHeader(): string | null {
          return sourceHeader(c.rawRequest, "cookie");
        },
        // Koa's "get secure from request": an unset `secure` follows the
        // request's TLS state (incl. proxy-trusted x-forwarded-proto).
        get requestSecure(): boolean {
          return c.secure;
        },
        keys,
        // Set-Cookie lands in the staged record: it rides whichever Response
        // the chain returns, merges onto error pages, and survives the sugar
        // consume paths — the same wiring the core getter had.
        responseHeaders: (c.headersRecord ??= Object.create(null) as HeaderMap),
      })) as CookiesFacade;
    });
  },
});
