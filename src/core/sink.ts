/**
 * Native route sinking — `app.sink()`.
 *
 * A sunk route lives TWICE:
 *  1. as an ordinary JS route (the mirror) — identical semantics on every
 *     runtime, so `app.handle()` keeps working under Node and in tests;
 *  2. in `Bun.serve`'s native `routes` table (built by the adapter at
 *     listen() time) — matched BEFORE `fetch`, with zero JS per request.
 *
 * Eligibility is deliberately narrow and loud: a sunk route bypasses the
 * onion entirely, so anything that needs per-request JS refuses to sink
 * instead of silently diverging between the two layers. Concretely:
 *  - no global middleware may be registered (`app.use(fn)` throws while
 *    sinks exist — the native table would skip it),
 *  - no param middleware may be registered,
 *  - a sunk path may not overlap any JS route path (either direction —
 *    the native table wins at runtime, so overlap is a silent-shadow bug),
 *  - static sinks must be plain paths; `{dir}` sinks must end in `/*`.
 *
 * `{dir}` sinks mirror to `serveStatic({root, prefix})`: index resolution
 * and 404s match, but the native table adds 301 trailing-slash redirects
 * and Range requests the JS mirror does not implement (documented in
 * PARITY.md). The mirror also keeps serveStatic's symlink denial.
 */

import { serveStatic } from "../middleware/serve-static.ts";
import {
  pathsConflict,
  registerDef,
  type RouteDef,
  type RouteHandler,
  type RouterState,
} from "../router/router.ts";

/** A prebuilt static response (Bun reuses the instance natively). */
export interface NativeStaticSink {
  readonly response: Response;
}

/** A directory tree served under the sink path (path must end in `/*`). */
export interface NativeDirSink {
  readonly dir: string;
}

export type NativeSinkEntry = NativeStaticSink | NativeDirSink;

// Prior sinks are already mirrored into defs, so one pass over the route
// table covers both JS routes and earlier sinks.
const conflictsWithAny = (path: string, defs: readonly RouteDef[]): string | false => {
  for (const def of defs) {
    if (pathsConflict(path, def.path)) return `route ${def.method} ${def.path}`;
  }
  return false;
};

/**
 * Register a sink: validate loudly, mirror into the JS router, and record
 * the path so later JS registrations under the same subtree throw.
 */
export const registerSink = (
  router: RouterState,
  sinks: Map<string, NativeSinkEntry>,
  path: string,
  value: Response | { dir: string },
  globalMw: readonly RouteHandler[],
): void => {
  if (typeof path !== "string" || path.length === 0 || !path.startsWith("/")) {
    throw new TypeError(`sink path must be an absolute path, got ${JSON.stringify(path)}`);
  }
  if (sinks.has(path)) {
    throw new TypeError(`sink ${path} is already registered`);
  }
  if (globalMw.length > 0) {
    throw new TypeError(
      "app.sink() requires an app without global middleware — the native routing table bypasses it",
    );
  }
  if (router.paramMiddlewares.size > 0) {
    throw new TypeError(
      "app.sink() requires an app without param middleware — the native routing table bypasses it",
    );
  }

  const isResponse = value instanceof Response;
  const dirValue =
    !isResponse && typeof value === "object" && value !== null && typeof value.dir === "string"
      ? value.dir
      : null;
  if (!isResponse && dirValue === null) {
    throw new TypeError("app.sink() requires a Response or { dir } value");
  }
  const entry: NativeSinkEntry = isResponse ? { response: value } : { dir: dirValue as string };
  const isDir = !isResponse;

  if (isDir) {
    if ((entry as NativeDirSink).dir.length === 0) {
      throw new TypeError("sink { dir } requires a directory path");
    }
    if (!path.endsWith("/*")) {
      throw new TypeError(`sink ${path}: directory sinks must end in /* (e.g. "/assets/*")`);
    }
  } else if (path.includes("*") || path.includes(":")) {
    throw new TypeError(
      `sink ${path}: static response sinks must be plain paths (params/wildcards cannot have a static response)`,
    );
  }

  const conflict = conflictsWithAny(path, router.defs);
  if (conflict !== false) {
    throw new TypeError(`sink ${path} overlaps an existing ${conflict}`);
  }

  sinks.set(path, entry);
  // After the mirror lands, record its NORMALIZED path so later JS
  // registrations under this subtree throw instead of being shadowed.
  const markSunk = (): void => {
    const mirrorDef = router.defs[router.defs.length - 1];
    if (mirrorDef !== undefined) router.sunkPaths.add(mirrorDef.path);
  };

  if (isDir) {
    const dir = (entry as NativeDirSink).dir;
    const prefix = path.slice(0, -2);
    const handler = serveStatic({ root: dir, prefix });
    const firstDef = router.defs.length;
    // Wildcard mirror for the tree, plus a static twin: the native {dir}
    // route does not serve the bare prefix (it falls through to fetch), so
    // the twin answers "/assets" and "/assets/" with the index on BOTH
    // runtimes.
    registerDef(router, "GET", path, [handler], undefined, globalMw);
    registerDef(router, "GET", prefix || "/", [handler], undefined, globalMw);
    for (const def of router.defs.slice(firstDef)) router.sunkPaths.add(def.path);
    return;
  }

  // The static mirror rebuilds a fresh Response per hit — an instance can be
  // consumed once, and the native table must keep the original untouched.
  // The recipe is captured lazily from a clone on the first JS request.
  const source = (entry as NativeStaticSink).response;
  let rebuild: (() => Response) | null = null;
  const capture = async (): Promise<Response> => {
    const clone = source.clone();
    const bytes = await clone.arrayBuffer();
    const status = clone.status;
    const statusText = clone.statusText;
    // clone.headers stays readable after the body is consumed; passing it as
    // ResponseInit preserves multi-value headers (e.g. multiple Set-Cookie).
    const headers = clone.headers;
    rebuild = () =>
      // Fetch-spec null-body statuses reject a body at construction. The
      // statusText rides along — the native table reuses the original
      // instance verbatim and the JS mirror must not diverge from it.
      bytes.byteLength === 0 || status === 204 || status === 205 || status === 304
        ? new Response(null, { status, statusText, headers })
        : new Response(bytes, { status, statusText, headers });
    return rebuild();
  };
  const mirror: RouteHandler = () => (rebuild === null ? capture() : rebuild());
  registerDef(router, "GET", path, [mirror], undefined, globalMw);
  markSunk();
};

/**
 * Build the plain routes-table object for `Bun.serve({routes})` /
 * `server.reload({routes})`. Response instances are reused natively; dir
 * sinks become `{ dir }` entries (index/Range handled by Bun).
 *
 * Every entry is scoped `{ GET: value }` — a bare key would answer POST/
 * DELETE/… with the sunk response (verified against Bun 1.4), while the
 * JS mirror is GET-only and answers 405. Method scoping keeps the native
 * table identical to the mirror: non-GET falls through to `fetch` and the
 * ordinary router takes over.
 */
export const buildNativeRoutes = (
  sinks: ReadonlyMap<string, NativeSinkEntry>,
): Record<string, unknown> => {
  const routes: Record<string, unknown> = {};
  for (const [path, entry] of sinks) {
    routes[path] = { GET: "response" in entry ? entry.response : { dir: entry.dir } };
  }
  return routes;
};
