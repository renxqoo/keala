/**
 * serveStatic — file responses with the security ordering from the audit:
 * segment → decode-per-segment → normalize → containment check, null-byte
 * rejection, empty-segment refusal, GET/HEAD-only methods, symlink denial
 * (opt-in via lstat), nosniff, weak ETag + Last-Modified/304.
 *
 * `precompressed: true` additionally serves build-time `<file>.br` /
 * `<file>.gz` siblings when Accept-Encoding accepts them (brotli first);
 * `onFound` / `onNotFound` are synchronous observability hooks.
 *
 * Under Bun, requests WITHOUT conditional headers (If-None-Match /
 * If-Modified-Since / Range) and without index resolution take a leaner
 * path: stat and the symlink audit still run (a vanished file must 404, a
 * symlink must 403 — Bun's native Bun.file serving answers 500 and 200 for
 * those respectively), but the Last-Modified/304 layer is skipped — the
 * response carries the weak ETag, so revalidation still round-trips
 * (PARITY.md carries the divergence note).
 *
 * The path-safety and conditional-request primitives live in
 * `utils/path-safety.ts` / `http/conditional.ts` (and on the root entry) —
 * this middleware is their flagship consumer, not their owner. The fs/path
 * bridges load with the FIRST request — importing this middleware costs
 * nothing at idle.
 */

import { createError } from "../http/errors.ts";
import { isNotModified, weakEtag } from "../http/conditional.ts";
import type { RouteHandler } from "../router/router.ts";
import { nodeFsPromises, nodePath } from "../utils/node-lazy.ts";
import {
  findSymlink,
  findSymlinkSync,
  isWithinRoot,
  nodeFsSync,
  resolveRelativeSegments,
} from "../utils/path-safety.ts";
import { mimeFromExtension } from "../utils/mime.ts";

// Bun.file bodies are zero-copy (sendfile) with automatic Content-Length and
// Range handling; Node keeps the buffered readFile path.
const bunFile =
  typeof Bun !== "undefined" && typeof Bun.file === "function"
    ? (path: string): Blob => Bun.file(path) as unknown as Blob
    : null;

export interface ServeStaticOptions {
  /** Root directory; every resolved path must stay inside it. */
  root: string;
  /** Follow symlinks. Off by default (lstat check). */
  followSymlinks?: boolean;
  /** Directory requests serve this file instead. Default "index.html";
   *  `false` disables directory responses entirely. */
  index?: string | false;
  /** Strip this prefix before resolving (mounted usage). */
  prefix?: string;
  /**
   * Dotfile policy. Default "ignore": leading-dot segments decline
   * (next()) — `/.env` and `/.git/config` used to be plain 200s (R4.10).
   * `.well-known` (RFC 8615) is always served. "allow" restores the old
   * behavior for roots that genuinely publish dotfiles.
   */
  dotfiles?: "allow" | "ignore";
  /**
   * Serve precompressed `<file>.br` / `<file>.gz` siblings when the
   * request's Accept-Encoding accepts them (brotli preferred over gzip —
   * better ratio, hono parity). Default false. The variant replaces the
   * response only when the ORIGINAL file exists; the hit carries
   * `Content-Encoding` and `Vary: Accept-Encoding`, and stays typed by the
   * original extension's mime. No variant → the original bytes, untouched.
   */
  precompressed?: boolean;
  /**
   * Fires whenever a file is found and served (200/206/304 alike, both the
   * lean and the slow path): the request URL path and the SERVED file's
   * size in bytes (the precompressed sibling's, when it wins).
   */
  onFound?: (path: string, size: number) => void;
  /**
   * Fires when the requested file is missing on disk (the 404 path — a
   * genuine fs miss; policy refusals like dotfile declines and traversal
   * 403s are not disk misses).
   */
  onNotFound?: (path: string) => void;
}

/**
 * Single-range `bytes=` parse (RFC 9110 §14.1.1). Multi-range requests
 * decline Range handling entirely (a 200 full-body answer is legal);
 * "unsatisfiable" answers 416; null means "ignore the header".
 */
const parseRange = (
  header: string,
  size: number,
): { start: number; end: number } | "unsatisfiable" | null => {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return null;
  const head = match[1] ?? "";
  const tail = match[2] ?? "";
  if (head === "" && tail === "") return null;
  if (head === "") {
    const suffix = Number(tail);
    if (suffix === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(head);
  if (start >= size) return "unsatisfiable";
  const end = tail === "" ? size - 1 : Math.min(Number(tail), size - 1);
  if (end < start) return null;
  return { start, end };
};

const stripPrefixOf = (rawPrefix: string | undefined): string | undefined => {
  if (rawPrefix === undefined) return undefined;
  if (rawPrefix.length > 1 && rawPrefix.endsWith("/")) return rawPrefix.slice(0, -1);
  return rawPrefix;
};

/**
 * Accept-Encoding candidates in preference order (brotli before gzip —
 * better ratio, hono parity). The q-parameter is stripped before the
 * token match; `*` accepts either.
 */
const acceptedEncodings = (accept: string): { encoding: string; ext: string }[] => {
  const tokens = new Set(accept.split(",").map((token) => token.split(";")[0]?.trim() ?? ""));
  const out: { encoding: string; ext: string }[] = [];
  if (tokens.has("br") || tokens.has("*")) out.push({ encoding: "br", ext: ".br" });
  if (tokens.has("gzip") || tokens.has("x-gzip") || tokens.has("*")) {
    out.push({ encoding: "gzip", ext: ".gz" });
  }
  return out;
};

export const serveStatic = (options: ServeStaticOptions): RouteHandler => {
  if (typeof options.root !== "string" || options.root.length === 0) {
    throw new TypeError("serveStatic({ root }) requires a directory path");
  }
  const indexName = options.index === undefined ? "index.html" : options.index;
  const prefix = stripPrefixOf(options.prefix);
  const dotfiles = options.dotfiles ?? "ignore";
  const precompressed = options.precompressed === true;
  const onFound = options.onFound;
  const onNotFound = options.onNotFound;
  // Resolved on the first request — keeps the path bridge out of setup.
  let rootCache: string | null = null;

  return async (c, next) => {
    // Static files answer GET/HEAD only — anything else falls through
    // (koa-static/express behavior; POST returning file content surprises
    // caches and CSRF assumptions).
    if (c.method !== "GET" && c.method !== "HEAD") return next();
    const { resolve, sep } = nodePath();
    const root = (rootCache ??= resolve(options.root));
    // A prefix owns its URL SUBTREE only — matching on a bare startsWith
    // would strip "/assets" off "/assetsfoo" too and serve mounted files
    // under URLs that belong to other routes. "/" or "" is the root mount.
    let relative: string | null;
    if (prefix === undefined || prefix === "" || prefix === "/") relative = c.path;
    else if (c.path === prefix) relative = "/";
    else if (c.path.startsWith(`${prefix}/`)) relative = c.path.slice(prefix.length);
    else relative = null;
    if (relative === null) return next();
    if (relative.includes("\0")) {
      throw createError(400, "null byte in path", { expose: true });
    }
    // Segment FIRST, decode each segment, then normalize; the resolved
    // absolute path must still stay under root (defense in depth).
    const segments = resolveRelativeSegments(relative, sep === "\\");
    if (segments === null) throw createError(404);
    if (segments.some((s) => s.includes("\0"))) {
      throw createError(400, "null byte in path", { expose: true });
    }
    // Dotfile policy: RFC 8615's .well-known stays reachable regardless.
    if (
      dotfiles === "ignore" &&
      segments.some((segment) => segment.startsWith(".") && segment !== ".well-known")
    ) {
      return next();
    }
    const clean = segments.join("/");
    if (clean.length === 0 && indexName === false) throw createError(404);
    // resolveRelativeSegments has already eliminated every ".", ".." and
    // empty segment, so on POSIX the plain join IS resolve(root, clean) —
    // without the normalizer's per-request allocations (R4.11 PERF-2).
    const absolute =
      clean.length === 0 || sep !== "/"
        ? resolve(root, clean.length === 0 ? (indexName as string) : clean)
        : root === "/"
          ? `/${clean}`
          : `${root}/${clean}`;
    if (!isWithinRoot(absolute, root, sep)) {
      throw createError(403, "path traversal rejected", { expose: true });
    }
    // Lean Bun path: no conditional headers, no Range, no index resolution
    // in play (a final segment with an extension cannot be an index lookup).
    // stat and the symlink audit below still run — Bun 1.4 serves a vanished
    // Bun.file as 500 and follows symlinks, so neither check is droppable —
    // but the Last-Modified/304 layer is skipped. The weak ETag stays, so
    // clients can still graduate to conditional requests.
    const leanFile =
      bunFile !== null &&
      clean.length !== 0 &&
      clean.indexOf(".", clean.lastIndexOf("/") + 1) !== -1 &&
      c.header("if-none-match").length === 0 &&
      c.header("if-modified-since").length === 0 &&
      c.header("range").length === 0;

    if (leanFile) {
      // Sync metadata calls: Bun 1.4's fs/promises compat layer costs ~23µs
      // per stat (probe-verified — the entire static request budget) against
      // ~1µs for the native sync call, so the lean path never awaits fs. A
      // directory here (an extension-named directory requested without its
      // trailing slash) falls through to the async path for index resolution.
      const { statSync } = nodeFsSync();
      let syncInfo: ReturnType<typeof statSync>;
      try {
        syncInfo = statSync(absolute);
      } catch {
        onNotFound?.(c.path);
        throw createError(404);
      }
      if (!syncInfo.isDirectory()) {
        // Precompressed negotiation: a sibling variant replaces the served
        // path only once the ORIGINAL is confirmed present (hono parity —
        // an orphan .br never conjures a routable file).
        let servingPath = absolute;
        let servingInfo = syncInfo;
        let encoding: string | null = null;
        if (precompressed) {
          for (const candidate of acceptedEncodings(c.header("accept-encoding"))) {
            try {
              const variant = statSync(absolute + candidate.ext);
              if (!variant.isDirectory()) {
                servingPath = absolute + candidate.ext;
                servingInfo = variant;
                encoding = candidate.encoding;
                break;
              }
            } catch {
              // No such sibling — next candidate, then the original.
            }
          }
        }
        if (options.followSymlinks !== true) {
          const link = findSymlinkSync(root, servingPath);
          if (link !== null) {
            throw createError(403, "symlinks are not followed", { expose: true });
          }
        }
        const leanHeaders: Record<string, string> = {
          etag: weakEtag(servingInfo.size, servingInfo.mtime.getTime()),
          "x-content-type-options": "nosniff",
        };
        // The variant keeps the ORIGINAL extension's content type.
        const leanMime = mimeFromExtension(absolute);
        if (leanMime !== null) leanHeaders["content-type"] = leanMime;
        if (encoding !== null) {
          leanHeaders["content-encoding"] = encoding;
          leanHeaders["vary"] = "Accept-Encoding";
        }
        onFound?.(c.path, servingInfo.size);
        return new Response(bunFile(servingPath), { headers: leanHeaders });
      }
    }

    const { stat, readFile } = nodeFsPromises();
    let info;
    try {
      info = await stat(absolute);
    } catch {
      onNotFound?.(c.path);
      throw createError(404);
    }
    let filePath = absolute;
    if (info.isDirectory()) {
      if (indexName === false) throw createError(404);
      filePath = resolve(absolute, indexName as string);
      // A configured index ("../../x") must never escape the root.
      if (!isWithinRoot(filePath, root, sep)) {
        throw createError(403, "path traversal rejected", { expose: true });
      }
      try {
        info = await stat(filePath);
      } catch {
        onNotFound?.(c.path);
        throw createError(404);
      }
    }
    // Precompressed negotiation runs AFTER the original (or its index) is
    // confirmed present: the sibling replaces the served path, the original
    // keeps supplying the content type.
    const typedPath = filePath;
    let encoding: string | null = null;
    if (precompressed) {
      for (const candidate of acceptedEncodings(c.header("accept-encoding"))) {
        try {
          const variant = await stat(filePath + candidate.ext);
          if (!variant.isDirectory()) {
            filePath += candidate.ext;
            info = variant;
            encoding = candidate.encoding;
            break;
          }
        } catch {
          // No such sibling — next candidate, then the original.
        }
      }
    }
    if (options.followSymlinks !== true) {
      // ANY symlink component under root — a linked directory just as much
      // as a linked file — is denied, even when it points back inside root.
      // (root itself may legitimately be a symlink.) The walk covers the
      // FINAL served path (the directory-index and precompressed variant
      // resolutions included): walking only `absolute` would leave a
      // symlinked <dir>/index.html or <file>.br unexamined exactly when an
      // earlier resolution step had moved the target.
      const link = await findSymlink(root, filePath);
      if (link !== null) {
        throw createError(403, "symlinks are not followed", { expose: true });
      }
    }
    onFound?.(c.path, info.size);

    const mime = mimeFromExtension(typedPath);
    const etag = weakEtag(info.size, info.mtime.getTime());
    const lastModified = info.mtime.toUTCString();
    const headers: Record<string, string> = {
      etag,
      "last-modified": lastModified,
      "x-content-type-options": "nosniff",
    };
    if (mime !== null) headers["content-type"] = mime;
    if (encoding !== null) {
      headers["content-encoding"] = encoding;
      headers["vary"] = "Accept-Encoding";
    }

    // RFC 9110 §13.2.2 via isNotModified: If-None-Match decides when
    // present — a match is a 304, a MISMATCH falls through to the full 200
    // representation (never an empty 200); If-Modified-Since is only
    // consulted without If-None-Match.
    const mtimeMs = info.mtime.getTime();
    if (
      isNotModified({
        etag,
        mtimeMs,
        ifNoneMatch: c.header("if-none-match"),
        ifModifiedSince: c.header("if-modified-since"),
      })
    ) {
      return new Response(null, { status: 304, headers });
    }
    if (bunFile !== null) return new Response(bunFile(filePath), { headers });
    // Node path. HEAD never reads the file (R4.10: a 120MB HEAD read the
    // whole body just to strip it); Range gives the Bun path's seek parity.
    headers["accept-ranges"] = "bytes";
    if (c.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: { ...headers, "content-length": String(info.size) },
      });
    }
    const rangeHeader = c.header("range");
    const range = rangeHeader.length > 0 ? parseRange(rangeHeader, info.size) : null;
    if (range === "unsatisfiable") {
      return new Response(null, {
        status: 416,
        headers: { ...headers, "content-range": `bytes */${info.size}` },
      });
    }
    const bytes = await readFile(filePath).catch(() => null);
    if (bytes === null) throw createError(404);
    const body = new Uint8Array(bytes);
    if (range !== null) {
      const length = range.end - range.start + 1;
      return new Response(body.subarray(range.start, range.end + 1), {
        status: 206,
        headers: {
          ...headers,
          "content-length": String(length),
          "content-range": `bytes ${range.start}-${range.end}/${info.size}`,
        },
      });
    }
    return new Response(body, { headers });
  };
};
