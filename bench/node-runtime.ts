import { execFileSync } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";

let resolved: string | undefined;

/** Bun --bun puts a Bun-backed `node` shim first in PATH. Require real Node. */
export const nodeExecutable = (): string => {
  if (resolved !== undefined) return resolved;
  if (process.versions["bun"] === undefined) return (resolved = process.execPath);
  const current = realpathSync(process.execPath);
  const seen = new Set<string>();
  for (const directory of (process.env["PATH"] ?? "").split(delimiter)) {
    if (directory === "") continue;
    try {
      const candidate = realpathSync(
        join(directory, process.platform === "win32" ? "node.exe" : "node"),
      );
      if (candidate === current || seen.has(candidate)) continue;
      seen.add(candidate);
      accessSync(candidate, constants.X_OK);
      const identity = execFileSync(
        candidate,
        ["-p", "process.versions.bun === undefined && process.release.name === 'node'"],
        { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      if (identity === "true") return (resolved = candidate);
    } catch {
      // Absent executables and runtime shims are not Node candidates.
    }
  }
  throw new Error(
    "measurement requires a real Node executable in PATH; Bun's node shim is not supported",
  );
};
