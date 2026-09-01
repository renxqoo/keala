/**
 * Path-safety primitives — the raw-path segmentation, root containment and
 * symlink audit behind serveStatic's file resolution (DOGFOOD-R1 C2 moved
 * them out of the middleware so file-backed products consume one audited
 * implementation instead of re-deriving it).
 *
 * The security ordering is the contract: split the RAW path on "/" BEFORE any
 * decoding, decode each segment independently, and refuse a decoded separator
 * — an escaped `%2F` (or `%5C` on Windows) then decodes to a literal
 * character INSIDE one segment and can never re-introduce a separator the
 * router never saw.
 */

import { nodeFsPromises, nodePath } from "./node-lazy.ts";
import { decodeSegment } from "../router/pattern.ts";

/**
 * Resolve a RAW (still-encoded) request path into safe file segments.
 * Returns null for ambiguous paths (empty interior segments — `//x`, `a//b`)
 * which must be refused rather than collapsed: collapsing them would let a
 * path the router never routed reach the filesystem.
 *
 * `windowsSeparators` decides whether a decoded `\` splits within a segment
 * (on Windows it is a filesystem separator; everywhere else it is an ordinary
 * filename character).
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

/**
 * First symlinked component under root (a linked directory just as much as a
 * linked file, even pointing back inside root), or null. Root itself may be
 * a symlink — it is the trust boundary and is not walked; components that
 * vanish mid-walk are not symlinks (the caller's read fails into its own
 * 404). `filePath` must be under `root` with the host separator.
 */
export const findSymlink = async (root: string, filePath: string): Promise<string | null> => {
  const { lstat } = nodeFsPromises();
  const sep = nodePath().sep;
  const parts = filePath.slice(root.length + 1).split(sep === "\\" ? /[\\/]/ : "/");
  let walked = root;
  for (const part of parts) {
    walked = `${walked}${sep}${part}`;
    const link = await lstat(walked).catch(() => null);
    if (link?.isSymbolicLink() === true) return walked;
  }
  return null;
};
