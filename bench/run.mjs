// Benchmark orchestrator: spawns each server, drives load with autocannon,
// samples latency and memory, aggregates medians and writes bench/BENCH.md.
//
// Usage: node bench/run.mjs [connections] [durationSeconds]
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import autocannon from "autocannon";

const CONNECTIONS = Number(process.argv[2] ?? 100);
const DURATION = Number(process.argv[3] ?? 8);
const RUNS = 3;

const SERVERS = [
  { name: "raw Bun.serve (bun 1.4)", cmd: ["bun", "bench/server-raw.ts"], port: 4104 },
  { name: "bun-koa (bun 1.4)", cmd: ["bun", "bench/server-bun-koa.ts"], port: 4103 },
  { name: "hono 4 (bun 1.4)", cmd: ["bun", "bench/server-hono.ts"], port: 4102 },
  { name: "koa 3 (node 22)", cmd: ["node", "bench/server-koa.mjs"], port: 4101 },
  { name: "fastify 5 (node 22)", cmd: ["node", "bench/server-fastify.mjs"], port: 4105 },
  { name: "koa 3 (bun 1.4)", cmd: ["bun", "bench/server-koa.mjs"], port: 4106 },
  { name: "fastify 5 (bun 1.4)", cmd: ["bun", "bench/server-fastify.mjs"], port: 4107 },
];

const SCENARIOS = [
  { label: "Text response", path: "/text" },
  { label: "JSON response", path: "/json" },
  { label: "Param route", path: "/users/12345" },
  { label: "3 middlewares", path: "/mw" },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitReady = async (port) => {
  for (let i = 0; i < 150; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/text`);
      if (res.ok) return;
    } catch {
      // retry
    }
    await sleep(100);
  }
  throw new Error(`server on ${port} never became ready`);
};

const sampleMemory = async (port) => {
  const res = await fetch(`http://127.0.0.1:${port}/debug/memory`);
  return await res.json();
};

const fire = (url) =>
  autocannon({
    url,
    connections: CONNECTIONS,
    duration: DURATION,
    pipelining: 1,
    warmup: { connections: CONNECTIONS, duration: 2 },
  });

const median = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? sorted[0];
};

const fmtBytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;

/** Periodically sample server memory until `stop.done` flips. */
const trackPeak = async (port, stop) => {
  let peak = { rss: 0, heapUsed: 0 };
  while (!stop.done) {
    try {
      const mu = await sampleMemory(port);
      if (mu.rss > peak.rss) peak = mu;
    } catch {
      // server busy — skip this sample
    }
    await sleep(500);
  }
  return peak;
};

const main = async () => {
  const throughput = [];
  const latency = [];
  const memory = [];

  for (const instance of SERVERS) {
    const child = spawn(instance.cmd[0], [...instance.cmd.slice(1), String(instance.port)], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    try {
      await waitReady(instance.port);
      await sleep(400);
      const idle = await sampleMemory(instance.port);

      for (const scenario of SCENARIOS) {
        await fetch(`http://127.0.0.1:${instance.port}${scenario.path}`).then((r) => r.text());
      }
      const beforeSteady = await sampleMemory(instance.port);

      const peaks = [];
      for (const scenario of SCENARIOS) {
        const rpsRuns = [];
        const p50Runs = [];
        const p99Runs = [];
        for (let run = 0; run < RUNS; run++) {
          const stop = { done: false };
          const peakPromise = trackPeak(instance.port, stop);
          const result = await fire(`http://127.0.0.1:${instance.port}${scenario.path}`);
          stop.done = true;
          const peak = await peakPromise;
          peaks.push(peak);
          rpsRuns.push(result.requests.average);
          p50Runs.push(result.latency.p50 ?? result.latency.average);
          p99Runs.push(result.latency.p99 ?? result.latency.max);
        }
        throughput.push({
          server: instance.name,
          scenario: scenario.label,
          rps: Math.round(median(rpsRuns)),
        });
        latency.push({
          server: instance.name,
          scenario: scenario.label,
          p50: median(p50Runs),
          p99: median(p99Runs),
        });
      }

      const afterSteady = await sampleMemory(instance.port);
      memory.push({
        server: instance.name,
        idle,
        steady: afterSteady,
        peak: peaks.reduce(
          (acc, mu) => ({
            rss: Math.max(acc.rss, mu.rss),
            heapUsed: Math.max(acc.heapUsed, mu.heapUsed),
          }),
          { rss: idle.rss, heapUsed: idle.heapUsed },
        ),
      });
      void beforeSteady;
    } finally {
      child.kill("SIGKILL");
      await sleep(200);
    }
  }

  const lines = [];
  lines.push("# bun-koa performance report", "");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("- Load tool: autocannon");
  lines.push(
    `- Connections: ${CONNECTIONS}, duration: ${DURATION}s per run, median of ${RUNS} runs`,
  );
  lines.push("- Runtimes: Bun 1.4 (raw / bun-koa / hono) vs Node.js 22 (koa / fastify)");
  lines.push("- Loopback HTTP/1.1 keep-alive; identical response shapes on every framework");
  lines.push("");

  const byScenario = new Map();
  for (const row of throughput) {
    const list = byScenario.get(row.scenario) ?? [];
    list.push(row);
    byScenario.set(row.scenario, list);
  }
  for (const [scenario, entries] of byScenario) {
    lines.push(`## ${scenario}`, "");
    lines.push("| Framework | Runtime | req/s |");
    lines.push("| --- | --- | ---: |");
    for (const entry of entries) {
      lines.push(
        `| ${entry.server.split(" (")[0]} | ${entry.server.match(/\((.*)\)/)?.[1] ?? ""} | ${entry.rps.toLocaleString("en-US")} |`,
      );
    }
    const ours = entries.find((e) => e.server.startsWith("bun-koa"));
    for (const other of ["koa 3", "fastify 5", "hono 4", "raw Bun"]) {
      const ref = entries.find((e) => e.server.startsWith(other));
      if (ours && ref && ref !== ours) {
        lines.push(`- bun-koa vs ${other}: **${(ours.rps / ref.rps).toFixed(2)}x**`);
      }
    }
    lines.push("");
  }

  lines.push("## Latency under load (median of runs)", "");
  lines.push("| Framework | scenario | p50 (ms) | p99 (ms) |");
  lines.push("| --- | --- | ---: | ---: |");
  for (const row of latency) {
    lines.push(
      `| ${row.server.split(" (")[0]} | ${row.scenario} | ${row.p50.toFixed(1)} | ${row.p99.toFixed(1)} |`,
    );
  }
  lines.push("");

  lines.push("## Memory footprint (sampled via /debug/memory)", "");
  lines.push("| Framework | idle RSS | steady RSS | peak RSS | idle heap | steady heap |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: |");
  for (const row of memory) {
    lines.push(
      `| ${row.server.split(" (")[0]} | ${fmtBytes(row.idle.rss)} | ${fmtBytes(row.steady.rss)} | ${fmtBytes(row.peak.rss)} | ${fmtBytes(row.idle.heapUsed)} | ${fmtBytes(row.steady.heapUsed)} |`,
    );
  }
  lines.push("");

  const analysis = await readFile(new URL("./analysis.md", import.meta.url), "utf8").catch(
    () => "",
  );
  await writeFile(new URL("./BENCH.md", import.meta.url), lines.join("\n") + analysis, "utf8");
  console.log("\nWrote bench/BENCH.md");
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
