/**
 * URL building for named routes — `app.url()` / `router.url()` and the
 * redirect-destination validation that shares the pattern compiler.
 */

import { compilePattern, type CompiledSegment } from "./pattern.ts";
import type { RouterState } from "./router.ts";

/**
 * Percent-encode a path VALUE: encodeURIComponent, except "/" stays a real
 * separator (wildcard values span segments). Without this a value carrying
 * "?", "#" or a space stops addressing the same resource (`?` becomes a
 * query string — a silent round-trip break).
 */
const encodePathValue = (value: string): string =>
  value.split("/").map(encodeURIComponent).join("/");

export const buildURL = (
  segments: readonly CompiledSegment[],
  params: Record<string, string>,
): string => {
  const parts: string[] = [];
  for (const segment of segments) {
    if (segment.kind === "static") {
      // Compiled static segments are DECODED — re-encode for the wire. A "/"
      // INSIDE a static value came from an escaped `%2F` at registration
      // (its own router segment); keeping it a separator here would emit a
      // URL addressing a DIFFERENT resource, so statics encode "/" too.
      parts.push(encodeURIComponent(segment.value));
      continue;
    }
    const value = params[segment.value];
    if (value === undefined) {
      if (segment.optional) continue;
      throw new Error(`Missing required parameter "${segment.value}" for url()`);
    }
    // Only wildcard VALUES may span segments — for them "/" stays a real
    // separator; a "?" or "#" would silently change what the URL addresses.
    parts.push(segment.kind === "wildcard" ? encodePathValue(value) : encodeURIComponent(value));
  }
  if (parts.length === 0) return "/";
  const joined = parts.join("/");
  return joined.startsWith("/") ? joined : `/${joined}`;
};

/**
 * Pattern segments of a redirect destination, or null when the destination is
 * verbatim. Only a PATH may carry `:params`: absolute URLs
 * ("https://host:port/x") contain scheme/port colons that are NOT parameter
 * markers, and scheme-relative targets ("//host/x") are verbatim as well.
 */
export const redirectTargetSegments = (destination: string): readonly CompiledSegment[] | null => {
  if (!destination.startsWith("/") || destination.startsWith("//")) return null;
  return destination.includes(":") ? compilePattern(destination).segments : null;
};

/**
 * A redirect destination may only reference params the SOURCE route
 * GUARANTEES at request time — a missing required param would explode as a
 * per-request 500, violating the eager-validation contract. Optional source
 * params are NOT guarantees: they can be absent, exactly like an uncaptured
 * position. Checked at registration.
 */
export const assertRedirectCaptures = (source: string, dest: readonly CompiledSegment[]): void => {
  const available = new Set(
    compilePattern(source)
      .segments.filter((segment) => segment.kind !== "static" && !segment.optional)
      .map((segment) => segment.value),
  );
  for (const segment of dest) {
    if (segment.kind === "static" || segment.optional) continue;
    if (!available.has(segment.value)) {
      throw new TypeError(
        `redirect destination references ":${segment.value}", which ${JSON.stringify(source)} never captures (optionals may be absent at runtime)`,
      );
    }
  }
};

export const urlFor = (
  state: RouterState,
  name: string,
  params: Record<string, string>,
): string => {
  const def = state.named.get(name);
  if (def === undefined) {
    throw new Error(`No route registered under name: ${JSON.stringify(name)}`);
  }
  return buildURL(compilePattern(def.path).segments, params);
};

export const routePathOf = (state: RouterState, name: string): string | undefined =>
  state.named.get(name)?.path;
