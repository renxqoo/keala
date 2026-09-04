// Bisect which import subtree carries keala's extra Node footprint.
// Run: node --expose-gc bench/route-shootout/diag/node-memory-bisect.mjs
const v8 = await import("node:v8");
const MB = 1048576;
const sample = (label) => {
  globalThis.gc();
  const mu = process.memoryUsage();
  const ext = mu.external,
    arr = mu.arrayBuffers;
  const code =
    v8.getHeapSpaceStatistics().find((s) => s.space_name === "code_space")?.physical_space_size ??
    0;
  console.log(
    `${label.padEnd(40)} rss=${(mu.rss / MB).toFixed(1).padStart(6)} heapUsed=${(mu.heapUsed / MB).toFixed(1).padStart(5)} external=${(ext / MB).toFixed(1).padStart(5)} arrayBuffers=${(arr / MB).toFixed(1).padStart(5)} code=${(code / MB).toFixed(1).padStart(5)}`,
  );
};
sample("bare");
await import("hono");
sample("+ hono (module only)");
{
  const { Keala } = await import("../../../src/core/app.ts");
  const app = new Keala({ env: "production" });
  app.get("/x", (c) => c.text("x"));
  sample("+ keala CORE (core/app only)");
}
await import("../../../src/adapters/node.ts");
sample("+ adapters/node");
await import("../../../src/adapters/bun.ts");
sample("+ adapters/bun (root barrel pulls it)");
await import("../../../src/helpers/streams.ts");
sample("+ helpers/streams");
await import("../../../src/helpers/html.ts");
sample("+ helpers/html");
await import("../../../src/helpers/password.ts");
sample("+ helpers/password");
await import("../../../src/context/cookies.ts");
sample("+ context/cookies");
await import("../../../src/index.ts");
sample("+ FULL root barrel (src/index.ts)");
