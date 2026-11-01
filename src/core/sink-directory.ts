/** Registration-time safety audit for Bun directory routes. */
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
