// Official Node-vs-Node comparison for Keala and Hono. Each framework owns
// a FRESH process per sample; samples are interleaved and order rotates.
//
// Usage: node bench/run-node-hotpaths.mjs [connections] [duration] [rounds]
// KEALA_BENCH_BASELINE=/path/to/checkout adds a third, before-change variant.
// KEALA_BENCH_OUTPUT=/path/to/new.jsonl retains metadata and every raw sample.

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { cpus } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import autocannon from "autocannon";
import { comparePaired, median, positiveInteger } from "./hotpath-metrics.ts";

const connections = positiveInteger(process.argv[2], 200, "connections");
const duration = positiveInteger(process.argv[3], 5, "duration");
const rounds = positiveInteger(process.argv[4], 5, "rounds");
const scenarioFilter = process.argv[5];
const runtime = process.env["KEALA_BENCH_RUNTIME"] === "bun" ? "bun" : "node";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baseline = process.env["KEALA_BENCH_BASELINE"];
const output = process.env["KEALA_BENCH_OUTPUT"];
const servers =
  runtime === "node"
    ? [
        { name: "keala", file: "bench/server-keala-node.ts" },
        { name: "hono-official", file: "bench/server-hono-node.ts" },
      ]
    : [
        { name: "keala", file: "bench/server-keala.ts" },
        { name: "hono-official", file: "bench/server-hono.ts" },
      ];
for (const server of servers) server.cwd = root;
if (baseline !== undefined)
  servers.push({ ...servers[0], name: "keala-baseline", cwd: resolve(baseline) });
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

const sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
const emit = (record) => {
  const line = JSON.stringify(record);
  if (output !== undefined) appendFileSync(output, `${line}\n`);
  console.log(line);
};
const identity = (server) => {
  const hash = createHash("sha256");
  for (const file of readdirSync(resolve(server.cwd, "src"), { recursive: true }).toSorted()) {
    if (file.endsWith(".ts"))
      hash.update(file).update(readFileSync(resolve(server.cwd, "src", file)));
  }
  return {
    ...server,
    revision: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: server.cwd,
      encoding: "utf8",
    }).trim(),
    sourceSha256: hash.digest("hex"),
    harnessSha256: createHash("sha256")
      .update(readFileSync(resolve(server.cwd, server.file)))
      .digest("hex"),
  };
};
const freePort = () =>
  new Promise((done, reject) => {
    const reservation = createServer();
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", () => {
      const port = reservation.address().port;
      reservation.close((error) => (error ? reject(error) : done(port)));
    });
  });

const waitReady = async ({ port }, child) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error("server exited during startup");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/text`, {
        signal: AbortSignal.timeout(200),
      });
      await response.arrayBuffer();
      if (response.ok) return;
    } catch {
      // Process startup race.
    }
    await sleep(50);
  }
  throw new Error(`server ${port} did not become ready`);
};

const verify = async (server, scenario) => {
  const response = await fetch(`http://127.0.0.1:${server.port}${scenario.path}`, {
    signal: AbortSignal.timeout(3000),
    ...(scenario.method === undefined ? {} : { method: scenario.method }),
    ...(scenario.headers === undefined ? {} : { headers: scenario.headers }),
    ...(scenario.body === undefined ? {} : { body: scenario.body }),
  });
  const actual = await response.text();
  const length = response.headers.get("content-length");
  if (
    length !== null &&
    (Number(length) !== Buffer.byteLength(actual) || response.headers.has("transfer-encoding"))
  ) {
    throw new Error(`${server.name} ${scenario.name}: invalid response framing`);
  }
  if (response.status !== 200 || actual !== scenario.expected) {
    throw new Error(
      `${server.name} ${scenario.name}: ${response.status} ${JSON.stringify(actual)}`,
    );
  }
  const type = scenario.expected.startsWith("{") ? "application/json" : "text/plain";
  if (response.headers.get("content-type")?.split(";")[0] !== type)
    throw new Error("wrong content-type");
  if (scenario.name === "middleware-3") {
    for (const [name, value] of [
      ["x-step", "1"],
      ["x-step-2", "2"],
      ["x-step-3", "3"],
    ]) {
      if (response.headers.get(name) !== value)
        throw new Error(`missing middleware header ${name}`);
    }
  }
  if (scenario.body !== undefined) {
    for (const [payload, status] of [
      ["{", 400],
      [JSON.stringify("x".repeat(1024)), 413],
    ]) {
      const rejected = await fetch(`http://127.0.0.1:${server.port}${scenario.path}`, {
        method: "POST",
        headers: scenario.headers,
        body: payload,
        signal: AbortSignal.timeout(3000),
      });
      await rejected.arrayBuffer();
      if (rejected.status !== status) throw new Error(`expected ${status}, got ${rejected.status}`);
    }
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

const memory = async (server) => {
  const response = await fetch(`http://127.0.0.1:${server.port}/debug/memory`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error("memory endpoint failed");
  return response.json();
};
let active;
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    active?.kill("SIGTERM");
    process.exit(1);
  });
const freshSample = async (server, scenario, round, position) => {
  server.port = await freePort();
  const child = spawn(
    runtime === "bun" ? "bun" : process.execPath,
    [server.file, String(server.port)],
    {
      cwd: server.cwd,
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
  active = child;
  let startupError;
  const exited = new Promise((done) => {
    child.once("exit", done);
    child.once("error", (error) => {
      startupError = error;
      done();
    });
  });
  try {
    await waitReady(server, child);
    if (startupError !== undefined) throw startupError;
    await verify(server, scenario);
    const beforeMemory = await memory(server);
    const at = new Date().toISOString();
    const result = await fire(server, scenario);
    emit({
      kind: "sample",
      at,
      runtime,
      server: server.name,
      scenario: scenario.name,
      round,
      position,
      pid: child.pid,
      rps: result.requests.average,
      total: result.requests.total,
      duration: result.duration,
      latency: result.latency,
      errors: result.errors,
      timeouts: result.timeouts,
      non2xx: result.non2xx,
      beforeMemory,
      afterMemory: await memory(server),
    });
    if (
      result.errors !== 0 ||
      result.timeouts !== 0 ||
      result.non2xx !== 0 ||
      result.requests.average <= 0
    ) {
      throw new Error(`${server.name} ${scenario.name}: invalid load result`);
    }
    return result;
  } finally {
    child.kill("SIGTERM");
    const forced = setTimeout(() => child.kill("SIGKILL"), 2000);
    try {
      await exited;
    } finally {
      clearTimeout(forced);
      active = undefined;
    }
  }
};
const metadata = {
  kind: "run",
  at: new Date().toISOString(),
  runtime,
  runtimeVersion: execFileSync(runtime === "bun" ? "bun" : process.execPath, ["--version"], {
    encoding: "utf8",
  }).trim(),
  cpu: cpus()[0]?.model,
  loadGenerator: process.version,
  dependencies: JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).devDependencies,
  connections,
  duration,
  rounds,
  pipelining: 1,
  warmupSeconds: 1,
  workers: { get: 4, post: 0 },
  freshProcessPerSample: true,
  servers: servers.map(identity),
  bodyComparison: "declared JSON byte checks; Hono does not bound chunked buffering",
};
if (output !== undefined) writeFileSync(output, "", { flag: "wx" });
emit(metadata);

{
  for (const scenario of scenarios) {
    const samples = new Map(servers.map((server) => [server.name, []]));
    const tails = new Map(servers.map((server) => [server.name, []]));
    for (let round = 0; round < rounds; round++) {
      const rotated = [
        ...servers.slice(round % servers.length),
        ...servers.slice(0, round % servers.length),
      ];
      const order = Math.floor(round / servers.length) % 2 === 0 ? rotated : rotated.toReversed();
      for (const [position, server] of order.entries()) {
        const result = await freshSample(server, scenario, round, position);
        samples.get(server.name).push(result.requests.average);
        tails.get(server.name).push(result.latency.p99);
      }
    }
    const keala = median(samples.get("keala"));
    const hono = median(samples.get("hono-official"));
    const stats = comparePaired(samples.get("keala"), samples.get("hono-official"));
    emit({
      kind: "summary",
      scenario: scenario.name,
      runtime,
      // The machine can drift materially across a multi-minute matrix.
      // Pair the two frameworks inside each interleaved round, then take
      // that ratio's median; independent medians can reverse direction
      // when their samples land in different parts of the drift curve.
      versusHono: stats,
      ...(baseline === undefined
        ? {}
        : { versusBaseline: comparePaired(samples.get("keala"), samples.get("keala-baseline")) }),
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
    });
  }
}
