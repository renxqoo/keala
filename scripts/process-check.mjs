/**
 * Real child-process matrix: Bun/Node × source/published artifact.
 * Run after `npm run build` so the dist legs validate what npm publishes.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:net";

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });

const waitUntilReady = async (base, child) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`child exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return;
    } catch {
      // The child has not bound its socket yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("child did not become ready");
};

const verifySource = async (base) => {
  const response = await fetch(`${base}/health`);
  if (response.status !== 200 || (await response.text()) !== "ok") {
    throw new Error("source health response mismatch");
  }
};

const verifyArtifact = async (base) => {
  const health = await fetch(`${base}/health`);
  if (
    health.status !== 200 ||
    (await health.text()) !== "ok" ||
    !/^text\/plain/i.test(health.headers.get("content-type") ?? "") ||
    health.headers.get("x-artifact") !== "dist"
  ) {
    throw new Error("artifact text/header response mismatch");
  }

  const param = await fetch(`${base}/users/42`);
  if (param.status !== 200 || (await param.json()).id !== "42") {
    throw new Error("artifact dynamic route mismatch");
  }

  const echo = await fetch(`${base}/echo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"safe":true}',
  });
  if (echo.status !== 200 || (await echo.json()).safe !== true) {
    throw new Error("artifact bounded JSON response mismatch");
  }

  const oversized = await fetch(`${base}/echo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"payload":"0123456789"}',
  });
  if (oversized.status !== 413) throw new Error("artifact body budget was not enforced");
};

const matrix = [
  {
    name: "Bun source",
    command: "bun",
    args: (port) => ["examples/app.ts", String(port)],
    verify: verifySource,
  },
  {
    name: "Node source",
    command: "node",
    args: (port) => ["--experimental-strip-types", "examples/app-node.ts", String(port)],
    verify: verifySource,
  },
  {
    name: "Bun dist",
    command: "bun",
    args: (port) => ["scripts/artifact-server.mjs", String(port)],
    verify: verifyArtifact,
  },
  {
    name: "Node dist",
    command: "node",
    args: (port) => ["scripts/artifact-server.mjs", String(port)],
    verify: verifyArtifact,
  },
];

for (const entry of matrix) {
  const port = await freePort();
  const child = spawn(entry.command, entry.args(port), {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => (stderr += chunk));
  try {
    const base = `http://127.0.0.1:${port}`;
    await waitUntilReady(base, child);
    await entry.verify(base);
    console.log(`  ✓ ${entry.name}`);
  } catch (error) {
    const detail = stderr.trim();
    throw new Error(`${entry.name}: ${error.message}${detail ? `\n${detail}` : ""}`, {
      cause: error,
    });
  } finally {
    child.kill("SIGKILL");
  }
}

console.log("PROCESS CHECK OK");
