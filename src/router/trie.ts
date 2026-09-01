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
 * and identical variants share one node.
 *
 * Optionality lives on the EDGE, not the node: a `:x?` pattern gets a
 * dedicated `skipNode` subtree that only patterns DECLARING the position
 * optional ever populate. The skip transition can therefore never land in a
 * subtree registered by a sibling route whose `:x` is required — sharing a
 * variant node stays safe.
 */

import type { CompiledSegment } from "./pattern.ts";
import { decodeSegment } from "./pattern.ts";

export interface RouteTarget {
  /** method (uppercase) or "ALL" -> compiled handler chain */
  methods: Map<string, unknown>;
  /**
   * Raw handler layers per method, in registration order — the composition
   * SOURCE. A duplicate path+method registration appends LAYERS here and the
   * chain is recomposed once over `[...appMiddleware, ...layers]`; composing the
   * previous CHAIN under the new one (the old model) embedded the global
   * middleware once per duplicate and re-ran it every request.
   */
  layers: Map<string, unknown[]>;
  /** methods registered on this path (for the `Allow` header) */
  allowed: Set<string>;
  /** route name for `router.url(name, params)` */
  name?: string;
}

export interface ParamChild {
  name: string;
  pattern: RegExp | null;
  node: TrieNode;
  /** Subtree reachable by SKIPPING an optional param — populated only by
   * patterns that declare this position optional. Null when the position
   * was never declared optional. */
  skipNode: TrieNode | null;
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

export const createTarget = (): RouteTarget => ({
  methods: new Map(),
  layers: new Map(),
  allowed: new Set(),
});

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
  // The skip edge is only offered when THIS position was declared optional
  // by some pattern (skipNode exists) — and it leads exclusively into the
  // subtree those optional patterns registered (see insertPattern).
  if (variant.skipNode !== null) {
    stack.push({ node: variant.skipNode, index, params });
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
      // A trailing wildcard with an EMPTY capture answers the bare
      // prefix+"/" (buildURL emits exactly that for {wildcard: ""}) — and the
      // ROOT wildcard ("/*") answers "/" itself: express/hono semantics, and
      // the same round-trip contract as "/w/" below. Gated on the raw
      // trailing slash: "/w" itself is a different resource.
      const wild = node.wildcard;
      if (
        wild !== null &&
        wild.node.target !== null &&
        (path === "/" || (path.length > 1 && path.endsWith("/")))
      ) {
        stack.push({
          node: wild.node,
          index,
          params: { name: wild.name, value: "", next: params },
        });
      }
      // Trailing optional params (`:x?`) may be skipped at the end of a
      // path. Push order = pop priority: later variants first, the head
      // (first registered) last so it pops first.
      const head = node.param;
      const more = node.paramMore;
      if (more !== null) {
        for (let i = more.length - 1; i >= 0; i--) {
          const variant = more[i] as ParamChild;
          if (variant.skipNode !== null) stack.push({ node: variant.skipNode, index, params });
        }
      }
      if (head !== null && head.skipNode !== null) {
        stack.push({ node: head.skipNode, index, params });
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
    // decodes); the comparison therefore runs in the canonical key space —
    // a segment carrying escapes is decoded first, exactly like the
    // staticMap's canonical lookup, so a raw "a%2Fb" can never satisfy a
    // key whose decoded value is "a%2Fb" (that key means "a/b" escaped).
    let child: TrieNode | undefined;
    if (segment.indexOf("%") === -1) {
      child = node.children.get(segment);
    } else {
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
    // The cons-list is newest-first; first assignment wins, so the LATEST
    // capture of a repeated name is the one that survives (express and
    // @koa/router semantics, and what the fast matcher does too).
    if (!(current.name in params)) params[current.name] = current.value;
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
 * Insert a compiled pattern, returning EVERY terminal node it created. A
 * pattern with optional params has one terminal per skip/consume
 * combination — they all share the caller's single RouteTarget.
 *
 * A DIFFERENT parameter name at a position already holding one still throws
 * (inconsistent naming is a bug to surface at setup); a different custom
 * pattern for the SAME name becomes an additional variant, each keeping its
 * own subtree reachable — an earlier `:id(\\d+)` must never swallow a later
 * plain `:id`.
 */
export const insertPattern = (root: TrieNode, segments: readonly CompiledSegment[]): TrieNode[] => {
  const insert = (node: TrieNode, i: number): TrieNode[] => {
    if (i === segments.length) return [node];
    const segment = segments[i] as CompiledSegment;
    if (segment.kind === "wildcard") {
      if (node.wildcard === null) {
        node.wildcard = {
          name: "wildcard",
          pattern: null,
          node: createNode(),
          skipNode: null,
        };
      }
      return insert(node.wildcard.node, i + 1);
    }
    if (segment.kind === "param") {
      if (node.param === null) {
        node.param = {
          name: segment.value,
          pattern: segment.pattern,
          node: createNode(),
          skipNode: null,
        };
      } else {
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
            node: createNode(),
            skipNode: null,
          };
          (node.paramMore ??= []).push(created);
        }
      }
      const variant = variantFor(node, segment.pattern);
      if (variant === undefined) throw new TypeError("unreachable param variant");
      const consumed = insert(variant.node, i + 1);
      if (!segment.optional) return consumed;
      // The remainder is reachable WITHOUT consuming this param — but only
      // through the dedicated skip subtree, so required-param siblings can
      // never be served with the param missing.
      const skip = (variant.skipNode ??= createNode());
      return [...consumed, ...insert(skip, i + 1)];
    }
    let child = node.children.get(segment.value);
    if (child === undefined) {
      child = createNode();
      node.children.set(segment.value, child);
    }
    return insert(child, i + 1);
  };
  return insert(root, 0);
};
