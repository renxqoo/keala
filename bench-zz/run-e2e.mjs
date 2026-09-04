// Interleaved paired E2E runner v2 — hard port hygiene:
//  * asserts every leg port is FREE before spawn (refuses to run polluted)
//  * kills children and WAITS until the port is free again after the run
//  * every scenario uses its own never-reused port pair
import { spawn, execSync } from "node:child_process";
import autocannon from "autocannon";

const BUN = `${process.env.HOME}/.bun/bin/bun`;
const ROUNDS = Number(process.env.ROUNDS ?? 7);
const DURATION = Number(process.env.DURATION ?? 5);
const CONNECTIONS = Number(process.env.CONNECTIONS ?? 64);

const scenarios = {
  pooling: [
    {
      label: "keala unpooled /text",
      cmd: [BUN, "bench-zz/server-bun.ts", "plain", "7861"],
      url: "http://127.0.0.1:7861/text",
    },
    {
      label: "keala POOLED /text",
      cmd: [BUN, "bench-zz/server-bun.ts", "pooled", "7862"],
      url: "http://127.0.0.1:7862/text",
    },
  ],
  poolingRaw: [
    {
      label: "keala unpooled raw-Response /text",
      cmd: [BUN, "bench-zz/server-bun.ts", "raw-res", "7863"],
      url: "http://127.0.0.1:7863/text",
    },
    {
      label: "keala POOLED raw-Response /text",
      cmd: [BUN, "bench-zz/server-bun.ts", "pooled-raw", "7864"],
      url: "http://127.0.0.1:7864/text",
    },
  ],
  gapBun: [
    {
      label: "keala /text (bun)",
      cmd: [BUN, "bench-zz/server-bun.ts", "plain", "7865"],
      url: "http://127.0.0.1:7865/text",
    },
    {
      label: "raw Bun.serve /text",
      cmd: [BUN, "bench-zz/server-raw-bun.ts", "plain", "7866"],
      url: "http://127.0.0.1:7866/",
    },
  ],
  compressDecline: [
    {
      label: "keala+compress 1KB json (no AE)",
      cmd: [BUN, "bench-zz/server-bun.ts", "compress", "7867"],
      url: "http://127.0.0.1:7867/json",
      headers: { "accept-encoding": "identity" },
    },
    {
      label: "keala 1KB json (no mw)",
      cmd: [BUN, "bench-zz/server-bun.ts", "nocompress", "7868"],
      url: "http://127.0.0.1:7868/json",
    },
  ],
  gapNode: [
    {
      label: "keala /text (node)",
      cmd: [process.execPath, "bench-zz/server-node.ts", "plain", "7869"],
      url: "http://127.0.0.1:7869/text",
    },
    {
      label: "raw node:http /text",
      cmd: [process.execPath, "bench-zz/server-node.ts", "raw", "7870"],
      url: "http://127.0.0.1:7870/",
    },
  ],
  staticFile: [
    {
      label: "keala serveStatic 1.2KB",
      cmd: [BUN, "bench-zz/server-bun.ts", "static", "7871"],
      url: "http://127.0.0.1:7871/file.txt",
    },
    {
      label: "raw Bun.file 1.2KB",
      cmd: [BUN, "bench-zz/server-raw-bun.ts", "static", "7872"],
      url: "http://127.0.0.1:7872/file.txt",
    },
  ],
  staticNoSymlink: [
    {
      label: "keala serveStatic no-lstat-walk",
      cmd: [BUN, "bench-zz/server-bun.ts", "static-nosymlink", "7873"],
      url: "http://127.0.0.1:7873/file.txt",
    },
    {
      label: "raw Bun.file 1.2KB",
      cmd: [BUN, "bench-zz/server-raw-bun.ts", "static", "7874"],
      url: "http://127.0.0.1:7874/file.txt",
    },
  ],
  etag: [
    {
      label: "keala+etag /text",
      cmd: [BUN, "bench-zz/server-bun.ts", "etagleg", "7875"],
      url: "http://127.0.0.1:7875/text",
    },
    {
      label: "keala /text",
      cmd: [BUN, "bench-zz/server-bun.ts", "plain", "7876"],
      url: "http://127.0.0.1:7876/text",
    },
  ],
};

const scenarioName = process.argv[2];
const legs = scenarios[scenarioName];
if (!legs) {
  console.error(`unknown scenario ${scenarioName}; known: ${Object.keys(scenarios).join(", ")}`);
  process.exit(1);
}

const portOf = (leg) => Number(new URL(leg.url).port);
const holders = (port) => {
  try {
    const out = execSync(`lsof -tnP -iTCP:${port} -sTCP:LISTEN 2>/dev/null || true`, {
      encoding: "utf8",
    }).trim();
    return out ? out.split("\n") : [];
  } catch {
    return [];
  }
};

// pre-flight: refuse polluted ports
for (const leg of legs) {
  const h = holders(portOf(leg));
  if (h.length > 0) {
    console.error(
      `REFUSING: port ${portOf(leg)} already held by pid ${h.join(",")} — kill it first`,
    );
    process.exit(1);
  }
}

const procs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const leg of legs) {
  procs.push(spawn(leg.cmd[0], leg.cmd.slice(1), { stdio: "ignore" }));
}
await sleep(1500);

// health-wait with status check
for (const leg of legs) {
  let ok = false;
  for (let i = 0; i < 60 && !ok; i++) {
    try {
      const res = await fetch(leg.url);
      if (res.status >= 200 && res.status < 500) ok = true;
      else break;
    } catch {
      await sleep(250);
    }
  }
  if (!ok) console.error(`WARN: ${leg.label} never became healthy`);
}

const samples = legs.map(() => []);
const roundSamples = legs.map(() => []);
let non2xxTotal = legs.map(() => 0);
try {
  for (let round = 0; round < ROUNDS; round++) {
    const perLeg = legs.map(() => []);
    for (let i = 0; i < legs.length; i++) {
      const idx = (round + i) % legs.length;
      const leg = legs[idx];
      const result = await autocannon({
        url: leg.url,
        connections: CONNECTIONS,
        duration: DURATION,
        headers: leg.headers ?? {},
        pipelining: 1,
      });
      samples[idx].push(result.requests.average);
      perLeg[idx] = result.requests.average;
      non2xxTotal[idx] += result.non2xx ?? 0;
      process.stderr.write(
        `r${round} ${leg.label}: ${Math.round(result.requests.average)} rps (non2xx ${result.non2xx ?? 0})\n`,
      );
    }
    for (let i = 0; i < legs.length; i++) roundSamples[i].push(perLeg[i]);
  }
} finally {
  for (const p of procs) {
    try {
      p.kill("SIGKILL");
    } catch {}
  }
  // wait until every port is actually free
  for (const leg of legs) {
    const port = portOf(leg);
    for (let i = 0; i < 40; i++) {
      if (holders(port).length === 0) break;
      await sleep(250);
    }
  }
}

const med = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
};
console.log(
  `\n=== ${scenarioName} (conns=${CONNECTIONS}, dur=${DURATION}s, rounds=${ROUNDS}, interleaved) ===`,
);
for (const [i, leg] of legs.entries()) {
  const xs = samples[i];
  console.log(
    `${leg.label}: median ${Math.round(med(xs))} rps [min ${Math.round(Math.min(...xs))} max ${Math.round(Math.max(...xs))} n=${xs.length}] non2xx=${non2xxTotal[i]}`,
  );
}
if (legs.length === 2) {
  const a = med(samples[0]);
  const b = med(samples[1]);
  const ratios = roundSamples[0].map((v, i) => v / roundSamples[1][i]).sort((x, y) => x - y);
  console.log(
    `ratio (leg0/leg1): ${(a / b).toFixed(3)}  delta ${Math.round(a - b)} rps (${((a / b - 1) * 100).toFixed(1)}%)`,
  );
  console.log(
    `per-round paired ratios: ${ratios.map((r) => r.toFixed(2)).join(" ")} (median ${ratios[ratios.length >> 1].toFixed(3)})`,
  );
}
