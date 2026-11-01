import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runLoad } from "../load-pool.ts";
import { cpuDelta } from "../load-metrics.ts";
import { positiveInteger } from "../hotpath-metrics.ts";
import { validateServerMetrics } from "../server-metrics.ts";
import { prepareSnapshots, sourceHash, fileHash } from "./snapshots.mjs";
import { summarize, renderReport } from "./report.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
process.chdir(root);
assert.equal(process.versions.bun, undefined, "run orchestrator with real Node");
assert.equal(process.versions.node.split(".")[0], "26", "requires Node 26");
const bun = process.env.KEALA_AB_BUN ?? "bun";
const bunVersion = execFileSync(bun, ["--version"], { encoding: "utf8" }).trim();
assert.equal(bunVersion, "1.4.4", "requires Bun 1.4.4");
const runtimes = (process.env.KEALA_AB_RUNTIMES ?? "node,bun").split(",");
assert(
  runtimes.length > 0 &&
    new Set(runtimes).size === runtimes.length &&
    runtimes.every((name) => name === "node" || name === "bun"),
  "KEALA_AB_RUNTIMES must be node, bun or node,bun",
);
const verifyOnly = process.argv.includes("--verify-only");
const args = process.argv.slice(2).filter((arg) => arg !== "--verify-only");
if (!args[0] || args.length > 5)
  throw new Error(
    "usage: node run.mjs BEFORE_DIRECTORY [connections=200] [seconds=8] [pairs=10] [processes=4] [--verify-only]",
  );
const config = {
  connections: positiveInteger(args[1], 200, "connections"),
  duration: positiveInteger(args[2], 8, "seconds"),
  rounds: positiveInteger(args[3], 10, "pairs"),
  processes: positiveInteger(args[4], 4, "processes"),
};
assert(config.processes <= 32 && config.connections >= config.processes);
const output = resolve(
  process.env.KEALA_AB_OUTPUT ??
    (verifyOnly
      ? await mkdtemp(join(os.tmpdir(), "keala-hello-ab-verify-"))
      : join(root, "bench/keala-ab")),
);
await mkdir(output, { recursive: true });
// Never overwrite results from a previous invocation accidentally.
const resultsFile = join(output, "results.json");
await writeFile(resultsFile, "{}\n", { flag: "wx" });
const version = async (name) =>
  JSON.parse(await readFile(join(root, "node_modules", name, "package.json"), "utf8")).version;
const snapshots = await prepareSnapshots(
  root,
  resolve(args[0]),
  resolve(process.env.KEALA_AB_AFTER ?? root),
  output,
);
console.log(
  `Frozen sources: before=${snapshots[0].sourceSha256}; after=${snapshots[1].sourceSha256}`,
);
const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => abort.abort(new Error(`interrupted by ${signal}`)));
const data = {
  startedAt: new Date().toISOString(),
  config,
  runtimes,
  description: process.env.KEALA_AB_DESCRIPTION ?? "重构前后",
  snapshots,
  environment: {
    cpu: os.cpus()[0].model,
    cpus: os.cpus().length,
    memory: os.totalmem(),
    platform: os.platform(),
    arch: os.arch(),
    loadAtStart: os.loadavg(),
  },
  versions: {
    node: process.versions.node,
    bun: bunVersion,
    typescript: await version("typescript"),
    srvx: await version("srvx"),
    autocannon: await version("autocannon"),
  },
  source: {
    gitHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    dirtyFiles: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(),
    lockSha256: await fileHash(join(root, "bun.lock")),
    harness: Object.fromEntries(
      await Promise.all(
        [
          "run.mjs",
          "server.mjs",
          "report.mjs",
          "snapshots.mjs",
          "../load-pool.ts",
          "../load-worker.mjs",
          "../load-metrics.ts",
          "../hotpath-metrics.ts",
          "../server-metrics.ts",
          "../node-runtime.ts",
        ].map(async (name) => [name, await fileHash(join(root, "bench/keala-ab", name))]),
      ),
    ),
  },
  samples: [],
  rejectedPairs: [],
  verification: [],
};
const checkpoint = () => writeFile(resultsFile, `${JSON.stringify(data, null, 2)}\n`);

const receive = (instance, kind, id) =>
  new Promise((resolveMessage, reject) => {
    const finish = (error, value) => {
      clearTimeout(timer);
      instance.child.removeListener("message", onMessage);
      abort.signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolveMessage(value);
    };
    const onAbort = () => finish(abort.signal.reason);
    const onMessage = (message) => {
      if (message?.kind === kind && (id === undefined || message.id === id))
        finish(undefined, message);
    };
    const timer = setTimeout(
      () => finish(new Error(`${instance.runtime}/${instance.snapshot.name} IPC ${kind} timeout`)),
      15000,
    );
    instance.child.on("message", onMessage);
    abort.signal.addEventListener("abort", onAbort, { once: true });
    if (abort.signal.aborted) onAbort();
  });
const start = async (runtime, snapshot) => {
  abort.signal.throwIfAborted();
  const child = spawn(
    runtime === "node" ? process.execPath : bun,
    [join(root, "bench/keala-ab/server.mjs"), snapshot.path],
    {
      cwd: root,
      env: { ...process.env, NODE_ENV: "production" },
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    },
  );
  const instance = { child, runtime, snapshot, stopping: false, nextId: 0 };
  instance.exited = new Promise((resolveExit) => {
    child.once("exit", (code, signal) => {
      resolveExit();
      if (!instance.stopping)
        abort.abort(new Error(`${runtime}/${snapshot.name} unexpected exit ${code ?? signal}`));
    });
    child.once("error", (error) => {
      resolveExit();
      abort.abort(error);
    });
  });
  instance.ready = receive(instance, "ready");
  return instance;
};
const stop = async (instance) => {
  instance.stopping = true;
  if (instance.child.exitCode !== null || instance.child.signalCode !== null) return;
  instance.child.kill("SIGTERM");
  const timer = setTimeout(() => instance.child.kill("SIGKILL"), 2000);
  try {
    await instance.exited;
  } finally {
    clearTimeout(timer);
  }
};
const metrics = async (instance) => {
  const id = ++instance.nextId;
  const pending = receive(instance, "metrics", id);
  instance.child.send({ kind: "metrics", id }, (error) => {
    if (error) abort.abort(error);
  });
  const value = validateServerMetrics(
    (await pending).metrics,
    instance.child.pid,
    instance.runtime,
  );
  assert.equal(value.runtimeVersion.replace(/^v/, ""), data.versions[instance.runtime]);
  assert.equal(value.pooling, false);
  assert.equal(value.sink, false);
  return value;
};
const verify = async (instance) => {
  for (const [method, path, status] of [
    ["GET", "/", 200],
    ["GET", "/missing", 404],
    ["POST", "/", 405],
  ]) {
    const response = await fetch(`${instance.url}${path}`, {
      method,
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
    });
    assert.equal(response.status, status);
    const body = Buffer.from(await response.arrayBuffer());
    if (status === 200) {
      assert.deepEqual(body, Buffer.from("Hello World"));
      assert.equal(
        response.headers.get("content-type").replaceAll(" ", "").toLowerCase(),
        "text/plain;charset=utf-8",
      );
    }
  }
};
const sample = async (runtime, snapshot, round, order, dryRun = false) => {
  const instance = await start(runtime, snapshot);
  try {
    const ready = await instance.ready;
    validateServerMetrics(ready, instance.child.pid, runtime);
    assert.equal(ready.runtimeVersion.replace(/^v/, ""), data.versions[runtime]);
    assert(Number.isSafeInteger(ready.port) && ready.port > 0);
    instance.url = `http://127.0.0.1:${ready.port}`;
    await verify(instance);
    if (dryRun) {
      await metrics(instance);
      data.verification.push({
        runtime,
        version: snapshot.name,
        pid: instance.child.pid,
        cases: 3,
      });
      return;
    }
    let beforeMetrics;
    const at = new Date().toISOString();
    const hostLoadBefore = os.loadavg();
    const load = await runLoad(
      {
        url: `${instance.url}/`,
        expectBody: "Hello World",
        connections: config.connections,
        duration: config.duration,
        processes: config.processes,
      },
      {
        signal: abort.signal,
        beforeMeasurement: async () => {
          beforeMetrics = await metrics(instance);
        },
      },
    );
    const afterMetrics = await metrics(instance);
    const serverCpu = cpuDelta(beforeMetrics, afterMetrics, load.total);
    assert(beforeMetrics.monotonicUs < afterMetrics.monotonicUs);
    await verify(instance);
    const result = {
      runtime,
      version: snapshot.name,
      round,
      order,
      pid: instance.child.pid,
      at,
      hostLoadBefore,
      hostLoadAfter: os.loadavg(),
      beforeMetrics,
      afterMetrics,
      serverCpu,
      load,
    };
    console.log(
      `${runtime} pair ${round}/${config.rounds} ${snapshot.name}: ${Math.round(load.rps).toLocaleString("en-US")} req/s; avg ${load.latency.average.toFixed(3)}ms p99 ${load.latency.p99}ms; CPU ${Math.round(serverCpu.nsPerRequest)}ns/req${load.clientCapacityConstrained ? " [CLIENT >=90%]" : ""}`,
    );
    return result;
  } finally {
    await stop(instance);
  }
};

try {
  for (const runtime of runtimes)
    for (const snapshot of snapshots) await sample(runtime, snapshot, 0, [], true);
  console.log(
    `All ${2 * runtimes.length} runtime/version combinations passed Hello World, 404, method and CPU IPC checks.`,
  );
  if (!verifyOnly) {
    for (let round = 1; round <= config.rounds; round++) {
      for (const runtime of round % 2 ? runtimes : runtimes.toReversed()) {
        const order = round % 2 ? snapshots : snapshots.toReversed();
        for (let attempt = 1; attempt <= 3; attempt++) {
          const pair = [];
          try {
            for (const snapshot of order)
              pair.push(
                await sample(
                  runtime,
                  snapshot,
                  round,
                  order.map((s) => s.name),
                ),
              );
            data.samples.push(...pair);
            await checkpoint();
            break;
          } catch (error) {
            if (
              !/^(wall clock and monotonic measurement window disagree|load start skew exceeds 50ms:)/.test(
                error.message,
              ) ||
              abort.signal.aborted
            )
              throw error;
            data.rejectedPairs.push({
              runtime,
              round,
              attempt,
              at: new Date().toISOString(),
              reason: String(error),
              completedSamples: pair,
            });
            await checkpoint();
            console.warn(
              `Rejected entire pair ${runtime}/${round}, attempt ${attempt}: ${error.message}`,
            );
            if (attempt === 3) throw error;
          }
        }
      }
    }
    assert.equal(data.samples.length, 2 * runtimes.length * config.rounds);
    data.summary = summarize(data);
  }
  for (const snapshot of snapshots)
    assert.equal(await sourceHash(snapshot.path), snapshot.sourceSha256, "frozen source changed");
  data.finishedAt = new Date().toISOString();
  data.environment.loadAtEnd = os.loadavg();
  if (!verifyOnly) {
    await checkpoint();
    await writeFile(join(output, "REPORT.md"), renderReport(data));
    console.log(`Report: ${join(output, "REPORT.md")}`);
  } else {
    await checkpoint();
    console.log(`Verified ${6 * runtimes.length} HTTP cases and CPU snapshots; no load generated.`);
  }
} catch (error) {
  data.failure = String(error);
  if (!verifyOnly) await checkpoint();
  throw error;
}
