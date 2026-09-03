/**
 * Application middleware registration and path-scope planning.
 *
 * Route chains ask this module for their applicable layers at SETUP time.
 * Only ambiguous dynamic routes receive a tiny conditional wrapper; the
 * ordinary static-prefix case compiles to the middleware function itself.
 * Fallback (404/405/OPTIONS) chains are also precomposed by scope, so request
 * time only selects a chain and never composes or caches attacker paths.
 */

import { compose, type Composed, type Handler } from "./compose.ts";
import type { Application } from "./application.ts";
import type { Context } from "./context/context.ts";
import { compilePattern, decodeSegment, type CompiledSegment } from "../router/pattern.ts";

export type MiddlewareHandler = Handler<Context>;
export type MiddlewareChain = Composed<Context>;

export interface MiddlewareScope {
  readonly pattern: string;
  readonly segments: readonly string[];
  readonly prefix: boolean;
}

interface MiddlewareLayer {
  readonly scope: MiddlewareScope | null;
  readonly handler: MiddlewareHandler;
}

interface FallbackNode {
  readonly children: Map<string, FallbackNode>;
  exactChain: MiddlewareChain | null;
  prefixChain: MiddlewareChain | null;
}

export interface MiddlewareStack {
  readonly layers: MiddlewareLayer[];
  readonly global: MiddlewareHandler[];
  globalChain: MiddlewareChain | null;
  fallbackRoot: FallbackNode;
}

const createFallbackNode = (): FallbackNode => ({
  children: new Map(),
  exactChain: null,
  prefixChain: null,
});

export const createMiddlewareStack = (): MiddlewareStack => ({
  layers: [],
  global: [],
  globalChain: null,
  fallbackRoot: createFallbackNode(),
});

/** Read-only empty plan for low-level router callers that register directly. */
export const EMPTY_MIDDLEWARE_STACK: MiddlewareStack = createMiddlewareStack();

const keyOf = (segments: readonly string[]): string =>
  segments.map((segment) => `${segment.length}:${segment}`).join("");

const startsWithSegments = (prefix: readonly string[], full: readonly string[]): boolean =>
  prefix.length <= full.length && prefix.every((segment, index) => segment === full[index]);

const scopeMatchesSegments = (scope: MiddlewareScope, segments: readonly string[]): boolean =>
  scope.prefix
    ? startsWithSegments(scope.segments, segments)
    : scope.segments.length === segments.length && startsWithSegments(scope.segments, segments);

const pathSegments = (path: string): string[] => {
  const normalized = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  const parts = normalized.split("/");
  parts.shift();
  if (parts.length === 1 && parts[0] === "") return [];
  return parts.map(decodeSegment);
};

interface ConditionalMeta {
  readonly scope: MiddlewareScope;
  readonly handler: MiddlewareHandler;
  readonly pathOffset: number;
}

const conditionalMeta = new WeakMap<MiddlewareHandler, ConditionalMeta>();

/**
 * Transparency declaration for sinking: the author attests this layer
 * performs no observable action (and always calls next()) for the declared
 * request class, so a natively-sunk route may bypass it on the Bun table.
 * Proof obligation — the framework cannot verify it; a lying declaration
 * diverges the native leg only (the JS mirror keeps running the layer),
 * where the sink parity suite can observe it.
 */
export interface NoOpDeclaration {
  /** No observable action for requests with these (case-insensitive) methods. */
  readonly methods?: readonly string[];
  /** No observable action for bodyless requests — excuses GET/HEAD sinks. */
  readonly bodyless?: boolean;
}

const noOpMeta = new WeakMap<
  MiddlewareHandler,
  { methods?: ReadonlySet<string>; bodyless?: true }
>();

/** The methods keala treats as bodyless by contract (sink decisions are static). */
const BODYLESS_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

export const noOpFor = <T extends MiddlewareHandler>(fn: T, declaration: NoOpDeclaration): T => {
  const methods =
    declaration.methods === undefined
      ? undefined
      : new Set(
          declaration.methods.map((method) => {
            if (typeof method !== "string" || method.length === 0) {
              throw new TypeError("noOpFor methods must be non-empty strings");
            }
            return method.toUpperCase();
          }),
        );
  if (methods !== undefined && methods.size === 0) {
    throw new TypeError("noOpFor declaration needs methods, bodyless, or both");
  }
  if (methods === undefined && declaration.bodyless !== true) {
    throw new TypeError("noOpFor declaration needs methods, bodyless, or both");
  }
  noOpMeta.set(fn, {
    ...(methods === undefined ? {} : { methods }),
    ...(declaration.bodyless === true ? { bodyless: true } : {}),
  });
  return fn;
};

/** Does this layer's declaration excuse it for a sink serving `methods`? */
export const noOpExcuses = (handler: MiddlewareHandler, methods: ReadonlySet<string>): boolean => {
  const declaration = noOpMeta.get(handler);
  if (declaration === undefined) return false;
  if (declaration.bodyless) {
    let allBodyless = true;
    for (const method of methods) {
      if (!BODYLESS_METHODS.has(method)) {
        allBodyless = false;
        break;
      }
    }
    if (allBodyless) return true;
  }
  if (declaration.methods === undefined) return false;
  for (const method of methods) {
    if (!declaration.methods.has(method)) return false;
  }
  return true;
};

export const compileMiddlewareScope = (pattern: string): MiddlewareScope => {
  const ir = compilePattern(pattern);
  let prefix = false;
  const segments: string[] = [];
  for (let index = 0; index < ir.segments.length; index++) {
    const segment = ir.segments[index] as CompiledSegment;
    if (segment.kind === "static") {
      segments.push(segment.value);
      continue;
    }
    if (segment.kind === "wildcard" && index === ir.segments.length - 1) {
      prefix = true;
      continue;
    }
    throw new TypeError(
      `app.use() scope must be a static path or end in /*: ${JSON.stringify(pattern)}`,
    );
  }
  return Object.freeze({ pattern, segments: Object.freeze(segments), prefix });
};

const chainOf = (handlers: readonly MiddlewareHandler[]): MiddlewareChain | null =>
  handlers.length === 0 ? null : (compose(handlers) as MiddlewareChain);

const handlersForSegments = (
  stack: MiddlewareStack,
  segments: readonly string[],
  includeExact: boolean,
): MiddlewareHandler[] => {
  const handlers: MiddlewareHandler[] = [];
  for (const layer of stack.layers) {
    const scope = layer.scope;
    if (
      scope === null ||
      (scope.prefix
        ? startsWithSegments(scope.segments, segments)
        : includeExact && scopeMatchesSegments(scope, segments))
    ) {
      handlers.push(layer.handler);
    }
  }
  return handlers;
};

/** Rebuild the finite set of fallback chains after setup-time registration. */
const rebuildFallbacks = (stack: MiddlewareStack): void => {
  const exactScopes = new Map<string, readonly string[]>();
  const prefixScopes = new Map<string, readonly string[]>();
  for (const layer of stack.layers) {
    const scope = layer.scope;
    if (scope === null) continue;
    const key = keyOf(scope.segments);
    (scope.prefix ? prefixScopes : exactScopes).set(key, scope.segments);
  }

  const fallbackRoot = createFallbackNode();
  const nodeFor = (segments: readonly string[]): FallbackNode => {
    let node = fallbackRoot;
    for (const segment of segments) {
      let child = node.children.get(segment);
      if (child === undefined) {
        child = createFallbackNode();
        node.children.set(segment, child);
      }
      node = child;
    }
    return node;
  };
  for (const segments of exactScopes.values()) {
    const chain = chainOf(handlersForSegments(stack, segments, true));
    if (chain !== null) nodeFor(segments).exactChain = chain;
  }

  for (const segments of prefixScopes.values()) {
    // Exact scopes apply only to their one concrete path. The trie terminal's
    // exact chain wins over this inherited prefix chain.
    const chain = chainOf(handlersForSegments(stack, segments, false));
    if (chain !== null) nodeFor(segments).prefixChain = chain;
  }

  stack.globalChain = chainOf(stack.global);
  stack.fallbackRoot = fallbackRoot;
};

export const addMiddleware = (
  stack: MiddlewareStack,
  scope: MiddlewareScope | null,
  handlers: readonly MiddlewareHandler[],
): void => {
  for (const handler of handlers) {
    stack.layers.push({ scope, handler });
    if (scope === null) stack.global.push(handler);
  }
  rebuildFallbacks(stack);
};

/** One sunk path with the method set it serves (HEAD rides GET). */
export interface SinkGuardSpec {
  readonly path: string;
  readonly methods: ReadonlySet<string>;
}

/** Parse and transactionally add one public app.use(...) call. */
export const registerMiddleware = (
  stack: MiddlewareStack,
  sinkSpecs: readonly SinkGuardSpec[],
  input: readonly unknown[],
  installerOf: (value: unknown) => ((app: Application) => void) | null,
  app: Application,
): boolean => {
  const args = [...input];
  const pattern = typeof args[0] === "string" ? (args.shift() as string) : null;
  const scope = pattern === null ? null : compileMiddlewareScope(pattern);
  if (scope !== null && args.length === 0) {
    throw new TypeError("app.use(pattern) requires at least one middleware function");
  }
  const hasUnexcusedFn = (): boolean =>
    args.some((value) => {
      if (typeof value !== "function") return false;
      const handler = value as MiddlewareHandler;
      return !sinkSpecs.every((spec) => noOpExcuses(handler, spec.methods));
    });
  if (scope === null && sinkSpecs.length > 0 && hasUnexcusedFn()) {
    throw new TypeError(
      "app.use(fn) cannot run alongside sunk routes unless every fn is declared a per-request no-op (noOpFor)",
    );
  }
  if (scope !== null) {
    for (const spec of sinkSpecs) {
      if (scopeOverlapsPath(scope, spec.path) && hasUnexcusedFn()) {
        throw new TypeError(
          `app.use(${JSON.stringify(pattern)}) middleware overlaps natively-sunk ${spec.path}`,
        );
      }
    }
  }

  let changed = false;
  const pending: MiddlewareHandler[] = [];
  const flush = (): void => {
    if (pending.length === 0) return;
    addMiddleware(stack, scope, pending.splice(0));
    changed = true;
  };
  for (const value of args) {
    const installer = installerOf(value);
    if (installer !== null) {
      if (scope !== null) {
        throw new TypeError("app.use(pattern, plugin) is invalid — plugins install app-wide");
      }
      flush();
      installer(app);
      continue;
    }
    if (typeof value !== "function") {
      throw new TypeError("app.use() requires a middleware function or plugin");
    }
    pending.push(value as MiddlewareHandler);
  }
  flush();
  return changed;
};

const routeRelation = (
  scope: MiddlewareScope,
  route: readonly CompiledSegment[],
): "always" | "never" | "conditional" => {
  if (!scope.prefix) {
    if (
      route.length === scope.segments.length &&
      route.every(
        (segment, index) =>
          segment.kind === "static" && segment.value === (scope.segments[index] as string),
      )
    ) {
      return "always";
    }
    // A fully static route is provably different. Dynamic/optional/wildcard
    // patterns may still resolve to the exact scoped path at request time.
    return route.every((segment) => segment.kind === "static") ? "never" : "conditional";
  }
  if (scope.segments.length === 0) return "always";
  for (let index = 0; index < scope.segments.length; index++) {
    const segment = route[index];
    if (segment === undefined) {
      return route.some((candidate) => candidate.kind !== "static") ? "conditional" : "never";
    }
    if (segment.kind !== "static") return "conditional";
    if (segment.value !== scope.segments[index]) return "never";
  }
  return "always";
};

const conditional = (
  scope: MiddlewareScope,
  handler: MiddlewareHandler,
  pathOffset: number,
): MiddlewareHandler => {
  const wrapped: MiddlewareHandler = (c, next) => {
    const segments = pathSegments(c.path);
    return scopeMatchesSegments(scope, segments.slice(pathOffset)) ? handler(c, next) : next();
  };
  conditionalMeta.set(wrapped, { scope, handler, pathOffset });
  return wrapped;
};

/** Applicable layers for a registered route, in original app.use order. */
export const middlewareForRoute = (
  stack: MiddlewareStack,
  path: string,
  pathOffset = 0,
): MiddlewareHandler[] => {
  const route = compilePattern(path).segments;
  const handlers: MiddlewareHandler[] = [];
  for (const layer of stack.layers) {
    if (layer.scope === null) {
      handlers.push(layer.handler);
      continue;
    }
    const relation = routeRelation(layer.scope, route);
    if (relation === "always") handlers.push(layer.handler);
    else if (relation === "conditional") {
      handlers.push(conditional(layer.scope, layer.handler, pathOffset));
    }
  }
  return handlers;
};

/** Rebase conditional middleware already carried by a mounted definition. */
export const rebaseMountedMiddleware = (
  handlers: readonly MiddlewareHandler[],
  pathOffset: number,
): MiddlewareHandler[] =>
  handlers.map((handler) => {
    const meta = conditionalMeta.get(handler);
    return meta === undefined
      ? handler
      : conditional(meta.scope, meta.handler, meta.pathOffset + pathOffset);
  });

/** Precompiled chain for an unmatched path or unmatched method. */
export const fallbackMiddlewareForPath = (
  stack: MiddlewareStack,
  path: string,
): MiddlewareChain | null => {
  if (stack.layers.length === stack.global.length) return stack.globalChain;
  const segments = pathSegments(path);
  let node = stack.fallbackRoot;
  let prefixChain = node.prefixChain;
  for (const segment of segments) {
    const child = node.children.get(segment);
    if (child === undefined) return prefixChain ?? stack.globalChain;
    node = child;
    if (node.prefixChain !== null) prefixChain = node.prefixChain;
  }
  return node.exactChain ?? prefixChain ?? stack.globalChain;
};

/** Dev-only trace helper; production route dispatch never calls this. */
export const hasMiddlewareForPath = (stack: MiddlewareStack, path: string): boolean => {
  if (stack.global.length > 0) return true;
  const segments = pathSegments(path);
  return stack.layers.some(
    (layer) => layer.scope !== null && scopeMatchesSegments(layer.scope, segments),
  );
};

/**
 * Does a middleware scope intersect a route pattern? The pattern may carry
 * dynamic segments (a sunk `/users/:id`): compile it as a ROUTE, never as a
 * middleware scope — compiling a param pattern as a scope would throw the
 * app.use()-shaped error in sink guards. Dynamic segments are compatible
 * with everything and optional segments may collapse (conservative: overlap).
 */
export const scopeOverlapsPath = (scope: MiddlewareScope, pattern: string): boolean => {
  const route = compilePattern(pattern).segments;
  const collapsible = route.some((segment) => segment.optional);
  if (!scope.prefix) {
    if (route.length !== scope.segments.length) {
      return collapsible && route.length > scope.segments.length;
    }
    return scope.segments.every(
      (segment, index) =>
        (route[index] as CompiledSegment).kind !== "static" ||
        (route[index] as CompiledSegment).value === segment,
    );
  }
  for (let index = 0; index < scope.segments.length; index++) {
    const segment = route[index];
    if (segment === undefined) return collapsible;
    if (segment.kind !== "static") continue;
    if (segment.value !== scope.segments[index]) return false;
  }
  return true;
};

/**
 * Middleware layers that would observe a sink serving `path` for `methods`.
 * Layers whose handler carries a transparency declaration excusing those
 * methods are skipped — the native table bypasses them by attestation.
 */
export const middlewareConflictForPath = (
  stack: MiddlewareStack,
  path: string,
  methods: ReadonlySet<string>,
): string | null => {
  for (const layer of stack.layers) {
    if (noOpExcuses(layer.handler, methods)) continue;
    if (layer.scope === null) return "global";
    if (scopeOverlapsPath(layer.scope, path)) return layer.scope.pattern;
  }
  return null;
};
