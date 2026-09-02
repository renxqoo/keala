// keala R4.5 vs R4.6 head-to-head A/B (ABAB-interleaved).
//
//   node bench/run-r45-r46.mjs [durationSeconds] [rounds]
//
// Unlike bench/run.mjs (the full framework matrix, ~35 min), this harness
// answers ONE question: what did the R4.6 lifecycle work cost on the HTTP
// hot path? Two trees of the SAME bench servers (the scripts are identical
// across the two refs) fire in rotating order — the R4.6 tree is the working
// tree, the R4.5 tree an auto-created worktree pinned to KEALA_R45_REF
// (default: the R4.5 runtime-engine-rewrite tip). Node and Bun both measured,
// because the adapters diverge (Node gained per-request wire listeners).
import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import autocannon from "autocannon";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DURATION = Number(process.argv[2] ?? 8);
const ROUNDS = Number(process.argv[3] ?? 4);
const CONNECTIONS = 200;
const R45_REF = process.env.KEALA_R45_REF ?? "3c4347f"; // feat: R4.5 runtime-engine-rewrite
const R45_DIR = process.env.KEALA_R45_DIR ?? "/tmp/keala-r45-worktree";

// The R4.5 side must not silently drift: pin the worktree to the ref on
// every run, pruning stale registrations from previous machine state.
execSync("git worktree prune", { cwd: ROOT, stdio: "pipe" });
if (existsSync(`${R45_DIR}/.git`)) {
  execSync(`git -C ${R45_DIR} checkout -f --detach ${R45_REF}`, { stdio: "pipe" });
} else {
  execSync(`git worktree add --detach ${R45_DIR} ${R45_REF}`, { cwd: ROOT, stdio: "inherit" });
}

const NODE_LABEL = `node ${process.versions.node.split(".")[0]}`;
const BUN_LABEL = `bun ${execSync("bun --version", { encoding: "utf8" }).trim()}`;

const SERVERS = [
  { name: `R4.5 (${BUN_LABEL})`, tree: R45_DIR, cmd: ["bun", "bench/server-keala.ts"], port: 4131 },
  { name: `R4.6 (${BUN_LABEL})`, tree: ROOT, cmd: ["bun", "bench/server-keala.ts"], port: 4132 },
  {
    name: `R4.5 (${NODE_LABEL})`,
    tree: R45_DIR,
    cmd: ["node", "bench/server-keala-node.ts"],
    port: 4133,
  },
  {
    name: `R4.6 (${NODE_LABEL})`,
    tree: ROOT,
    cmd: ["node", "bench/server-keala-node.ts"],
    port: 4134,
  },
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

// Same response-correctness contract as run.mjs: a regression that answers
// wrong-but-fast must not count as a win.
const EXPECTED = new Map([
  ["/text", "hello world"],
  ["/json", '{"hello":"world"}'],
  ["/users/12345", "user 12345"],
  ["/mw", "middleware"],
]);

const verifyResponses = async (port, name) => {
  for (const [path, body] of EXPECTED) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    if (res.status !== 200 || (await res.text()) !== body) {
      throw new Error(`${name}: ${path} contract violation (${res.status})`);
    }
  }
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
    workers: 4,
    warmup: { connections: CONNECTIONS, duration: 2 },
  });

const median = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? sorted[0];
};

const spreadOf = (values) => {
  if (values.length < 2) return "±0%";
  const med = median(values);
  if (med === 0) return "±0%";
  return `±${Math.round(((Math.max(...values) - Math.min(...values)) / med) * 100)}%`;
};

const fmtBytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;

const main = async () => {
  const children = [];
  const ready = new Map();
  try {
    for (const instance of SERVERS) {
      const child = spawn(instance.cmd[0], [...instance.cmd.slice(1), String(instance.port)], {
        cwd: instance.tree,
        stdio: ["ignore", "ignore", "inherit"],
      });
      children.push(child);
      await waitReady(instance.port);
      await verifyResponses(instance.port, instance.name);
      ready.set(instance, await sampleMemory(instance.port));
    }

    const results = new Map();
    const record = (instance, label, fields) => {
      const byServer = results.get(instance) ?? new Map();
      results.set(instance, byServer);
      const entry = byServer.get(label) ?? { rps: [], p50: [], p99: [] };
      byServer.set(label, entry);
      entry.rps.push(fields.rps);
      entry.p50.push(fields.p50);
      entry.p99.push(fields.p99);
    };

    for (const scenario of SCENARIOS) {
      for (let round = 0; round < ROUNDS; round++) {
        const order = [
          ...SERVERS.slice(round % SERVERS.length),
          ...SERVERS.slice(0, round % SERVERS.length),
        ];
        for (const instance of order) {
          const result = await fire(`http://127.0.0.1:${instance.port}${scenario.path}`);
          record(instance, scenario.label, {
            rps: result.requests.average,
            p50: result.latency.p50 ?? result.latency.average,
            p99: result.latency.p99 ?? result.latency.max,
          });
          process.stdout.write(".");
        }
      }
      process.stdout.write(`\n${scenario.label} done\n`);
    }

    const lines = [];
    lines.push("# keala R4.5 vs R4.6 — head-to-head", "");
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push(`R4.5 ref: ${R45_REF} (worktree) | R4.6: working tree`, "");
    lines.push(
      `Connections: ${CONNECTIONS}, duration: ${DURATION}s, ${ROUNDS} interleaved rounds`,
      "",
    );
    lines.push("- Ratio inside the two sides' noise band (±spread) is a TIE, not a regression", "");

    for (const runtime of [BUN_LABEL, NODE_LABEL]) {
      lines.push(`## ${runtime}`, "");
      lines.push("| Scenario | R4.5 req/s | R4.6 req/s | ratio | noise (45/46) | verdict |");
      lines.push("| --- | ---: | ---: | ---: | --- | --- |");
      for (const scenario of SCENARIOS) {
        const r45 = SERVERS.find((s) => s.name === `R4.5 (${runtime})`);
        const r46 = SERVERS.find((s) => s.name === `R4.6 (${runtime})`);
        const e45 = results.get(r45)?.get(scenario.label);
        const e46 = results.get(r46)?.get(scenario.label);
        if (e45 === undefined || e46 === undefined) continue;
        const ratio = median(e46.rps) / median(e45.rps);
        const spread = `${spreadOf(e45.rps)} / ${spreadOf(e46.rps)}`;
        const maxSpread = Math.max(
          ...[spreadOf(e45.rps), spreadOf(e46.rps)].map((s) => Number(s.slice(1, -1)) / 100),
        );
        const verdict =
          Math.abs(ratio - 1) <= maxSpread ? "TIE" : ratio > 1 ? "R4.6 faster" : "R4.5 faster";
        lines.push(
          `| ${scenario.label} | ${Math.round(median(e45.rps)).toLocaleString("en-US")} | ${Math.round(median(e46.rps)).toLocaleString("en-US")} | ${ratio.toFixed(3)}x | ${spread} | ${verdict} |`,
        );
      }
      lines.push("");
    }

    lines.push("## Latency under load (median of rounds)", "");
    lines.push("| Server | scenario | p50 (ms) | p99 (ms) |");
    lines.push("| --- | --- | ---: | ---: |");
    for (const instance of SERVERS) {
      for (const [label, entry] of results.get(instance) ?? []) {
        lines.push(
          `| ${instance.name} | ${label} | ${median(entry.p50).toFixed(1)} | ${median(entry.p99).toFixed(1)} |`,
        );
      }
    }
    lines.push("");

    lines.push("## Memory footprint (idle / post-load steady)", "");
    lines.push("| Server | idle RSS | steady RSS | idle heap |");
    lines.push("| --- | ---: | ---: | ---: |");
    for (const instance of SERVERS) {
      const idle = ready.get(instance);
      const steady = await sampleMemory(instance.port);
      lines.push(
        `| ${instance.name} | ${fmtBytes(idle.rss)} | ${fmtBytes(steady.rss)} | ${fmtBytes(idle.heapUsed)} |`,
      );
    }
    lines.push("");

    process.stdout.write(`\n${lines.join("\n")}\n`);
  } finally {
    for (const child of children) child.kill("SIGKILL");
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
