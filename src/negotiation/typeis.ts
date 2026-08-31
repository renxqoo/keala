/**
 * Media type matching for `ctx.is()` — a compact, dependency-free port of the
 * `type-is` package semantics used by Koa.
 *
 * Returns:
 * - `false` when the content type does not match any of the given types
 * - `null` when there is no content type / body to match
 * - the matched type (normalized) otherwise
 */

import { expandShorthand, normalizeType } from "../utils/mime.ts";

export const typeIs = (
  contentType: string | null,
  types: readonly string[],
): string | null | false => {
  if (contentType == null || contentType.length === 0) return null;
  const incoming = normalizeType(contentType);
  if (incoming.length === 0) return null;

  if (types.length === 0) return incoming;
  for (const raw of types) {
    const shorthand = raw.trim().toLowerCase();
    if (shorthand.startsWith(".")) {
      // `.png` matches by file extension semantics.
      if (
        incoming.endsWith(`/${shorthand.slice(1)}`) ||
        incoming.endsWith(`+${shorthand.slice(1)}`)
      ) {
        return shorthand;
      }
      continue;
    }
    if (shorthand.startsWith("+")) {
      // `+json` — structured-syntax suffix: matches any `<type>/<subtype>+json`
      // (type-is expands it to `*/*+json`; the INCOMING type is the answer).
      if ((incoming.split("/")[1] ?? "").endsWith(shorthand)) return incoming;
      continue;
    }
    if (shorthand.startsWith("*/")) {
      // `*/png` matches any type whose subtype is png.
      const subtype = shorthand.slice(2);
      if (incoming.split("/")[1] === subtype) return shorthand;
      continue;
    }
    const type = expandShorthand(shorthand);
    if (type === "any" || type === "*") return incoming;
    if (type.endsWith("/*")) {
      const prefix = type.slice(0, -1); // keep trailing /
      if (incoming.startsWith(prefix)) return shorthand;
      continue;
    }
    if (type === incoming) return shorthand;
    if ((shorthand === "json" || type === "application/json") && isJsonSuffix(incoming)) {
      return shorthand;
    }
    if (
      (shorthand === "xml" || type === "application/xml") &&
      (incoming === "text/xml" || isXmlSuffix(incoming))
    ) {
      return shorthand;
    }
  }
  return false;
};

const isJsonSuffix = (incoming: string): boolean =>
  incoming.startsWith("application/") && incoming.endsWith("+json");

const isXmlSuffix = (incoming: string): boolean =>
  (incoming.startsWith("application/") || incoming.startsWith("text/")) &&
  incoming.endsWith("+xml");
