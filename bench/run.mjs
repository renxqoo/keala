// Benchmark orchestrator — ABAB-INTERLEAVED methodology.
//
// All servers are spawned up front. Within each scenario, every server fires
// once per round in ROTATING order (round r starts at server r), so no
// framework is systematically measured first or last. Sequential per-server
// measurement (the previous methodology) showed order bias of up to ±25% on
// per-scenario ratios — see bench/analysis.md.
//
// Usage: node bench/run.mjs [connections] [durationSeconds]
import { execSync, spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import autocannon from "autocannon";

// Server labels derive the runtime versions from the actual binaries, so
// the report never claims a runtime it did not use.
const NODE_LABEL = `node ${process.versions.node.split(".")[0]}`;
const BUN_LABEL = `bun ${execSync("bun --version", { encoding: "utf8" }).trim()}`;

const CONNECTIONS = Number(process.argv[2] ?? 200);
const DURATION = Number(process.argv[3] ?? 8);
const ROUNDS = 4;

const SERVERS = [
  { name: "raw Bun.serve (bun 1.4)", cmd: ["bun", "bench/server-raw.ts"], port: 4104 },
  { name: "bun-koa (bun 1.4)", cmd: ["bun", "bench/server-bun-koa.ts"], port: 4103 },
  { name: "hono 4 (bun 1.4)", cmd: ["bun", "bench/server-hono.ts"], port: 4102 },
  { name: `koa 3 (${NODE_LABEL})`, cmd: ["node", "bench/server-koa.mjs"], port: 4101 },
  { name: `fastify 5 (${NODE_LABEL})`, cmd: ["node", "bench/server-fastify.mjs"], port: 4105 },
  { name: "koa 3 (bun 1.4)", cmd: ["bun", "bench/server-koa.mjs"], port: 4106 },
  { name: "fastify 5 (bun 1.4)", cmd: ["bun", "bench/server-fastify.mjs"], port: 4107 },
];

const SCENARIOS = [
  { label: "Text response", path: "/text" },
  { label: "JSON response", path: "/json" },
  { label: "Param route", path: "/users/12345" },
  { label: "3 middlewares", path: "/mw" },
];

// The scale scenario runs on DEDICATED server processes: 1000 extra routes
// on the shared servers would poison the base scenarios (koa's linear layer
// walk collapses, raw's routes-table misses pay a lookup cost).
const SCALE_SCENARIO = { label: "1000-route scale (late)", path: "/route-999" };
const SCALE_SERVERS = [
  {
    name: "raw Bun.serve (bun 1.4)",
    cmd: ["bun", "bench/server-raw-scale.ts"],
    port: 4114,
    scale: true,
  },
  {
    name: "bun-koa (bun 1.4)",
    cmd: ["bun", "bench/server-bun-koa-scale.ts"],
    port: 4113,
    scale: true,
  },
  { name: "hono 4 (bun 1.4)", cmd: ["bun", "bench/server-hono-scale.ts"], port: 4112, scale: true },
  {
    name: `koa 3 (${NODE_LABEL})`,
    cmd: ["node", "bench/server-koa-scale.mjs"],
    port: 4111,
    scale: true,
  },
  {
    name: `fastify 5 (${NODE_LABEL})`,
    cmd: ["node", "bench/server-fastify-scale.mjs"],
    port: 4115,
    scale: true,
  },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitReady = async (port, scale = false) => {
  const probe = scale ? "/route-0" : "/text";
  for (let i = 0; i < 150; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${probe}`);
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
    // 4 client workers: a single autocannon process saturates near ~177k
    // req/s on this machine and flattens every Bun framework to 1.00x —
    // without workers the CLIENT is the bottleneck, not the servers.
    workers: 4,
    warmup: { connections: CONNECTIONS, duration: 2 },
  });

const median = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? sorted[0];
};

/** (max - min) / median as a whole-percent string — the run-to-run noise band. */
const spreadOf = (values) => {
  if (values.length < 2) return "±0%";
  const med = median(values);
  if (med === 0) return "±0%";
  return `±${Math.round(((Math.max(...values) - Math.min(...values)) / med) * 100)}%`;
};

const fmtBytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;

/** Sample a server's memory while its own fire window is running. */
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
  const allServers = [...SERVERS, ...SCALE_SERVERS];
  const children = [];
  const ready = new Map(); // port -> { instance, idle }

  try {
    for (const instance of allServers) {
      const child = spawn(instance.cmd[0], [...instance.cmd.slice(1), String(instance.port)], {
        stdio: ["ignore", "ignore", "inherit"],
      });
      children.push(child);
      await waitReady(instance.port, instance.scale);
      ready.set(instance.port, { instance, idle: null });
    }
    // Idle memory AFTER every server is up, so all idle samples share the
    // same machine state.
    for (const [port, entry] of ready) {
      entry.idle = await sampleMemory(port);
    }

    // results keyed by instance identity (port) — display names are NOT
    // unique: the base and scale servers share them.
    const results = new Map();
    const peaks = new Map();
    const record = (instance, label, fields) => {
      const byServer = results.get(instance) ?? new Map();
      results.set(instance, byServer);
      const entry = byServer.get(label) ?? { rps: [], p50: [], p99: [] };
      byServer.set(label, entry);
      entry.rps.push(fields.rps);
      entry.p50.push(fields.p50);
      entry.p99.push(fields.p99);
    };

    const allScenarios = [
      ...SCENARIOS.map((scenario) => ({ scenario, servers: SERVERS })),
      { scenario: SCALE_SCENARIO, servers: SCALE_SERVERS },
    ];

    for (const { scenario, servers } of allScenarios) {
      for (let round = 0; round < ROUNDS; round++) {
        // Rotate the starting server every round — no framework is
        // systematically measured in the hottest or coolest slot.
        const order = [
          ...servers.slice(round % servers.length),
          ...servers.slice(0, round % servers.length),
        ];
        for (const instance of order) {
          const stop = { done: false };
          const peakPromise = trackPeak(instance.port, stop);
          const result = await fire(`http://127.0.0.1:${instance.port}${scenario.path}`);
          stop.done = true;
          const peak = await peakPromise;
          const prev = peaks.get(instance.port) ?? { rss: 0, heapUsed: 0 };
          peaks.set(instance.port, {
            rss: Math.max(prev.rss, peak.rss),
            heapUsed: Math.max(prev.heapUsed, peak.heapUsed),
          });
          record(instance, scenario.label, {
            rps: result.requests.average,
            p50: result.latency.p50 ?? result.latency.average,
            p99: result.latency.p99 ?? result.latency.max,
          });
          process.stdout.write(`.`);
        }
      }
      process.stdout.write(`\n${scenario.label} done\n`);
    }

    const lines = [];
    lines.push("# bun-koa performance report", "");
    lines.push(`Generated: ${new Date().toISOString()}`, "");
    lines.push("- Load tool: autocannon (4 client workers — one process saturates at ~177k req/s)");
    lines.push(
      `- Connections: ${CONNECTIONS}, duration: ${DURATION}s per fire, ${ROUNDS} interleaved rounds`,
    );
    lines.push(
      "- **ABAB-interleaved**: all servers resident; within each scenario every server fires once per round in rotating order",
    );
    lines.push(
      "- Ratio lines carry each side's run-to-run noise (±spread); a ratio inside the noise band is a TIE, not a win",
    );
    lines.push(`- Runtimes: ${BUN_LABEL} (raw / bun-koa / hono) vs ${NODE_LABEL} (koa / fastify)`);
    lines.push("- Loopback HTTP/1.1 keep-alive; identical response shapes on every framework");
    lines.push("");

    for (const { scenario } of allScenarios) {
      lines.push(`## ${scenario.label}`, "");
      lines.push("| Framework | Runtime | req/s | noise |");
      lines.push("| --- | --- | ---: | ---: |");
      // Only the servers that actually serve this scenario (fixes duplicate
      // rows from the name collision between base and scale instances).
      const serving = allServers.filter(
        (instance) => (instance.scale ?? false) === (scenario === SCALE_SCENARIO),
      );
      const entries = [];
      for (const instance of serving) {
        const byServer = results.get(instance);
        const entry = byServer?.get(scenario.label);
        if (entry === undefined) continue;
        entries.push({ instance, entry });
        lines.push(
          `| ${instance.name.split(" (")[0]}${instance.scale ? " (scale)" : ""} | ${instance.name.match(/\((.*)\)/)?.[1] ?? ""} | ${Math.round(median(entry.rps)).toLocaleString("en-US")} | ${spreadOf(entry.rps)} |`,
        );
      }
      const ours = entries.find((e) => e.instance.name.startsWith("bun-koa"));
      for (const other of ["koa 3", "fastify 5", "hono 4", "raw Bun"]) {
        const ref = entries.find((e) => e.instance.name.startsWith(other) && e !== ours);
        if (ours && ref && ref !== ours) {
          const ratio = median(ours.entry.rps) / median(ref.entry.rps);
          lines.push(
            `- bun-koa vs ${other}: **${ratio.toFixed(2)}x** (${spreadOf(ours.entry.rps)} / ${spreadOf(ref.entry.rps)})`,
          );
        }
      }
      lines.push("");
    }

    lines.push("## Latency under load (median of interleaved rounds)", "");
    lines.push("| Framework | scenario | p50 (ms) | p99 (ms) |");
    lines.push("| --- | --- | ---: | ---: |");
    for (const instance of allServers) {
      const byServer = results.get(instance);
      if (byServer === undefined) continue;
      for (const [label, entry] of byServer) {
        lines.push(
          `| ${instance.name.split(" (")[0]}${instance.scale ? " (scale)" : ""} | ${label} | ${median(entry.p50).toFixed(1)} | ${median(entry.p99).toFixed(1)} |`,
        );
      }
    }
    lines.push("");

    lines.push("## Memory footprint (sampled via /debug/memory)", "");
    lines.push("| Framework | idle RSS | steady RSS | peak RSS | idle heap | steady heap |");
    lines.push("| --- | ---: | ---: | ---: | ---: | ---: |");
    for (const instance of allServers) {
      const entry = ready.get(instance.port);
      const peak = peaks.get(instance.port);
      if (entry === undefined || peak === undefined) continue;
      const steady = await sampleMemory(instance.port);
      lines.push(
        `| ${instance.name.split(" (")[0]}${instance.scale ? " (scale)" : ""} | ${fmtBytes(entry.idle.rss)} | ${fmtBytes(steady.rss)} | ${fmtBytes(Math.max(peak.rss, steady.rss))} | ${fmtBytes(entry.idle.heapUsed)} | ${fmtBytes(steady.heapUsed)} |`,
      );
    }
    lines.push("");

    const analysis = await readFile(new URL("./analysis.md", import.meta.url), "utf8").catch(
      () => "",
    );
    await writeFile(new URL("./BENCH.md", import.meta.url), lines.join("\n") + analysis, "utf8");
    console.log("\nWrote bench/BENCH.md");
  } finally {
    for (const child of children) child.kill("SIGKILL");
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
