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
 * instead of silently diverging between the two layers — with two explicit
 * exceptions this module owns:
 *  - FUNCTION sinks: the handler opts IN to running without middleware,
 *    context, or sugar; it receives `(request, params)` and returns a
 *    Response. Non-participation is the documented contract, guarded the
 *    same way as every other sink (global/scoped middleware must be
 *    excused via noOpFor, param middleware always refuses).
 *  - Transparency declarations (noOpFor): a middleware AUTHOR may attest a
 *    layer performs no observable action for a sink's methods, excusing it
 *    from the guards below. The JS mirror keeps running the layer; only
 *    the native table skips it — a lying declaration is observable in the
 *    sink parity suite, never silently.
 *
 * Remaining invariants:
 *  - no param middleware may be registered (per-request JS by definition),
 *  - a sunk path may not overlap any JS route path (either direction —
 *    including param-vs-literal shapes; the native table wins at runtime,
 *    so overlap is a silent-shadow bug),
 *  - static sinks must be plain paths; `{dir}` sinks must end in `/*`;
 *    function sinks support static and plain `:param` segments only,
 *  - function sinks and app.onError() are mutually exclusive (the error
 *    mapper contract is context-based; sunk handlers have no context).
 *
 * `{dir}` sinks mirror to `serveStatic({root, prefix})`: index resolution
 * and 404s match, but the native table adds 301 trailing-slash redirects
 * and Range requests the JS mirror does not implement (documented in
 * PARITY.md). The mirror also keeps serveStatic's symlink denial — and since
 * Bun's native `{dir}` route has no per-request checks at all, every tree is
 * SCANNED (assertSunkDirSafe) before it goes native: a dotfile or symlink
 * the mirror would decline/403 would be a plain 200 one layer down.
 */

import { serveStatic } from "../middleware/serve-static.ts";
import {
  EMPTY_PARAMS,
  paramsRecord,
  pathsConflict,
  registerDef,
  type RouteDef,
  type RouteHandler,
  type RouterState,
} from "../router/router.ts";
import { compilePattern, patternsOverlap } from "../router/pattern.ts";
import { isNativeRequestSource, sourceRequest } from "../core/request-source.ts";
import { createPlannedResponse } from "../core/response-plan.ts";
import { sunkErrorResponse } from "./error-response.ts";
import {
  middlewareConflictForPath,
  type MiddlewareStack,
  type SinkGuardSpec,
} from "./middleware-stack.ts";
import { nodePath } from "../utils/node-lazy.ts";
import { nodeFsSync } from "../utils/path-safety.ts";

/** Scan budgets (per sink): bound the pre-listen walk itself — an unbounded
 *  scan of a huge tree would be a startup stall (and a DoS lever on shared
 *  mounts). Trees past either budget refuse to go native, loudly. */
const MAX_SCAN_ENTRIES = 10_000;
const MAX_SCAN_DEPTH = 64;

/**
 * Refuse to hand a `{dir}` sink to Bun's native routes table unless the
 * whole tree is provably servable WITHOUT per-request checks: any dotfile
 * (the mirror's default policy declines it; `.well-known` is exempt per RFC
 * 8615) or ANY symlink component (the mirror answers 403) would be a plain
 * 200 on the native leg — the R4.11 audit served `.env` and followed a
 * symlink out of the root that way. Throws a TypeError listing the
 * violating paths and the two remedies.
 *
 * Sync by design (the table feeds Bun.serve synchronously — see the inline
 * note below); runs at EVERY native-table build — listen(), sink()-after-
 * listen and reloadNativeRoutes() all rebuild through buildNativeRoutes, so
 * a tree dirtied between builds is caught at the next one. What appears
 * INSIDE the window between two scans is the deployer's responsibility
 * (documented in PARITY.md's divergence ledger).
 */
export const assertSunkDirSafe = (sinkPath: string, dir: string): void => {
  // Sync fs by necessity: this runs inside buildNativeRoutes, which feeds
  // Bun.serve({routes}) and server.reload({routes}) synchronously.
  const fs = nodeFsSync();
  const { resolve, sep } = nodePath();
  const root = resolve(dir);
  const violations: string[] = [];
  let scanned = 0;
  let overBudget = false;
  const walk = (current: string, depth: number): void => {
    if (depth > MAX_SCAN_DEPTH) {
      violations.push(`${current}${sep}… (deeper than ${MAX_SCAN_DEPTH})`);
      return;
    }
    let entries: readonly import("node:fs").Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? String(error);
      throw new TypeError(
        `sink ${sinkPath}: cannot scan ${current} (${code}) — the native {dir} route refuses to serve a tree it cannot verify. ` +
          `Create the directory (or fix its permissions) and retry, or serve explicit content with a Response/handler sink instead.`,
        { cause: error },
      );
    }
    for (const entry of entries) {
      if (++scanned > MAX_SCAN_ENTRIES) {
        overBudget = true;
        return;
      }
      const full = `${current}${sep}${entry.name}`;
      if (entry.isSymbolicLink()) violations.push(`${full} (symlink)`);
      else if (entry.name.startsWith(".") && entry.name !== ".well-known")
        violations.push(`${full} (dotfile)`);
      else if (entry.isDirectory()) walk(full, depth + 1);
    }
  };
  walk(root, 0);
  if (overBudget) {
    throw new TypeError(
      `sink ${sinkPath}: directory ${dir} exceeds the native-table scan budget (${MAX_SCAN_ENTRIES} entries) — ` +
        `split the tree into smaller sinks, or serve explicit content with a Response/handler sink instead.`,
    );
  }
  if (violations.length > 0) {
    const shown = violations.slice(0, 5).join("; ");
    const more = violations.length > 5 ? ` (+${violations.length - 5} more)` : "";
    throw new TypeError(
      `sink ${sinkPath}: the native {dir} route cannot serve this tree — ${shown}${more}. ` +
        `The JS mirror declines dotfiles and symlinks, but Bun's native table would serve them as plain 200s. ` +
        `Remove the offending entries and retry, or serve explicit content with a Response/handler sink instead.`,
    );
  }
};

/** A prebuilt static response (Bun reuses the instance natively). */
export interface NativeStaticSink {
  readonly response: Response;
}

/** A directory tree served under the sink path (path must end in `/*`). */
export interface NativeDirSink {
  readonly dir: string;
}

/**
 * A handler served from the native routes table. It runs WITHOUT
 * middleware, context, or sugar — that elimination is the point — and must
 * be usable identically on the JS mirror, so the signature takes what both
 * runtimes can provide: the fetch Request and the decoded params record
 * (null-prototype on both Bun's native table and keala's trie). It must
 * never close over request state; `server` is deliberately not exposed
 * (the mirror has none — `c.ip` users keep ordinary routes).
 */
export type SunkHandler = (
  request: Request,
  params: Readonly<Record<string, string>>,
) => Response | Promise<Response>;

export interface NativeFnSink {
  readonly handler: SunkHandler;
  /** Methods served natively; GET-only for now (HEAD rides GET). */
  readonly methods: readonly ["GET"];
}

export type NativeSinkEntry = NativeStaticSink | NativeDirSink | NativeFnSink;

const GET_METHODS: ReadonlySet<string> = new Set(["GET"]);

// Prior sinks are already mirrored into defs, so one pass over the route
// table covers both JS routes and earlier sinks. Pattern-aware: a dynamic
// segment on either side can consume what the other spells literally.
const conflictsWithAny = (path: string, defs: readonly RouteDef[]): string | false => {
  for (const def of defs) {
    if (pathsConflict(path, def.path) || patternsOverlap(path, def.path)) {
      return `route ${def.method} ${def.path}`;
    }
  }
  return false;
};

/**
 * Register a sink: validate loudly, mirror into the JS router, and record
 * the path so later JS registrations under the same subtree throw.
 *
 * Registration stays sync and fs-free: `{dir}` trees are safety-scanned
 * (assertSunkDirSafe) when the native table is BUILT — listen(), a later
 * sink() and reloadNativeRoutes() all rescan there — so a directory that is
 * still being populated at registration time is verified before any byte is
 * served natively.
 */
export const registerSink = (
  router: RouterState,
  sinks: Map<string, NativeSinkEntry>,
  path: string,
  value: Response | { dir: string } | SunkHandler,
  middleware: MiddlewareStack,
  hasErrorMapper: boolean,
): void => {
  if (typeof path !== "string" || path.length === 0 || !path.startsWith("/")) {
    throw new TypeError(`sink path must be an absolute path, got ${JSON.stringify(path)}`);
  }
  if (sinks.has(path)) {
    throw new TypeError(`sink ${path} is already registered`);
  }
  const middlewareConflict = middlewareConflictForPath(middleware, path, GET_METHODS);
  if (middlewareConflict !== null) {
    if (middlewareConflict === "global") {
      throw new TypeError(
        "app.sink() requires an app without global middleware — declare per-request no-ops with noOpFor() or drop the sink",
      );
    }
    throw new TypeError(
      `app.sink() conflicts with ${middlewareConflict} middleware — the native routing table would bypass it`,
    );
  }
  if (router.paramMiddlewares.size > 0) {
    throw new TypeError(
      "app.sink() requires an app without param middleware — the native routing table bypasses it",
    );
  }

  const isResponse = value instanceof Response;
  const isFn = !isResponse && typeof value === "function";
  const dirValue =
    !isResponse &&
    !isFn &&
    typeof value === "object" &&
    value !== null &&
    typeof value.dir === "string"
      ? value.dir
      : null;
  if (!isResponse && !isFn && dirValue === null) {
    throw new TypeError("app.sink() requires a Response, { dir }, or handler function");
  }
  if (isResponse) {
    const response = value as Response;
    // The native table replays the SAME instance on every hit — a body that
    // was already consumed is provably dead (every request would 500). An
    // UNCONSUMED body is fine: the mirror snapshots it through a clone and
    // rebuilds per hit, and `bodyUsed` is the only synchronously provable
    // non-replay state (every fetch body — string or stream — surfaces as a
    // ReadableStream, so its type distinguishes nothing).
    if (response.bodyUsed) {
      throw new TypeError(
        "app.sink() requires an unconsumed Response — an already-read body cannot be replayed",
      );
    }
  }
  const entry: NativeSinkEntry = isResponse
    ? { response: value as Response }
    : isFn
      ? { handler: value as SunkHandler, methods: ["GET"] }
      : { dir: dirValue as string };
  const isDir = !isResponse && !isFn;

  if (isDir) {
    if ((entry as NativeDirSink).dir.length === 0) {
      throw new TypeError("sink { dir } requires a directory path");
    }
    if (!path.endsWith("/*")) {
      throw new TypeError(`sink ${path}: directory sinks must end in /* (e.g. "/assets/*")`);
    }
  } else if (isFn) {
    if (hasErrorMapper) {
      throw new TypeError(
        "app.sink(path, fn) requires an app without app.onError() — the error mapper contract is context-based and a sunk handler has no context",
      );
    }
    if (path.includes("%")) {
      throw new TypeError(
        `sink ${path}: percent-encoded paths cannot sink — the native table matches raw bytes while the router decodes (bun#37603)`,
      );
    }
    // Static and plain `:param` segments only: optional params fork into
    // present/absent shapes, custom regexes and wildcards have no verified
    // native-table equivalent.
    for (const segment of compilePattern(path).segments) {
      if (segment.kind === "static") continue;
      if (segment.kind === "param" && !segment.optional && segment.pattern === null) continue;
      throw new TypeError(
        `sink ${path}: function sinks support static and plain ":param" segments only`,
      );
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
    registerDef(router, "GET", path, [handler], undefined, middleware);
    registerDef(router, "GET", prefix || "/", [handler], undefined, middleware);
    for (const def of router.defs.slice(firstDef)) router.sunkPaths.add(def.path);
    return;
  }

  if (isFn) {
    // The mirror is an ordinary one-handler route: dispatch's direct fast
    // path serves it, transparent middleware still runs (a lying noOpFor
    // declaration diverges the native leg only), and the handler receives a
    // real Request on every runtime (native sources materialize lazily).
    const handler = (entry as NativeFnSink).handler;
    // The SunkHandler contract stays `(request, params: Record)` — the mirror
    // is the boundary where the router's raw arrays become that Record (U2,
    // router.ts paramsRecord). Slow by design: sunk handlers opted out of
    // the onion.
    const mirror: RouteHandler = (c) =>
      handler(
        sourceRequest(c.rawRequest),
        paramsRecord(c.paramNames, c.paramValues, c.paramOffset),
      );
    registerDef(router, "GET", path, [mirror], undefined, middleware);
    markSunk();
    return;
  }

  // The static mirror rebuilds a fresh Response per hit — an instance can be
  // consumed once, and the native table must keep the original untouched.
  // The recipe is captured lazily from a clone on the first JS request.
  // Native sources (the Node adapter) get a PLANNED per-hit response: the
  // writer then serves the cached bytes through its header-snapshot +
  // direct-body path with no stream hop — the R4.8 matrix showed the
  // per-hit rebuild costing Node ~4.5μs/req. Other sources (Bun's mirror,
  // in-process handle tests) keep the real Response; a PlannedResponse must
  // never be handed to Bun.serve's native writer.
  const source = (entry as NativeStaticSink).response;
  let rebuild: (() => Response) | null = null;
  let direct = false;
  const capture = async (native: boolean): Promise<Response> => {
    const clone = source.clone();
    const bytes = new Uint8Array(await clone.arrayBuffer());
    const status = clone.status;
    const statusText = clone.statusText;
    // clone.headers stays readable after the body is consumed; passing it as
    // ResponseInit preserves multi-value headers (e.g. multiple Set-Cookie).
    const headers = clone.headers;
    direct = native && bytes.byteLength !== 0 && status !== 204 && status !== 205 && status !== 304;
    rebuild = () =>
      // Fetch-spec null-body statuses reject a body at construction. The
      // statusText rides along — the native table reuses the original
      // instance verbatim and the JS mirror must not diverge from it.
      bytes.byteLength === 0 || status === 204 || status === 205 || status === 304
        ? new Response(null, { status, statusText, headers })
        : direct
          ? createPlannedResponse(bytes, { status, statusText, headers })
          : new Response(bytes, { status, statusText, headers });
    return rebuild();
  };
  const mirror: RouteHandler = (c) => {
    if (rebuild === null) {
      return capture(isNativeRequestSource(c.rawRequest));
    }
    return rebuild();
  };
  registerDef(router, "GET", path, [mirror], undefined, middleware);
  markSunk();
};

/**
 * Guard specs for app.use(): every path in the router's sunkPaths set
 * (mirror twins included) with the methods its native entry serves. HEAD
 * rides GET everywhere, so a declaration covering GET covers its rider.
 */
export const sinkGuardSpecs = (
  sunkPaths: ReadonlySet<string>,
  sinks: ReadonlyMap<string, NativeSinkEntry>,
): readonly SinkGuardSpec[] => {
  if (sunkPaths.size === 0) return [];
  const specs: SinkGuardSpec[] = [];
  for (const path of sunkPaths) {
    const entry = sinks.get(path);
    specs.push({
      path,
      methods: entry !== undefined && "handler" in entry ? new Set(entry.methods) : GET_METHODS,
    });
  }
  return specs;
};

/**
 * Wrap a sunk handler for the native table. Sync stays sync (Bun.serve
 * accepts `Response | Promise<Response>`); every failure routes through
 * the context-free builtin funnel — a bare throw would reach Bun's serve
 * `error` callback (plain 500, no exposed-4xx parity) and a non-Response
 * return would get Bun's SILENT 200 help page (probe-verified on 1.4),
 * both unacceptable next to the mirror's loud builtin answers.
 */
const sunkFail = (method: string, error: unknown): Response => sunkErrorResponse(method, error);

const sunkCheck = (method: string, result: unknown): Response =>
  result instanceof Response
    ? result
    : sunkFail(method, new TypeError("a sunk handler must return a Response"));

const nativeFnRoute =
  (handler: SunkHandler) =>
  (request: Request): Response | Promise<Response> => {
    const params = (request as Request & { params?: Readonly<Record<string, string>> }).params;
    try {
      const result = handler(request, params ?? EMPTY_PARAMS);
      return result instanceof Promise
        ? result.then(
            (value) => sunkCheck(request.method, value),
            (error) => sunkFail(request.method, error),
          )
        : sunkCheck(request.method, result);
    } catch (error) {
      return sunkFail(request.method, error);
    }
  };

/**
 * Build the plain routes-table object for `Bun.serve({routes})` /
 * `server.reload({routes})`. Response instances are reused natively; dir
 * sinks become `{ dir }` entries (index/Range handled by Bun); function
 * sinks get the contained wrapper above. Every `{dir}` entry is scanned
 * first (assertSunkDirSafe): a refusal throws out of here, which fails
 * listen()/reload before any byte is served natively.
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
    if ("handler" in entry) {
      routes[path] = { GET: nativeFnRoute(entry.handler) };
      continue;
    }
    if ("response" in entry) {
      routes[path] = { GET: entry.response };
      continue;
    }
    assertSunkDirSafe(path, entry.dir);
    routes[path] = { GET: { dir: entry.dir } };
  }
  return routes;
};
