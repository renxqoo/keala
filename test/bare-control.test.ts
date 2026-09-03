import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { nodeExecutable } from "../bench/node-runtime.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

const runWithControls = (runtime: "node" | "bun") =>
  new Promise<Record<string, unknown>[]>((resolve, reject) => {
    const child = spawn(
      nodeExecutable(),
      ["bench/run-node-hotpaths.mjs", "4", "1", "1", "json-body-safe"],
      {
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
      },
    );
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
        reject(new Error(`${runtime} controls runner failed: ${stderr}`));
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

describe("R4.7 bare-runtime control fixtures", () => {
  for (const runtime of ["node", "bun"] as const) {
    it(`${runtime} control joins the rotation and honors measurement protocol 2`, async () => {
      const records = await runWithControls(runtime);
      expect(records).toHaveLength(5);
      expect(records[0]).toMatchObject({ kind: "run", runtime, nodeEnv: "production" });
      const bare = records[3]!;
      expect(bare).toMatchObject({
        kind: "sample",
        server: "bare",
        scenario: "json-body-safe",
        errors: 0,
        runtime,
      });
      // The runner's internal verify already asserted 200/400/413 bodies,
      // headers and framing for the bare server before and after the load.
      expect(bare["beforeMetrics"]).toMatchObject({
        protocol: 2,
        pid: bare["pid"],
        env: "production",
        applicationEnv: "production",
        runtime,
      });
      expect(bare["serverCpu"]).toHaveProperty("nsPerRequest", expect.any(Number));
      expect(bare["latency"]).toHaveProperty("totalCount", bare["total"]);
      const summary = records[4]!;
      expect(summary).toMatchObject({ kind: "summary", runtime, scenario: "json-body-safe" });
      expect(Object.keys(summary["cpu"] as Record<string, unknown>)).toEqual([
        "keala",
        "hono-official",
        "bare",
      ]);
    }, 60000);
  }
});
