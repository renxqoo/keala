/**
 * serveStatic — file responses with the security ordering from the audit:
 * segment → decode-per-segment → normalize → containment check, null-byte
 * rejection, empty-segment refusal, GET/HEAD-only methods, symlink denial
 * (opt-in via lstat), nosniff, weak ETag + Last-Modified/304.
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
import { findSymlink, isWithinRoot, resolveRelativeSegments } from "../utils/path-safety.ts";
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
}

/**
 * Path-relative remainder of a mounted request, or null when the path is not
 * under the prefix (the mount then declines: next()). Segment boundaries only
 * — "/assets" owns "/assets" and "/assets/…", never "/assetsfoo". "/" (and a
 * trailing-slash form like "/assets/") normalize to the root/segment form so
 * every canonical prefix spelling owns the same subtree.
 */
const stripPrefixOf = (rawPrefix: string | undefined): string | undefined => {
  if (rawPrefix === undefined) return undefined;
  if (rawPrefix.length > 1 && rawPrefix.endsWith("/")) return rawPrefix.slice(0, -1);
  return rawPrefix;
};

export const serveStatic = (options: ServeStaticOptions): RouteHandler => {
  if (typeof options.root !== "string" || options.root.length === 0) {
    throw new TypeError("serveStatic({ root }) requires a directory path");
  }
  const indexName = options.index === undefined ? "index.html" : options.index;
  const prefix = stripPrefixOf(options.prefix);
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
    const clean = segments.join("/");
    if (clean.length === 0 && indexName === false) throw createError(404);
    const absolute = resolve(root, clean.length === 0 ? (indexName as string) : clean);
    if (!isWithinRoot(absolute, root, sep)) {
      throw createError(403, "path traversal rejected", { expose: true });
    }

    const { stat, readFile } = nodeFsPromises();
    let info;
    try {
      info = await stat(absolute);
    } catch {
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
        throw createError(404);
      }
    }
    if (options.followSymlinks !== true) {
      // ANY symlink component under root — a linked directory just as much
      // as a linked file — is denied, even when it points back inside root.
      // (root itself may legitimately be a symlink.) The walk covers the
      // FINAL served path (the directory-index resolution included): walking
      // only `absolute` would leave a symlinked <dir>/index.html unexamined
      // exactly when the directory path was requested.
      const link = await findSymlink(root, filePath);
      if (link !== null) {
        throw createError(403, "symlinks are not followed", { expose: true });
      }
    }

    const mime = mimeFromExtension(filePath);
    const etag = weakEtag(info.size, info.mtime.getTime());
    const lastModified = info.mtime.toUTCString();
    const headers: Record<string, string> = {
      etag,
      "last-modified": lastModified,
      "x-content-type-options": "nosniff",
    };
    if (mime !== null) headers["content-type"] = mime;

    // RFC 9110 §13.2.2 via isNotModified: If-None-Match decides when
    // present — a match is a 304, a MISMATCH falls through to the full 200
    // representation (never an empty 200); If-Modified-Since is only
    // consulted without If-None-Match.
    const mtimeMs = info.mtime.getTime();
    if (
      isNotModified({
        etag,
        mtimeMs,
        ifNoneMatch: c.get("if-none-match"),
        ifModifiedSince: c.get("if-modified-since"),
      })
    ) {
      return new Response(null, { status: 304, headers });
    }
    if (bunFile !== null) return new Response(bunFile(filePath), { headers });
    const bytes = await readFile(filePath).catch(() => null);
    if (bytes === null) throw createError(404);
    return new Response(new Uint8Array(bytes), { headers });
  };
};
