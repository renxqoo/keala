import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const verifyKernelReady = (framework, ready, root) => {
  if (!framework.startsWith("kernel")) return;
  assert.equal(ready.kernelEntry, pathToFileURL(join(root, "kernel/kernel.js")).href);
  assert.equal(ready.routerStrategy, framework === "kernel-regexp" ? "regexp" : "trie");
};

export const dependencyVersions = async (root) => {
  const paths = {
    keala: "package.json",
    hono: "node_modules/hono/package.json",
    h3: "node_modules/h3/package.json",
    honoNode: "node_modules/@hono/node-server/package.json",
    srvx: "node_modules/srvx/package.json",
    autocannon: "node_modules/autocannon/package.json",
  };
  return Object.fromEntries(
    await Promise.all(
      Object.entries(paths).map(async ([key, file]) => [
        key,
        JSON.parse(await readFile(join(root, file), "utf8")).version,
      ]),
    ),
  );
};

/** Validate packaged executables before spawning any benchmark processes. */
export const verifyArtifacts = async (root, manifest, env, versions) => {
  if (manifest.nativeText) {
    assert.equal(manifest.nativeText.binary, "native-uws/uws_linux_x64_147.node");
    assert.equal(versions.modules, manifest.nativeText.nodeAbi);
    assert.equal(
      createHash("sha256")
        .update(await readFile(join(root, manifest.nativeText.binary)))
        .digest("hex"),
      manifest.nativeText.binarySha256,
    );
  }
  if (env.BENCH_NATIVE_CLIENT) {
    assert.equal(
      createHash("sha256")
        .update(await readFile(env.BENCH_NATIVE_CLIENT))
        .digest("hex"),
      manifest.nativeClient?.binarySha256,
      "native client differs from the packaged manifest",
    );
  }
};
