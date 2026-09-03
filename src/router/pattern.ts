/**
 * Route pattern compilation.
 *
 * A pattern is compiled ONCE at registration into a segment IR used by both
 * the trie (source of truth for dynamic matching) and the fast single-pattern
 * matchers. Malformed patterns throw before anything is registered.
 */

export interface CompiledSegment {
  kind: "static" | "param" | "wildcard";
  /** Static text, param name or wildcard name. */
  value: string;
  pattern: RegExp | null;
  optional: boolean;
}

export interface PatternIR {
  segments: readonly CompiledSegment[];
  /** True when no dynamic segments exist (eligible for the static Map). */
  isStatic: boolean;
  /** Pattern with only plain, non-optional params after a static head. */
  isSimple: boolean;
}

export const normalizePath = (path: string): string =>
  path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;

/** Decode one path segment; escape-free segments are identity (~30ns saved). */
export const decodeSegment = (segment: string): string => {
  if (segment.indexOf("%") === -1) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    // Malformed escapes pass through verbatim — never a 500 (security
    // contract #5; locked by test/security.test.ts).
    return segment;
  }
};

/**
 * Compile "/users/:id(\\d+)/files/*rest" into segments.
 * Throws on malformed patterns before anything is registered.
 */
export const compilePattern = (path: string): PatternIR => {
  if (path.length === 0 || path.charCodeAt(0) !== 47 /* "/" */) {
    throw new TypeError(`Route path must start with "/": ${JSON.stringify(path)}`);
  }
  const segments: CompiledSegment[] = [];
  const parts = normalizePath(path).split("/").slice(1);
  if (parts.length === 1 && (parts[0] ?? "") === "") parts.length = 0;
  for (let index = 0; index < parts.length; index++) {
    const raw = parts[index] ?? "";
    if (raw.length === 0) {
      throw new TypeError(`Route path has an empty segment: ${JSON.stringify(path)}`);
    }
    if (raw === "*") {
      segments.push({ kind: "wildcard", value: "wildcard", pattern: null, optional: false });
      if (index !== parts.length - 1) {
        throw new TypeError(`Wildcard must be the last segment: ${JSON.stringify(path)}`);
      }
      continue;
    }
    if (raw.charCodeAt(0) === 58 /* ":" */) {
      let body = raw.slice(1);
      let optional = false;
      // The trailing ? binds before the custom pattern: `:id(\d+)?`.
      if (body.endsWith("?")) {
        optional = true;
        body = body.slice(0, -1);
      }
      let pattern: RegExp | null = null;
      const open = body.indexOf("(");
      if (open !== -1) {
        const close = body.lastIndexOf(")");
        if (close === -1 || close < open) {
          throw new TypeError(`Unbalanced custom pattern: ${JSON.stringify(path)}`);
        }
        const source = body.slice(open + 1, close);
        // Text after the closing paren is not representable — registering the
        // truncated pattern would silently match MORE than written.
        if (body.slice(close + 1).length > 0) {
          throw new TypeError(`Unexpected text after the custom pattern: ${JSON.stringify(path)}`);
        }
        pattern = new RegExp(`^(?:${source})$`);
        body = body.slice(0, open);
      }
      if (body.length === 0 || body.includes("?")) {
        throw new TypeError(`Empty or invalid parameter name: ${JSON.stringify(path)}`);
      }
      segments.push({ kind: "param", value: body, pattern, optional });
      continue;
    }
    // A `*` inside a would-be STATIC segment ("**", "/assets*") is not a
    // wildcard here — it would silently register as a literal and match
    // nothing. Fail the registration instead of letting the route dead-end.
    // (Custom param patterns may legitimately contain `*`.)
    if (raw.includes("*")) {
      throw new TypeError(`Wildcard "*" must be its own final segment: ${JSON.stringify(path)}`);
    }
    segments.push({ kind: "static", value: decodeSegment(raw), pattern: null, optional: false });
  }
  let dynamic = 0;
  let simple = true;
  let sawDynamic = false;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i] as CompiledSegment;
    if (segment.kind === "static") {
      // A static segment AFTER a dynamic one breaks the fast-matcher shape
      // (the matcher assumes only params follow the static head).
      if (sawDynamic) simple = false;
      continue;
    }
    dynamic++;
    sawDynamic = true;
    if (segment.kind === "wildcard" || segment.optional || segment.pattern !== null || i === 0) {
      simple = false;
    }
  }
  return { segments, isStatic: dynamic === 0, isSimple: dynamic > 0 && simple };
};

/** Names of the dynamic parameters in a compiled pattern. */
export const paramNamesOf = (segments: readonly CompiledSegment[]): string[] =>
  segments.filter((s) => s.kind !== "static").map((s) => s.value);

/**
 * Pattern-aware overlap: two patterns overlap when some request URL can
 * match both — a dynamic segment (`:param`) on EITHER side can consume what
 * the other spells literally (a sunk `/users/:id` shadows a JS
 * `/users/admin` in the native table). Conservative by construction:
 * static segments must be equal, any dynamic segment is compatible with
 * everything, wildcards swallow the rest (zero-or-more — the bare-prefix
 * twin rule), and optional params fork into present/absent shapes. Sunk-path
 * guards use this ALONGSIDE pathsConflict, never instead of it:
 * compilePattern decodes `%2F` without splitting the segment, while the
 * canonical keyspace splits it — the union covers both vocabularies.
 */
export const patternsOverlap = (a: string, b: string): boolean => {
  let aIR: PatternIR;
  let bIR: PatternIR;
  try {
    aIR = compilePattern(a);
    bIR = compilePattern(b);
  } catch {
    // An unparseable path cannot be compared — report overlap so callers
    // refuse loudly instead of guessing.
    return true;
  }
  return overlapSegments(aIR.segments, bIR.segments);
};

const overlapSegments = (a: readonly CompiledSegment[], b: readonly CompiledSegment[]): boolean => {
  if (a.length === 0 && b.length === 0) return true;
  // One side exhausted: the other can still collapse to nothing through a
  // LEADING optional segment (`:id?` may be absent) or a wildcard (which
  // matches zero-or-more — the bare-prefix twin rule).
  if (a.length === 0) {
    const head = b[0] as CompiledSegment;
    return (head.optional || head.kind === "wildcard") && overlapSegments(a, b.slice(1));
  }
  if (b.length === 0) {
    const head = a[0] as CompiledSegment;
    return (head.optional || head.kind === "wildcard") && overlapSegments(a.slice(1), b);
  }
  const x = a[0] as CompiledSegment;
  const y = b[0] as CompiledSegment;
  // A wildcard swallows whatever remains on the other side (zero-or-more —
  // the bare-prefix twin rule), so reaching it with compatible history is
  // already an overlap.
  if (x.kind === "wildcard" || y.kind === "wildcard") return true;
  const compatible = x.kind === "param" || y.kind === "param" || x.value === y.value;
  if (!compatible) return false;
  if (overlapSegments(a.slice(1), b.slice(1))) return true;
  // Optional params may be absent: skip this position on the side that owns
  // one and keep comparing.
  if (x.optional && overlapSegments(a.slice(1), b)) return true;
  if (y.optional && overlapSegments(a, b.slice(1))) return true;
  return false;
};
