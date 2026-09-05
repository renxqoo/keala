import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { nodeExecutable } from "../../bench/node-runtime.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));

const runQueryScenario = (runtime: "node" | "bun") =>
  new Promise<Record<string, unknown>[]>((resolve, reject) => {
    const child = spawn(nodeExecutable(), ["bench/run-node-hotpaths.mjs", "4", "1", "1", "query"], {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: "development",
        KEALA_BENCH_RUNTIME: runtime,
        KEALA_BENCH_PROCESSES: "2",
        KEALA_BENCH_CONTROLS: "1",
        KEALA_BENCH_OUTPUT: undefined,
        KEALA_BENCH_BASELINE: undefined,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), 40000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`${runtime} query runner failed: ${stderr}`));
        return;
      }
      try {
        resolve(
          stdout
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as Record<string, unknown>),
        );
      } catch (error) {
        reject(error);
      }
    });
  });

describe("R4.7 query scenario (param + query reads + staged header)", () => {
  for (const runtime of ["node", "bun"] as const) {
    it(`${runtime} verifies the interpolated body and x-query header for every server`, async () => {
      const records = await runQueryScenario(runtime);
      // run + keala/hono/bare samples + summary, controls enabled.
      expect(records).toHaveLength(5);
      expect(records[0]).toMatchObject({ kind: "run", runtime, nodeEnv: "production" });
      const servers = ["keala", "hono-official", "bare"];
      for (const [index, name] of servers.entries()) {
        // The runner's internal verify already asserted the exact body
        // ("12345 keala 3"), content-type and the x-query header before and
        // after the load window for this server.
        expect(records[index + 1]).toMatchObject({
          kind: "sample",
          server: name,
          scenario: "query",
          errors: 0,
          runtime,
        });
      }
      expect(records[4]).toMatchObject({ kind: "summary", runtime, scenario: "query" });
      expect(Object.keys(records[4]!["cpu"] as Record<string, unknown>)).toEqual(servers);
    }, 60000);
  }
});
