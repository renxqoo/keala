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
  params: Record<string, string> | ((name: string) => string | undefined),
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
    // The function form is `c.params` itself (U2): redirect destinations read
    // the live match product with zero Record rebuilding; `app.url()` keeps
    // the plain-object form. Object lookups go through hasOwn: a param named
    // like an Object.prototype member ("toString") must read as ABSENT on a
    // plain-object params, not resolve the inherited function.
    const value =
      typeof params === "function"
        ? params(segment.value)
        : Object.hasOwn(params, segment.value)
          ? params[segment.value]
          : undefined;
    // A param consumes a NON-EMPTY segment (the trie requires length > 0),
    // so "" for a plain param can never address the route — "/:x/y" with
    // x:"" would emit "/y", silently addressing a DIFFERENT route. Treat it
    // as missing: optionals skip, required params throw. Wildcard "" is the
    // documented bare-prefix form ("/w/" for {wildcard: ""}) and stays.
    if (value === undefined || (segment.kind === "param" && value === "")) {
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

/** A redirect destination that carries `:params`: the compiled PATH
 *  segments plus the query/fragment suffix, appended verbatim. */
export interface RedirectTarget {
  segments: readonly CompiledSegment[];
  suffix: string;
}

/**
 * Pattern segments of a redirect destination, or null when the destination
 * is verbatim. Only a PATH may carry `:params`: a segment STARTING with ":"
 * is a param marker, while a ":" anywhere else — inside a static segment,
 * the query string, or the fragment — is data. Absolute URLs
 * ("https://host:port/x") contain scheme/port colons that are NOT parameter
 * markers, and scheme-relative targets ("//host/x") are verbatim as well.
 * The query/fragment suffix travels verbatim: rebuilding it from the path
 * compiler would percent-encode "?", "=" and "#" into the Location,
 * silently redirecting to a different resource.
 */
export const redirectTargetSegments = (destination: string): RedirectTarget | null => {
  if (!destination.startsWith("/") || destination.startsWith("//")) return null;
  // Only a segment-final '?' is an optional-param marker. A following
  // query or fragment is URI data, including after a parameter segment.
  let cut = -1;
  let depth = 0;
  for (let i = 0; i < destination.length; i++) {
    const ch = destination[i];
    const segmentStart = destination.lastIndexOf("/", i) + 1;
    if (destination[segmentStart] === ":") {
      if (ch === "(") depth++;
      else if (ch === ")") depth = Math.max(0, depth - 1);
    }
    if (depth !== 0) continue;
    if (ch === "#") {
      cut = i;
      break;
    }
    if (ch !== "?") continue;
    const optional =
      destination[segmentStart] === ":" &&
      (i + 1 === destination.length ||
        destination[i + 1] === "/" ||
        destination[i + 1] === "?" ||
        destination[i + 1] === "#");
    if (!optional) {
      cut = i;
      break;
    }
  }
  const pathPart = cut === -1 ? destination : destination.slice(0, cut);
  if (!pathPart.split("/").some((segment) => segment.charCodeAt(0) === 58 /* ":" */)) {
    return null;
  }
  return {
    segments: compilePattern(pathPart).segments,
    suffix: cut === -1 ? "" : destination.slice(cut),
  };
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
