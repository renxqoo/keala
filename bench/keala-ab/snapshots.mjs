import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Same fingerprint protocol as the earlier migration measurements.
export const sourceHash = async (root) => {
  const hash = createHash("sha256");
  for (const file of (await readdir(join(root, "src"), { recursive: true })).toSorted()) {
    if (file.endsWith(".ts")) hash.update(file).update(await readFile(join(root, "src", file)));
  }
  return hash.digest("hex");
};

export const fileHash = async (file) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");

export const prepareSnapshots = async (root, before, after, output) => {
  const directory = await mkdtemp(join(tmpdir(), "keala-hello-ab-"));
  const snapshots = [];
  for (const [name, source] of [
    ["before", before],
    ["after", after],
  ]) {
    const sourceSha256 = await sourceHash(source);
    const path = join(directory, name);
    await mkdir(join(path, "scripts"), { recursive: true });
    await cp(join(source, "src"), join(path, "src"), { recursive: true });
    // Both versions use identical build configuration, compiler and dependencies.
    for (const file of ["tsconfig.json", "tsconfig.build.json", "scripts/rewrite-imports.mjs"]) {
      await cp(join(root, file), join(path, file));
    }
    await writeFile(join(path, "package.json"), '{"type":"module"}\n');
    await symlink(join(root, "node_modules"), join(path, "node_modules"));
    assert.equal(await sourceHash(path), sourceSha256, `${name} changed while copying`);
    execFileSync(join(root, "node_modules/.bin/tsc"), ["-p", join(path, "tsconfig.build.json")], {
      cwd: path,
      stdio: "pipe",
    });
    execFileSync(process.execPath, [join(path, "scripts/rewrite-imports.mjs")], {
      cwd: path,
      stdio: "pipe",
    });
    const archive = join(output, `${name}-source.tar.gz`);
    await writeFile(archive, new Uint8Array(), { flag: "wx" });
    execFileSync("tar", [
      "-czf",
      archive,
      "-C",
      path,
      "src",
      "tsconfig.json",
      "tsconfig.build.json",
      "package.json",
      "scripts/rewrite-imports.mjs",
    ]);
    snapshots.push({
      name,
      original: resolve(source),
      path,
      sourceSha256,
      archive,
      archiveSha256: await fileHash(archive),
    });
  }
  assert.notEqual(
    snapshots[0].sourceSha256,
    snapshots[1].sourceSha256,
    "before and after are identical",
  );
  return snapshots;
};
