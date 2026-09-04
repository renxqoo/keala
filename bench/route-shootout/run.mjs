// Route-shootout orchestrator — the classic 12-route table under 6 stacks:
// raw Bun.serve / keala(Bun) / keala(Node) / hono(Bun) / hono(Node) / go net/http.
//
// Methodology is bench/run.mjs's: ABAB-INTERLEAVED (all servers resident,
// rotating first-fire order per round — sequential measurement showed order
// bias up to ±25%), response correctness asserted for EVERY server×scenario
// before any load, autocannon with 4 client workers (a single process
// saturates near ~177k req/s and flattens everything to 1.00x).
//
// Usage: node bench/route-shootout/run.mjs [connections] [durationSeconds] [rounds]
import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import autocannon from "autocannon";

const NODE_LABEL = `node ${process.versions.node.split(".")[0]}`;
const BUN_LABEL = `bun ${execSync("bun --version", { encoding: "utf8" }).trim()}`;

const CONNECTIONS = Number(process.argv[2] ?? 200);
const DURATION = Number(process.argv[3] ?? 8);
const ROUNDS = Number(process.argv[4] ?? 4);

const GO_DIR = "bench/route-shootout/server-go";
const GO_BINARY = `${GO_DIR}/server-shootout-go`;
const GO_AVAILABLE =
  existsSync(GO_BINARY) ||
  (() => {
    try {
      execSync("go version", { stdio: "pipe" });
    } catch {
      return false;
    }
    execSync("go build -o server-shootout-go .", { cwd: GO_DIR, stdio: "inherit" });
    return true;
  })();
const GO_LABEL = GO_AVAILABLE
  ? `go ${
      execSync("go version", { encoding: "utf8" })
        .trim()
        .match(/go(\d+\.\d+)/)?.[1] ?? "?"
    }`
  : "";

const SERVERS = [
  {
    name: `raw Bun.serve (${BUN_LABEL})`,
    cmd: ["bun", "bench/route-shootout/servers/raw-bun.ts"],
    port: 4201,
  },
  {
    name: `keala (${BUN_LABEL})`,
    cmd: ["bun", "bench/route-shootout/servers/keala-bun.ts"],
    port: 4202,
  },
  {
    name: `keala (${NODE_LABEL})`,
    cmd: ["node", "bench/route-shootout/servers/keala-node.ts"],
    port: 4203,
  },
  {
    name: `hono 4 (${BUN_LABEL})`,
    cmd: ["bun", "bench/route-shootout/servers/hono-bun.ts"],
    port: 4204,
  },
  {
    name: `hono 4 official adapter (${NODE_LABEL})`,
    cmd: ["node", "bench/route-shootout/servers/hono-node.ts"],
    port: 4205,
  },
  ...(GO_AVAILABLE ? [{ name: `go net/http (${GO_LABEL})`, cmd: [GO_BINARY], port: 4206 }] : []),
];

// The 7 named probes (from the route-benchmark table): every server must
// answer these EXACT bytes before any load is fired.
const SCENARIOS = [
  { label: "short static", method: "GET", path: "/user", body: "user" },
  { label: "static with same radix", method: "GET", path: "/user/comments", body: "user/comments" },
  { label: "dynamic route", method: "GET", path: "/user/lookup/username/hey", body: "hey" },
  {
    label: "mixed static dynamic",
    method: "GET",
    path: "/event/abcd1234/comments",
    body: "abcd1234",
  },
  { label: "post", method: "POST", path: "/event/abcd1234/comment", body: "abcd1234 comment" },
  {
    label: "long static",
    method: "GET",
    path: "/very/deeply/nested/route/hello/there",
    body: "hello there",
  },
  { label: "wildcard", method: "GET", path: "/static/index.html", body: "index.html" },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitReady = async (port) => {
  for (let i = 0; i < 150; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/status`);
      if (res.ok) return;
    } catch {
      // retry
    }
    await sleep(100);
  }
  throw new Error(`server on ${port} never became ready`);
};

const verifyResponses = async (instance) => {
  for (const scenario of SCENARIOS) {
    const res = await fetch(`http://127.0.0.1:${instance.port}${scenario.path}`, {
      method: scenario.method,
    });
    if (res.status !== 200) {
      throw new Error(
        `${instance.name}: ${scenario.method} ${scenario.path} answered ${res.status}`,
      );
    }
    const body = await res.text();
    if (body !== scenario.body) {
      throw new Error(
        `${instance.name}: ${scenario.method} ${scenario.path} answered ${JSON.stringify(body)}, expected ${JSON.stringify(scenario.body)}`,
      );
    }
  }
};

const sampleMemory = async (port) =>
  await (await fetch(`http://127.0.0.1:${port}/debug/memory`)).json();

const fire = (url, method) =>
  autocannon({
    url,
    method,
    connections: CONNECTIONS,
    duration: DURATION,
    pipelining: 1,
    // 4 client workers — without them the CLIENT is the bottleneck.
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

const shortName = (instance) => instance.name.split(" (")[0];
const runtimeOf = (instance) => instance.name.match(/\((.*)\)/)?.[1] ?? "";

const main = async () => {
  const children = [];
  const ready = new Map(); // port -> { instance, idle }

  try {
    for (const instance of SERVERS) {
      const child = spawn(instance.cmd[0], [...instance.cmd.slice(1), String(instance.port)], {
        stdio: ["ignore", "ignore", "inherit"],
      });
      children.push(child);
      await waitReady(instance.port);
      if (!process.argv.includes("--skip-tests")) await verifyResponses(instance);
      ready.set(instance.port, { instance, idle: null });
    }
    for (const [port, entry] of ready) {
      entry.idle = await sampleMemory(port);
    }

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

    for (const scenario of SCENARIOS) {
      for (let round = 0; round < ROUNDS; round++) {
        const order = [
          ...SERVERS.slice(round % SERVERS.length),
          ...SERVERS.slice(0, round % SERVERS.length),
        ];
        for (const instance of order) {
          const stop = { done: false };
          const peakPromise = trackPeak(instance.port, stop);
          const result = await fire(
            `http://127.0.0.1:${instance.port}${scenario.path}`,
            scenario.method,
          );
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
          process.stdout.write(".");
        }
      }
      process.stdout.write(`\n${scenario.label} done\n`);
    }

    const lines = [];
    lines.push("# route shootout — the 12-route table, 6 stacks", "");
    lines.push(`Generated: ${new Date().toISOString()}`, "");
    lines.push(
      `- Load: autocannon, ${CONNECTIONS} connections, ${DURATION}s/fire, ${ROUNDS} interleaved rounds, 4 client workers`,
    );
    lines.push("- ABAB-interleaved: all servers resident, rotating first-fire order per round");
    lines.push(
      "- Correctness asserted for every server×scenario BEFORE any load (identical bodies)",
    );
    lines.push(
      `- Runtimes: ${BUN_LABEL} (raw / keala / hono) vs ${NODE_LABEL} (keala / hono)${GO_AVAILABLE ? ` vs ${GO_LABEL}` : ""}`,
    );
    lines.push(
      "- Route table: 12 routes (5 static incl. one 6-deep, 6 param, 1 wildcard); probes: 7",
    );
    lines.push("- Ratios inside the ±noise bands are TIES, not wins", "");
    lines.push("| # | route | shape |", "| --- | --- | --- |");
    lines.push("| 1 | `GET /user` | short static |");
    lines.push("| 2 | `GET /user/comments` | static, same radix as #1 |");
    lines.push("| 3 | `GET /user/avatar` | static, same radix as #1 |");
    lines.push("| 4 | `GET /user/lookup/username/:username` | 4-segment param |");
    lines.push("| 5 | `GET /user/lookup/email/:address` | param, same radix as #4 |");
    lines.push("| 6 | `GET /event/:id` | param |");
    lines.push("| 7 | `GET /event/:id/comments` | mixed static+param |");
    lines.push("| 8 | `POST /event/:id/comment` | mixed, POST |");
    lines.push("| 9 | `GET /map/:location/events` | mixed, other radix |");
    lines.push("| 10 | `GET /status` | static |");
    lines.push("| 11 | `GET /very/deeply/nested/route/hello/there` | 6-deep static |");
    lines.push("| 12 | `GET /static/*` | wildcard |");
    lines.push("");

    for (const scenario of SCENARIOS) {
      lines.push(`## ${scenario.label} — ${scenario.method} ${scenario.path}`, "");
      lines.push("| Framework | Runtime | req/s | noise |");
      lines.push("| --- | --- | ---: | ---: |");
      const entries = [];
      for (const instance of SERVERS) {
        const entry = results.get(instance)?.get(scenario.label);
        if (entry === undefined) continue;
        entries.push({ instance, entry });
        lines.push(
          `| ${shortName(instance)} | ${runtimeOf(instance)} | ${Math.round(median(entry.rps)).toLocaleString("en-US")} | ${spreadOf(entry.rps)} |`,
        );
      }
      const kealaBun = entries.find(
        (e) => e.instance.name.startsWith("keala") && e.instance.name.includes(BUN_LABEL),
      );
      const kealaNode = entries.find(
        (e) => e.instance.name.startsWith("keala") && e.instance.name.includes(NODE_LABEL),
      );
      for (const [ours, label, others] of [
        [kealaBun, "keala (bun)", ["raw Bun.serve", "hono 4", "go net/http"]],
        [kealaNode, "keala (node)", ["hono 4 official adapter"]],
      ]) {
        for (const other of others) {
          const ref = entries.find((e) => e.instance.name.startsWith(other) && e !== ours);
          if (ours && ref) {
            const ratio = median(ours.entry.rps) / median(ref.entry.rps);
            lines.push(
              `- ${label} vs ${other}: **${ratio.toFixed(2)}x** (${spreadOf(ours.entry.rps)} / ${spreadOf(ref.entry.rps)})`,
            );
          }
        }
      }
      lines.push("");
    }

    lines.push("## Latency under load (median of interleaved rounds)", "");
    lines.push("| Framework | Runtime | scenario | p50 (ms) | p99 (ms) |");
    lines.push("| --- | --- | --- | ---: | ---: |");
    for (const instance of SERVERS) {
      const byServer = results.get(instance);
      if (byServer === undefined) continue;
      for (const [label, entry] of byServer) {
        lines.push(
          `| ${shortName(instance)} | ${runtimeOf(instance)} | ${label} | ${median(entry.p50).toFixed(1)} | ${median(entry.p99).toFixed(1)} |`,
        );
      }
    }
    lines.push("");

    lines.push("## Memory footprint (idle → steady → peak, via /debug/memory)", "");
    lines.push(
      "| Framework | Runtime | idle RSS | steady RSS | peak RSS | idle heap | steady heap |",
    );
    lines.push("| --- | --- | ---: | ---: | ---: | ---: | ---: |");
    for (const instance of SERVERS) {
      const entry = ready.get(instance.port);
      const peak = peaks.get(instance.port);
      if (entry === undefined || peak === undefined) continue;
      const steady = await sampleMemory(instance.port);
      lines.push(
        `| ${shortName(instance)} | ${runtimeOf(instance)} | ${fmtBytes(entry.idle.rss)} | ${fmtBytes(steady.rss)} | ${fmtBytes(Math.max(peak.rss, steady.rss))} | ${fmtBytes(entry.idle.heapUsed)} | ${fmtBytes(steady.heapUsed)} |`,
      );
    }
    lines.push("");

    await writeFile(new URL("./REPORT.md", import.meta.url), lines.join("\n") + "\n", "utf8");
    console.log("\nWrote bench/route-shootout/REPORT.md");
  } finally {
    for (const child of children) child.kill("SIGKILL");
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
