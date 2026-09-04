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

import { createRequire } from "node:module";

import { nodeFsPromises, nodePath } from "./node-lazy.ts";
import { decodeSegment } from "../router/pattern.ts";

// Sync-lazy node:fs — for consumers that must not pay fs/promises' promise
// machinery on hot paths: on Bun 1.4 the promises compat layer costs
// ~23µs per stat call (probe-verified) against ~1µs for the native sync
// call, which is an entire static-file request budget. node-lazy.ts's
// public surface stays promises-only by design; this is the sync sibling,
// same createRequire discipline (nothing loads until a caller needs it).
const requireFs = createRequire(import.meta.url);
let fsSyncModule: typeof import("node:fs") | undefined;
export const nodeFsSync = (): typeof import("node:fs") =>
  (fsSyncModule ??= requireFs("node:fs") as typeof import("node:fs"));

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
 *
 * Threat-model boundary (SEC-4, documented rather than "fixed"): this audit
 * and the caller's stat/read are SEPARATE filesystem operations, so an
 * attacker with local write access to the tree can swap a clean component
 * for a symlink inside the window between the lstat and the open (classic
 * TOCTOU). The audit denies the standing threat — symlinked trees planted
 * at build time or by a malicious dependency — which is the realistic
 * deployment surface; closing the race itself needs O_NOFOLLOW/openat-style
 * component-wise opens that neither Bun.file nor the buffered readFile path
 * can express (PARITY.md, security boundary note). A post-read realpath
 * re-check was considered and rejected: Bun.file is opened by the runtime
 * AFTER this handler returns, so a pre-return realpath proves nothing about
 * the served fd, and on the buffered Node path it would cost a second full
 * walk per request while leaving the same window around the final open.
 */
export const findSymlink = async (root: string, filePath: string): Promise<string | null> => {
  const { lstat } = nodeFsPromises();
  const sep = nodePath().sep;
  const parts = filePath.slice(root.length + 1).split(sep === "\\" ? /[\\/]/ : "/");
  let walked = root;
  for (const part of parts) {
    walked = `${walked}${sep}${part}`;
    // try/catch instead of .catch(): same semantics, one promise allocation
    // less per component on the (overwhelmingly common) success path.
    let link: Awaited<ReturnType<typeof lstat>> | null = null;
    try {
      link = await lstat(walked);
    } catch {
      link = null;
    }
    if (link?.isSymbolicLink() === true) return walked;
  }
  return null;
};

/**
 * Synchronous twin of findSymlink for Bun's lean static path: identical
 * verdicts (same component walk, same exemptions), lstatSync underneath —
 * on Bun 1.4 a promise-based lstat costs ~23µs per call against ~1µs
 * synchronous (see nodeFsSync above). A vanished component is not a symlink
 * (the caller's own stat/read fails into its 404).
 */
export const findSymlinkSync = (root: string, filePath: string): string | null => {
  const { lstatSync } = nodeFsSync();
  const sep = nodePath().sep;
  const parts = filePath.slice(root.length + 1).split(sep === "\\" ? /[\\/]/ : "/");
  let walked = root;
  for (const part of parts) {
    walked = `${walked}${sep}${part}`;
    let link: ReturnType<typeof lstatSync> | null = null;
    try {
      link = lstatSync(walked);
    } catch {
      link = null;
    }
    if (link?.isSymbolicLink() === true) return walked;
  }
  return null;
};
