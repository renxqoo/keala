/**
 * Route pattern trie.
 *
 * Static path segments index into `Map` children (O(1) per segment).
 * Dynamic segments (`:id`, `:id(\\d+)`, `:id?`) and wildcards (`*`) live on
 * dedicated child slots. Matching is an iterative DFS with an explicit stack,
 * preferring static children over parameters, so the common case never
 * backtracks and no recursion is involved.
 */

export interface RouteTarget {
  /** method (uppercase) or "ALL" -> compiled middleware chain */
  methods: Map<string, unknown>;
  /** methods registered on this path (for the `Allow` header) */
  allowed: Set<string>;
  /** route name for `router.url(name, params)` */
  name?: string;
}

export interface ParamChild {
  name: string;
  pattern: RegExp | null;
  optional: boolean;
  node: TrieNode;
}

export interface TrieNode {
  children: Map<string, TrieNode>;
  param: ParamChild | null;
  wildcard: ParamChild | null;
  target: RouteTarget | null;
}

export interface TrieMatch {
  target: RouteTarget;
  params: Record<string, string> | null;
}

export const createNode = (): TrieNode => ({
  children: new Map(),
  param: null,
  wildcard: null,
  target: null,
});

export const createTarget = (): RouteTarget => ({ methods: new Map(), allowed: new Set() });

export const normalizePath = (path: string): string =>
  path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;

const decodeSegment = (segment: string): string => {
  // decodeURIComponent costs ~30ns; escape-free segments are identity.
  if (segment.indexOf("%") === -1) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

export interface CompiledSegment {
  kind: "static" | "param" | "wildcard";
  value: string; // static text, param name or wildcard name
  pattern: RegExp | null;
  optional: boolean;
}

/**
 * Compile "/users/:id(\\d+)/files/*rest" into segments.
 * Throws on malformed patterns before anything is registered.
 */
export const compilePattern = (path: string): CompiledSegment[] => {
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
        pattern = new RegExp(`^(?:${source})$`);
        body = body.slice(0, open);
      }
      if (body.length === 0 || body.includes("?")) {
        throw new TypeError(`Empty or invalid parameter name: ${JSON.stringify(path)}`);
      }
      segments.push({ kind: "param", value: body, pattern, optional });
      continue;
    }
    segments.push({ kind: "static", value: decodeSegment(raw), pattern: null, optional: false });
  }
  return segments;
};

/** True when the pattern has no dynamic segments (eligible for the static Map). */
export const isStaticPattern = (segments: readonly CompiledSegment[]): boolean =>
  segments.every((segment) => segment.kind === "static");

/** Insert a compiled pattern, returning the terminal node. */
export const insertPattern = (root: TrieNode, segments: readonly CompiledSegment[]): TrieNode => {
  let node = root;
  for (const segment of segments) {
    if (segment.kind === "wildcard") {
      if (node.wildcard === null)
        node.wildcard = { name: "wildcard", pattern: null, optional: false, node: createNode() };
      node = node.wildcard.node;
      continue;
    }
    if (segment.kind === "param") {
      if (node.param === null) {
        node.param = {
          name: segment.value,
          pattern: segment.pattern,
          optional: segment.optional,
          node: createNode(),
        };
      } else {
        const existing = node.param;
        if (existing.name !== segment.value) {
          throw new TypeError(
            `Conflicting parameter names at the same position: ":${existing.name}" vs ":${segment.value}"`,
          );
        }
        if (existing.pattern === null && segment.pattern !== null) {
          existing.pattern = segment.pattern;
        }
        // Registration order must not decide matchability: once optional,
        // always optional at this position.
        if (segment.optional) existing.optional = true;
      }
      node = node.param.node;
      continue;
    }
    let child = node.children.get(segment.value);
    if (child === undefined) {
      child = createNode();
      node.children.set(segment.value, child);
    }
    node = child;
  }
  return node;
};

interface ParamLink {
  name: string;
  value: string;
  next: ParamLink | null;
}

interface Frame {
  node: TrieNode;
  index: number; // next segment to consume
  params: ParamLink | null; // immutable cons-list of params along the path
}

/**
 * Match a concrete request path against the trie.
 *
 * Parameter values accumulate in an immutable cons-list (one tiny allocation
 * per captured param, shared across the frame), which makes backtracking
 * trivially correct — no array truncation, no holes.
 */
export const matchPattern = (root: TrieNode, path: string): TrieMatch | null => {
  const parts = normalizePath(path).split("/").slice(1);
  if (parts.length === 1 && (parts[0] ?? "") === "") parts.length = 0;
  const segments = parts;
  const stack: Frame[] = [{ node: root, index: 0, params: null }];

  while (stack.length > 0) {
    const frame = stack.pop() as Frame;
    const { node, index, params } = frame;

    if (index === segments.length) {
      if (node.target !== null) return { target: node.target, params: recordOf(params) };
      // Trailing optional params (`:x?`) may be skipped at the end of a path.
      if (node.param !== null && node.param.optional) {
        stack.push({ node: node.param.node, index, params });
      }
      continue;
    }

    const segment = segments[index] ?? "";

    // Wildcards are the lowest-priority match: pushed first (popped last),
    // after every static and param alternative has been exhausted.
    if (node.wildcard !== null && node.wildcard.node.target !== null) {
      const rest = segments.slice(index).map(decodeSegment).join("/");
      stack.push({
        node: node.wildcard.node,
        index: segments.length,
        params: rest.length > 0 ? { name: node.wildcard.name, value: rest, next: params } : params,
      });
    }

    // Push param first so the static child (pushed last) is tried first (LIFO).
    if (node.param !== null) {
      const param = node.param;
      // Push order = priority (LIFO): skip first (pushed deepest), consume
      // after — consecutive optionals resolve left-to-right like
      // path-to-regexp.
      if (param.optional) {
        stack.push({ node: param.node, index, params });
      }
      const decoded = decodeSegment(segment);
      if (segment.length > 0 && (param.pattern === null || param.pattern.test(decoded))) {
        stack.push({
          node: param.node,
          index: index + 1,
          params: { name: param.name, value: decoded, next: params },
        });
      }
    }

    // Static children are keyed by the DECODED pattern segment (compile time
    // decodes); a request segment carrying escapes needs a decoded retry.
    // The plain lookup stays first and allocation-free for the common case.
    let child = node.children.get(segment);
    if (child === undefined && segment.indexOf("%") !== -1) {
      child = node.children.get(decodeSegment(segment));
    }
    if (child !== undefined) {
      stack.push({ node: child, index: index + 1, params });
    }
  }
  return null;
};

const recordOf = (link: ParamLink | null): Record<string, string> => {
  const params: Record<string, string> = Object.create(null);
  let current = link;
  while (current !== null) {
    params[current.name] = current.value;
    current = current.next;
  }
  return params;
};

/** Names of the dynamic parameters in a compiled pattern. */
export const paramNamesOf = (segments: readonly CompiledSegment[]): string[] =>
  segments.filter((s) => s.kind !== "static").map((s) => s.value);
