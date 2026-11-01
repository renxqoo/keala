// Run locally after npm run build. Copy installed, pinned JS dependencies only.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceHash } from "../keala-ab/snapshots.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = resolve(process.argv[2]);
assert(!output.startsWith(root), "package outside the checkout");
await mkdir(output, { recursive: false });
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const copied = new Map();
const locate = async (name, from) => {
  for (let at = from; ; at = dirname(at)) {
    try {
      return await realpath(join(at, "node_modules", name));
    } catch {}
    if (at === dirname(at)) return;
  }
};
const copyDependency = async (name, from, optional = false) => {
  const source = await locate(name, from);
  if (!source) {
    assert(optional, `missing installed dependency ${name}`);
    return;
  }
  const previous = copied.get(name);
  assert(!previous || previous.source === source, `nested dependency collision: ${name}`);
  if (previous) return;
  const pkg = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  copied.set(name, { source, version: pkg.version });
  await cp(source, join(output, "node_modules", name), {
    recursive: true,
    dereference: true,
    filter: (path) =>
      path === source ||
      !path
        .slice(source.length + 1)
        .split("/")
        .includes("node_modules"),
  });
  for (const dep of Object.keys(pkg.dependencies ?? {})) await copyDependency(dep, source);
  for (const dep of Object.keys(pkg.optionalDependencies ?? {}))
    await copyDependency(dep, source, true);
  for (const dep of Object.keys(pkg.peerDependencies ?? {}))
    await copyDependency(dep, source, true);
};
for (const path of [
  "package.json",
  "dist",
  "bench/load-pool.ts",
  "bench/load-metrics.ts",
  "bench/node-runtime.ts",
  "bench/load-worker.mjs",
  "bench/framework-compare/server.mjs",
  "bench/framework-compare/scenarios.mjs",
  "bench/framework-compare/report.mjs",
  "bench/framework-compare/remote-run.mjs",
  "bench/framework-compare/remote-artifacts.mjs",
  "bench/framework-compare/remote-matrix.ts",
])
  await cp(join(root, path), join(output, path), { recursive: true });
for (const name of ["hono", "@hono/node-server", "h3", "srvx", "autocannon"])
  await copyDependency(name, root);
const nativeClient = process.env.BENCH_NATIVE_CLIENT;
if (nativeClient) {
  await cp(join(root, "bench/native-load.mjs"), join(output, "bench/native-load.mjs"));
  await cp(join(root, "bench/native-load/client.go"), join(output, "bench/native-load/client.go"));
  await mkdir(join(output, "runtime"), { recursive: true });
  await cp(resolve(nativeClient), join(output, "runtime/native-client"));
}
const kernelDist = process.env.BENCH_KERNEL_DIST;
if (kernelDist) await cp(resolve(kernelDist), join(output, "kernel"), { recursive: true });
const nativeTextDir = process.env.BENCH_NATIVE_TEXT_DIR;
if (nativeTextDir) {
  assert(kernelDist, "native text probe requires a compiled Kernel");
  await cp(
    join(root, "bench/framework-compare/native-text.mjs"),
    join(output, "bench/framework-compare/native-text.mjs"),
  );
  await mkdir(join(output, "native-uws"));
  for (const file of [
    "package.json",
    "LICENSE",
    "uws.js",
    "ESM_wrapper.mjs",
    "index.d.ts",
    "uws_linux_x64_147.node",
    "provenance.json",
  ])
    await cp(join(resolve(nativeTextDir), file), join(output, "native-uws", file));
}
const treeHash = async (directory, hash = createHash("sha256"), prefix = "") => {
  for (const entry of (await readdir(directory, { withFileTypes: true })).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) await treeHash(join(directory, entry.name), hash, relative + "/");
    else
      hash
        .update(relative)
        .update("\0")
        .update(await readFile(join(directory, entry.name)))
        .update("\0");
  }
  return hash;
};
const manifest = {
  packagedAt: new Date().toISOString(),
  commit: git("rev-parse", "HEAD"),
  dirtyFiles: git("status", "--porcelain").split("\n").filter(Boolean),
  distSha256: (await treeHash(join(output, "dist"))).digest("hex"),
  sourceSha256: await sourceHash(root),
  harnessSha256: (await treeHash(join(output, "bench"))).digest("hex"),
  dependencies: Object.fromEntries([...copied].map(([name, value]) => [name, value.version])),
};
if (nativeTextDir) {
  const pkg = JSON.parse(await readFile(join(output, "native-uws/package.json"), "utf8"));
  assert.equal(pkg.version, "20.67.0");
  manifest.nativeText = {
    version: pkg.version,
    nodeAbi: "147",
    target: "linux-x64",
    api: "synchronous text engine probe; no Fetch/middleware/async or graceful drain",
    binary: "native-uws/uws_linux_x64_147.node",
    binarySha256: createHash("sha256")
      .update(await readFile(join(output, "native-uws/uws_linux_x64_147.node")))
      .digest("hex"),
    packageSha256: (await treeHash(join(output, "native-uws"))).digest("hex"),
  };
}
if (kernelDist)
  manifest.kernel = {
    sourceSha256: (await treeHash(join(root, "experimental/kernel"))).digest("hex"),
    distSha256: (await treeHash(join(output, "kernel"))).digest("hex"),
    api: "experimental-kernel-explicit-text-capability",
    routerCandidates: ["trie", "regexp"],
    extensions: "no Context; no srvx Request runtime/ip/waitUntil extensions",
  };
if (nativeClient) {
  manifest.nativeClient = {
    binarySha256: createHash("sha256")
      .update(await readFile(resolve(nativeClient)))
      .digest("hex"),
    sourceSha256: createHash("sha256")
      .update(await readFile(join(root, "bench/native-load/client.go")))
      .digest("hex"),
  };
}
if (process.argv[3]) {
  const before = resolve(process.argv[3]);
  await cp(join(before, "dist"), join(output, "before/dist"), { recursive: true });
  await cp(join(before, "package.json"), join(output, "before/package.json"));
  manifest.before = {
    sourceSha256: await sourceHash(before),
    distSha256: (await treeHash(join(output, "before/dist"))).digest("hex"),
  };
}
await writeFile(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`Packaged ${copied.size} pinned dependencies and compiled Keala at ${output}`);
