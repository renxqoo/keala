// Official Node-vs-Node comparison for Keala and Hono. Each framework owns
// a process; samples are interleaved and order rotates per round.
//
// Usage: node bench/run-node-hotpaths.mjs [connections] [duration] [rounds]

import { spawn } from "node:child_process";
import autocannon from "autocannon";

const connections = Number(process.argv[2] ?? 200);
const duration = Number(process.argv[3] ?? 5);
const rounds = Number(process.argv[4] ?? 5);
const scenarioFilter = process.argv[5];
const runtime = process.env["KEALA_BENCH_RUNTIME"] === "bun" ? "bun" : "node";
const servers =
  runtime === "node"
    ? [
        { name: "keala", port: 4611, file: "bench/server-keala-node.ts" },
        { name: "hono-official", port: 4612, file: "bench/server-hono-node.ts" },
      ]
    : [
        { name: "keala", port: 4621, file: "bench/server-keala.ts" },
        { name: "hono-official", port: 4622, file: "bench/server-hono.ts" },
      ];
const body = '{"message":"hello world"}';
const scenarios = [
  { name: "probe-scoped-3", path: "/livez", expected: '{"status":"ok"}' },
  { name: "text", path: "/text", expected: "hello world" },
  { name: "json", path: "/json", expected: '{"hello":"world"}' },
  { name: "param", path: "/users/12345", expected: "user 12345" },
  { name: "middleware-3", path: "/mw", expected: "middleware" },
  {
    name: "json-body-safe",
    path: "/echo-safe",
    method: "POST",
    body,
    // Autocannon derives the exact Content-Length from `body`; setting it a
    // second time makes v8.0.0 omit completed-request statistics.
    headers: { "content-type": "application/json" },
    expected: body,
  },
].filter((scenario) => scenarioFilter === undefined || scenario.name === scenarioFilter);

if (scenarios.length === 0) throw new TypeError(`unknown scenario ${scenarioFilter}`);

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const median = (values) => {
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
};

const waitReady = async ({ port }) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/text`)).ok) return;
    } catch {
      // Process startup race.
    }
    await sleep(50);
  }
  throw new Error(`server ${port} did not become ready`);
};

const verify = async (server, scenario) => {
  const response = await fetch(`http://127.0.0.1:${server.port}${scenario.path}`, {
    ...(scenario.method === undefined ? {} : { method: scenario.method }),
    ...(scenario.headers === undefined ? {} : { headers: scenario.headers }),
    ...(scenario.body === undefined ? {} : { body: scenario.body }),
  });
  const actual = await response.text();
  if (response.status !== 200 || actual !== scenario.expected) {
    throw new Error(
      `${server.name} ${scenario.name}: ${response.status} ${JSON.stringify(actual)}`,
    );
  }
};

const fire = (server, scenario) =>
  autocannon({
    url: `http://127.0.0.1:${server.port}${scenario.path}`,
    connections,
    duration,
    pipelining: 1,
    ...(scenario.body === undefined ? { workers: 4 } : {}),
    warmup: { connections, duration: 1 },
    ...(scenario.method === undefined ? {} : { method: scenario.method }),
    ...(scenario.headers === undefined ? {} : { headers: scenario.headers }),
    ...(scenario.body === undefined ? {} : { body: scenario.body }),
  });

const children = servers.map((server) =>
  spawn(runtime === "bun" ? "bun" : process.execPath, [server.file, String(server.port)], {
    cwd: process.cwd(),
    stdio: ["ignore", "ignore", "inherit"],
  }),
);

try {
  await Promise.all(servers.map(waitReady));
  for (const scenario of scenarios) {
    await Promise.all(servers.map((server) => verify(server, scenario)));
    const samples = new Map(servers.map((server) => [server.name, []]));
    const tails = new Map(servers.map((server) => [server.name, []]));
    for (let round = 0; round < rounds; round++) {
      const order = round % 2 === 0 ? servers : servers.toReversed();
      for (const server of order) {
        const result = await fire(server, scenario);
        if (result.errors !== 0 || result.timeouts !== 0 || result.non2xx !== 0) {
          throw new Error(
            `${server.name} ${scenario.name}: errors=${result.errors} timeouts=${result.timeouts} non2xx=${result.non2xx}`,
          );
        }
        samples.get(server.name).push(result.requests.average);
        tails.get(server.name).push(result.latency.p99);
      }
    }
    const keala = median(samples.get("keala"));
    const hono = median(samples.get("hono-official"));
    const pairedRatios = samples
      .get("keala")
      .map((value, index) => value / samples.get("hono-official")[index]);
    console.log(
      JSON.stringify({
        scenario: scenario.name,
        runtime,
        // The machine can drift materially across a multi-minute matrix.
        // Pair the two frameworks inside each interleaved round, then take
        // that ratio's median; independent medians can reverse direction
        // when their samples land in different parts of the drift curve.
        ratio: Number(median(pairedRatios).toFixed(3)),
        pairedRatios: pairedRatios.map((value) => Number(value.toFixed(3))),
        independentMedianRatio: Number((keala / hono).toFixed(3)),
        keala: {
          medianRps: keala,
          medianP99: median(tails.get("keala")),
          samples: samples.get("keala"),
        },
        hono: {
          medianRps: hono,
          medianP99: median(tails.get("hono-official")),
          samples: samples.get("hono-official"),
        },
      }),
    );
  }
} finally {
  for (const child of children) child.kill("SIGTERM");
}
