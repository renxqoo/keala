/**
 * serveStatic — file responses with the security ordering from the audit:
 * decode → normalize → containment check, null-byte rejection, symlink
 * denial (opt-in via lstat), nosniff, weak ETag + Last-Modified/304.
 */

import { lstat, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createError } from "../http/errors.ts";
import type { RouteHandler } from "../router/router.ts";
import { mimeFromExtension } from "../utils/mime.ts";

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

export const serveStatic = (options: ServeStaticOptions): RouteHandler => {
  if (typeof options.root !== "string" || options.root.length === 0) {
    throw new TypeError("serveStatic({ root }) requires a directory path");
  }
  const root = resolve(options.root);
  const indexName = options.index === undefined ? "index.html" : options.index;

  return async (c) => {
    const relative =
      options.prefix !== undefined && c.path.startsWith(options.prefix)
        ? c.path.slice(options.prefix.length)
        : c.path;
    if (relative.includes("\0")) {
      throw createError(400, "null byte in path", { expose: true });
    }
    // decode → normalize; traversal collapses INSIDE the request path, but the
    // resolved absolute path must still stay under root (defense in depth).
    let decoded: string;
    try {
      decoded = decodeURIComponent(relative);
    } catch {
      decoded = relative;
    }
    const segments: string[] = [];
    for (const part of decoded.split("/")) {
      if (part.length === 0 || part === ".") continue;
      if (part === "..") {
        segments.pop();
        continue;
      }
      segments.push(part);
    }
    if (segments.some((s) => s.includes("\0"))) {
      throw createError(400, "null byte in path", { expose: true });
    }
    const clean = segments.join("/");
    if (clean.length === 0 && indexName === false) throw createError(404);
    const absolute = resolve(root, clean.length === 0 ? (indexName as string) : clean);
    if (absolute !== root && !absolute.startsWith(`${root}/`)) {
      throw createError(403, "path traversal rejected", { expose: true });
    }

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
      if (filePath !== root && !filePath.startsWith(`${root}/`)) {
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
      const parts = absolute.slice(root.length + 1).split("/");
      let walked = root;
      for (const part of parts) {
        walked = `${walked}/${part}`;
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
    const bytes = await readFile(filePath).catch(() => null);
    if (bytes === null) throw createError(404);
    return new Response(new Uint8Array(bytes), { headers });
  };
};
