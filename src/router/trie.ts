/**
 * Route pattern trie — the source of truth for dynamic matching.
 *
 * Static path segments index into `Map` children (O(1) per segment); dynamic
 * segments (`:id`, `:id(\\d+)`, `:id?`) and wildcards (`*`) live on dedicated
 * child slots. Matching is an iterative DFS with an explicit stack,
 * preferring static children over parameters over wildcards, so the common
 * case never backtracks and no recursion is involved.
 *
 * One position may hold SEVERAL param variants — same name, different custom
 * patterns (`/users/:id(\\d+)/a` next to `/users/:id/b`). The head slot keeps
 * the first-registered variant (hot path: one branch), `paramMore` keeps the
 * rest in registration order; a variant matches by (name, pattern source),
 * and identical variants share one node with sticky optionality.
 */

import type { CompiledSegment } from "./pattern.ts";
import { decodeSegment } from "./pattern.ts";

export interface RouteTarget {
  /** method (uppercase) or "ALL" -> compiled handler chain */
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
  /** First-registered param variant at this position. */
  param: ParamChild | null;
  /** Additional same-name variants (different custom patterns), in
   *  registration order. Null on the overwhelmingly common single-variant
   *  node — the match hot path only pays one null check for it. */
  paramMore: ParamChild[] | null;
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
  paramMore: null,
  wildcard: null,
  target: null,
});

export const createTarget = (): RouteTarget => ({ methods: new Map(), allowed: new Set() });

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

/** Push every param transition of `variant` (skip first, then consume). */
const pushVariant = (
  stack: Frame[],
  variant: ParamChild,
  index: number,
  segment: string,
  decoded: string,
  params: ParamLink | null,
): void => {
  if (variant.optional) {
    stack.push({ node: variant.node, index, params });
  }
  if (segment.length > 0 && (variant.pattern === null || variant.pattern.test(decoded))) {
    stack.push({
      node: variant.node,
      index: index + 1,
      params: { name: variant.name, value: decoded, next: params },
    });
  }
};

/**
 * Match a concrete request path against the trie.
 *
 * Parameter values accumulate in an immutable cons-list (one tiny allocation
 * per captured param), which makes backtracking trivially correct — no array
 * truncation, no holes.
 */
export const matchPattern = (root: TrieNode, path: string): TrieMatch | null => {
  const parts = splitSegments(path);
  const segments = parts;
  const stack: Frame[] = [{ node: root, index: 0, params: null }];

  while (stack.length > 0) {
    const frame = stack.pop() as Frame;
    const { node, index, params } = frame;

    if (index === segments.length) {
      if (node.target !== null) return { target: node.target, params: recordOf(params) };
      // Trailing optional params (`:x?`) may be skipped at the end of a path.
      // Push order = pop priority: later variants first, the head (first
      // registered) last so it pops first.
      const head = node.param;
      const more = node.paramMore;
      if (more !== null) {
        for (let i = more.length - 1; i >= 0; i--) {
          const variant = more[i] as ParamChild;
          if (variant.optional) stack.push({ node: variant.node, index, params });
        }
      }
      if (head !== null && head.optional) {
        stack.push({ node: head.node, index, params });
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

    // Push params before the static child (pushed last) so the static child
    // is tried first (LIFO). Among variants the first-registered (the head)
    // must POP first, so it is pushed LAST: later variants go first, in
    // reverse order so more[0] precedes more[1].
    const head = node.param;
    if (head !== null) {
      const decoded = decodeSegment(segment);
      const more = node.paramMore;
      if (more !== null) {
        for (let i = more.length - 1; i >= 0; i--) {
          pushVariant(stack, more[i] as ParamChild, index, segment, decoded, params);
        }
      }
      pushVariant(stack, head, index, segment, decoded, params);
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

/** Split an already-normalized path into segments (no trailing slash). */
export const splitSegments = (path: string): string[] => {
  const parts = normalizeInPlace(path).split("/");
  parts.shift(); // drop the leading "" before "/"
  if (parts.length === 1 && (parts[0] ?? "") === "") parts.length = 0;
  return parts;
};

const normalizeInPlace = (path: string): string =>
  path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;

/** Same matcher identity: both patterns absent, or identical sources. */
const samePattern = (a: RegExp | null, b: RegExp | null): boolean =>
  a === null || b === null ? a === b : a.source === b.source;

/** The existing variant for (name, pattern) at this position, if any. */
const variantFor = (node: TrieNode, pattern: RegExp | null): ParamChild | undefined => {
  const head = node.param;
  if (head !== null && samePattern(head.pattern, pattern)) return head;
  const more = node.paramMore;
  if (more === null) return undefined;
  for (const variant of more) {
    if (samePattern(variant.pattern, pattern)) return variant;
  }
  return undefined;
};

/**
 * Insert a compiled pattern, returning the terminal node.
 *
 * A DIFFERENT parameter name at a position already holding one still throws
 * (inconsistent naming is a bug to surface at setup); a different custom
 * pattern for the SAME name becomes an additional variant, each keeping its
 * own subtree reachable — an earlier `:id(\\d+)` must never swallow a later
 * plain `:id`.
 */
export const insertPattern = (root: TrieNode, segments: readonly CompiledSegment[]): TrieNode => {
  let node = root;
  for (const segment of segments) {
    if (segment.kind === "wildcard") {
      if (node.wildcard === null) {
        node.wildcard = {
          name: "wildcard",
          pattern: null,
          optional: false,
          node: createNode(),
        };
      }
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
        node = node.param.node;
        continue;
      }
      const head = node.param as ParamChild;
      if (head.name !== segment.value) {
        throw new TypeError(
          `Conflicting parameter names at the same position: ":${head.name}" vs ":${segment.value}"`,
        );
      }
      const existing = variantFor(node, segment.pattern);
      if (existing === undefined) {
        const created: ParamChild = {
          name: segment.value,
          pattern: segment.pattern,
          optional: segment.optional,
          node: createNode(),
        };
        (node.paramMore ??= []).push(created);
        node = created.node;
        continue;
      }
      // Registration order must not decide matchability: once optional,
      // always optional at this position.
      if (segment.optional) existing.optional = true;
      node = existing.node;
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
