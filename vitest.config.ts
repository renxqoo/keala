import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Several files contain in-process CPU/retained-heap regression fences.
    // Bun workers share one VM/GC domain, so parallel files can charge an
    // unrelated worker's JIT or full-GC cycle to one side of an A/B window.
    // Serialize files to make those gates deterministic; individual tests
    // still exercise explicit request concurrency where the contract needs it.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/types.ts"],
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 90,
      },
    },
  },
});
