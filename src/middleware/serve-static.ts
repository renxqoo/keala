/**
 * serveStatic — file responses with the security ordering from the audit:
 * segment → decode-per-segment → normalize → containment check, null-byte
 * rejection, empty-segment refusal, GET/HEAD-only methods, symlink denial
 * (opt-in via lstat), nosniff, weak ETag + Last-Modified/304.
 *
 * Splitting the RAW path on "/" before any decoding is what closes the
 * path-confusion bypass: an escaped `%2F` (or `%5C` on Windows) decodes to a
 * literal character INSIDE one segment and can never re-introduce a
 * separator the router never saw — a guard at `/guarded/*` therefore cannot
 * be sidestepped with `/guarded%2Fsecret`. The fs/path bridges load with
 * the FIRST request — importing this middleware costs nothing at idle.
 */

import { createError } from "../http/errors.ts";
import type { RouteHandler } from "../router/router.ts";
import { nodeFsPromises, nodePath } from "../utils/node-lazy.ts";
import { mimeFromExtension } from "../utils/mime.ts";
import { decodeSegment } from "../router/pattern.ts";

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
 * Resolve a RAW (still-encoded) request path into safe file segments.
 * Returns null for ambiguous paths (empty interior segments — `//x`, `a//b`)
 * which must be refused rather than collapsed: collapsing them would let a
 * path the router never routed reach the filesystem.
 *
 * Exported for cross-platform tests. `windowsSeparators` decides whether a
 * decoded `\` splits within a segment (on Windows it is a filesystem
 * separator; everywhere else it is an ordinary filename character).
 */
export const resolveRelativeSegments = (
  rawPath: string,
  windowsSeparators: boolean,
): string[] | null => {
  const parts = rawPath.split("/");
  parts.shift(); // the leading "" before "/"
  if (parts.length === 1 && (parts[0] ?? "") === "") parts.length = 0;
  else if (parts.length > 0 && parts[parts.length - 1] === "") parts.length--; // trailing "/"
  const segments: string[] = [];
  for (const part of parts) {
    if (part.length === 0) return null;
    const decoded = decodeSegment(part); // malformed escapes stay verbatim
    // A decoded separator is impossible in a real filename — carrying it
    // would re-introduce a separator the router never saw (%2F, %5C on
    // Windows). Refuse instead of resolving. On POSIX a backslash is an
    // ordinary filename character and stays one.
    if (decoded.includes("/") || (windowsSeparators && decoded.includes("\\"))) return null;
    if (decoded === ".") continue;
    if (decoded === "..") {
      segments.pop();
      continue;
    }
    segments.push(decoded);
  }
  return segments;
};

/** `absolute` is inside `root` (or IS root), compared with the host separator. */
export const isWithinRoot = (absolute: string, root: string, sep: string): boolean =>
  absolute === root || absolute.startsWith(`${root}${sep}`);

export const serveStatic = (options: ServeStaticOptions): RouteHandler => {
  if (typeof options.root !== "string" || options.root.length === 0) {
    throw new TypeError("serveStatic({ root }) requires a directory path");
  }
  const indexName = options.index === undefined ? "index.html" : options.index;
  // Resolved on the first request — keeps the path bridge out of setup.
  let rootCache: string | null = null;

  return async (c, next) => {
    // Static files answer GET/HEAD only — anything else falls through
    // (koa-static/express behavior; POST returning file content surprises
    // caches and CSRF assumptions).
    if (c.method !== "GET" && c.method !== "HEAD") return next();
    const { resolve, sep } = nodePath();
    const root = (rootCache ??= resolve(options.root));
    const relative =
      options.prefix !== undefined && c.path.startsWith(options.prefix)
        ? c.path.slice(options.prefix.length)
        : c.path;
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

    const { stat, lstat, readFile } = nodeFsPromises();
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
      // (root itself may legitimately be a symlink.)
      const parts = absolute.slice(root.length + 1).split(sep === "\\" ? /[\\/]/ : "/");
      let walked = root;
      for (const part of parts) {
        walked = `${walked}${sep}${part}`;
        const link = await lstat(walked).catch(() => null);
        if (link === null) throw createError(404);
        if (link.isSymbolicLink()) {
          throw createError(403, "symlinks are not followed", { expose: true });
        }
      }
    }

    const mime = mimeFromExtension(filePath);
    const etag = `W/"${info.size.toString(16)}-${info.mtime.getTime().toString(16)}"`;
    const lastModified = info.mtime.toUTCString();
    const headers: Record<string, string> = {
      etag,
      "last-modified": lastModified,
      "x-content-type-options": "nosniff",
    };
    if (mime !== null) headers["content-type"] = mime;

    // RFC 9110: If-None-Match decides when present — a mismatch serves 200
    // (If-Modified-Since is only consulted without it); "*" matches anything.
    const ifNone = c.get("if-none-match");
    if (ifNone.length > 0) {
      const matched =
        ifNone.trim() === "*" ||
        ifNone
          .split(",")
          .some((candidate) => candidate.trim().replace(/^W\//, "") === etag.slice(2));
      return new Response(null, { status: matched ? 304 : 200, headers });
    }
    const ifModified = c.get("if-modified-since");
    if (ifModified.length > 0 && Date.parse(ifModified) >= info.mtime.getTime() - 999) {
      return new Response(null, { status: 304, headers });
    }
    if (bunFile !== null) return new Response(bunFile(filePath), { headers });
    const bytes = await readFile(filePath).catch(() => null);
    if (bytes === null) throw createError(404);
    return new Response(new Uint8Array(bytes), { headers });
  };
};
