import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { nodeExecutable } from "../bench/node-runtime.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = (runtime: "node" | "bun") =>
  new Promise<Record<string, unknown>[]>((resolve, reject) => {
    const child = spawn(
      nodeExecutable(),
      ["bench/run-node-hotpaths.mjs", "4", "1", "1", "json-body-safe"],
      {
        cwd: root,
        // Prove the runner overrides an inherited development environment.
        env: {
          ...process.env,
          NODE_ENV: "development",
          KEALA_BENCH_RUNTIME: runtime,
          KEALA_BENCH_PROCESSES: "2",
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
    const timer = setTimeout(() => child.kill("SIGTERM"), 25000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`${runtime} runner failed: ${stderr}`));
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

describe("R4.6 official HTTP comparison protocol", () => {
  it("resolves real Node even when Bun --bun injects a node shim", () => {
    expect(
      execFileSync(nodeExecutable(), ["-p", "process.versions.bun === undefined"], {
        encoding: "utf8",
      }).trim(),
    ).toBe("true");
  });
  for (const runtime of ["node", "bun"] as const) {
    it(`${runtime} validates production fixtures, body/status and emits CPU plus merged counts`, async () => {
      const records = await run(runtime);
      expect(records).toHaveLength(4);
      const metadata = records[0]!;
      expect(metadata).toMatchObject({
        kind: "run",
        schemaVersion: 2,
        runtime,
        nodeEnv: "production",
        processes: 2,
        clientConnections: [2, 2],
        workersPerProcess: 0,
      });
      expect(metadata["harnessSha256"]).toMatch(/^[a-f0-9]{64}$/);
      expect(metadata["dependencies"]).toMatchObject({ autocannon: "8.0.0", hono: "4.13.5" });
      const pids: number[] = [];
      for (const row of records.slice(1, 3)) {
        expect(row["kind"]).toBe("sample");
        expect(row["errors"]).toBe(0);
        expect(row["rps"]).toBeGreaterThan(0);
        expect(row["latency"]).toHaveProperty("totalCount", row["total"]);
        expect(row["beforeMetrics"]).toMatchObject({
          protocol: 2,
          pid: row["pid"],
          env: "production",
          applicationEnv: "production",
          runtime,
        });
        expect(row["serverCpu"]).toHaveProperty("nsPerRequest", expect.any(Number));
        pids.push(row["pid"] as number);
        const clients = row["clients"] as { pid: number; env: string }[];
        expect(clients).toHaveLength(2);
        for (const client of clients) {
          expect(client.env).toBe("production");
          pids.push(client.pid);
        }
      }
      expect(new Set(pids).size).toBe(6);
      for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
      expect(records[3]).toMatchObject({ kind: "summary", runtime, scenario: "json-body-safe" });
    }, 30000);
  }
});
