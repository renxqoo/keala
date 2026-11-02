// Linux-only, sequential real-process benchmark. A systemd cgroup is mandatory.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import os from "node:os";
import { runLoad } from "../load-pool.ts";
import { cpuDelta } from "../load-metrics.ts";
import { HELLO, ROUTES, EXTRA_CHECKS } from "./scenarios.mjs";
import { summarize, renderRemoteReport } from "./report.mjs";
import { remoteMatrix, balancedOrder, setOwnCpuPeriod, beforeMetadata } from "./remote-matrix.ts";
import { verifyArtifacts, dependencyVersions } from "./remote-artifacts.mjs";

assert.equal(process.platform, "linux");
assert.equal(process.versions.bun, undefined);
assert.equal(process.versions.node.split(".")[0], "26");
const root = fileURLToPath(new URL("../../", import.meta.url));
process.chdir(root);
const pilot = process.argv.includes("--pilot");
const helloOnly = process.argv.includes("--hello");
const screen = process.argv.includes("--screen");
const verifyOnly = process.argv.includes("--verify-only");
const bun = process.env.BENCH_BUN ?? "/usr/local/bin/bun";
const bunVersion = execFileSync(bun, ["--version"], { encoding: "utf8" }).trim();
assert.equal(bunVersion, "1.4.4");
const output = resolve(process.env.BENCH_OUTPUT);
await mkdir(output, { recursive: false });
const config = {
  connections: pilot ? 10 : 50,
  duration: pilot ? 1 : 3,
  rounds: pilot || screen ? 1 : Number(process.env.BENCH_ROUNDS ?? 3),
  processes: 1,
  cooldownMs: 500,
  loadDriver: process.env.BENCH_NATIVE_CLIENT ? "native-go" : "autocannon",
  serverCpu: process.env.BENCH_SERVER_CPU,
  clientCpu: process.env.BENCH_CLIENT_CPU,
};
assert(Number.isInteger(config.rounds) && config.rounds > 0 && config.rounds <= 30);
for (const cpu of [config.serverCpu, config.clientCpu])
  if (cpu !== undefined) assert(/^\d+$/.test(cpu) && Number(cpu) < os.cpus().length);
if (config.clientCpu !== undefined) {
  const allowed = (await readFile("/proc/self/status", "utf8")).match(
    /^Cpus_allowed_list:\s+(.*)$/m,
  )?.[1];
  assert.equal(allowed, config.clientCpu, "coordinator and load must inherit the selected CPU");
}
const loadRunner = process.env.BENCH_NATIVE_CLIENT
  ? (await import("../native-load.mjs")).runNativeLoad
  : runLoad;
const selfCgroup = (await readFile("/proc/self/cgroup", "utf8"))
  .trim()
  .split("\n")
  .find((s) => s.startsWith("0::"))
  ?.slice(3);
assert(selfCgroup?.includes("keala-bench-"), "requires a dedicated keala-bench-* cgroup");
const cg = join("/sys/fs/cgroup", selfCgroup);
const read = (path) => readFile(path, "utf8");
const fields = (text) =>
  Object.fromEntries(
    text
      .trim()
      .split("\n")
      .map((line) => {
        const [key, value] = line.split(/\s+/);
        return [key, Number(value)];
      }),
  );
const limits = {
  cpuMax: (await read(join(cg, "cpu.max"))).trim(),
  memoryMax: Number(await read(join(cg, "memory.max"))),
  pidsMax: Number(await read(join(cg, "pids.max"))),
};
const [quota, period] = limits.cpuMax.split(" ").map(Number);
assert(quota > 0 && quota / period <= 1.5, "aggregate CPU must be capped at 1.5 cores");
assert(limits.memoryMax > 0 && limits.memoryMax <= 640 * 2 ** 20);
assert(limits.pidsMax > 0 && limits.pidsMax <= 128);
const abort = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, () => abort.abort(new Error(sig)));
const owned = new Set();
const instances = new Set();
const manifest = JSON.parse(await read(join(root, "manifest.json")));
await verifyArtifacts(manifest, process.env);
const runtimes = (process.env.BENCH_RUNTIMES ?? "node,bun").split(",");
assert(
  runtimes.length > 0 &&
    new Set(runtimes).size === runtimes.length &&
    runtimes.every((r) => r === "node" || r === "bun"),
);
const { stacks, scenarios } = remoteMatrix({
  runtimes,
  before: Boolean(process.env.BENCH_BEFORE),
  pilot,
  helloOnly,
  env: process.env,
});
const data = {
  startedAt: new Date().toISOString(),
  experiment: process.env.BENCH_EXPERIMENT,
  diagnosticOnly: process.env.BENCH_EXPERIMENT !== undefined,
  config,
  pilot,
  helloOnly,
  screen,
  verifyOnly,
  environment: {
    cpu: os.cpus()[0].model,
    cpus: os.cpus().length,
    memory: os.totalmem(),
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    loadAtStart: os.loadavg(),
  },
  versions: {
    node: process.versions.node,
    bun: bunVersion,
    ...(await dependencyVersions(root)),
  },
  source: {
    commit: manifest.commit,
    dirty: manifest.dirtyFiles.length !== 0,
    dirtyFiles: manifest.dirtyFiles,
    distSha256: manifest.distSha256,
    sourceSha256: manifest.sourceSha256,
    harnessSha256: manifest.harnessSha256,
    nativeClient: manifest.nativeClient,
    ...beforeMetadata(manifest, process.env.BENCH_BEFORE, root),
  },
  limits,
  stacks,
  scenarios,
  verification: [],
  samples: [],
  rejectedTimingSamples: [],
  health: [],
};
const health = async () => {
  const [mem, current, peak, cpu, events, pids, pressure] = await Promise.all([
    read("/proc/meminfo"),
    read(join(cg, "memory.current")),
    read(join(cg, "memory.peak")),
    read(join(cg, "cpu.stat")),
    read(join(cg, "memory.events")),
    read(join(cg, "pids.current")),
    read("/proc/pressure/memory"),
  ]);
  return {
    at: new Date().toISOString(),
    availableBytes: Number(mem.match(/^MemAvailable:\s+(\d+)/m)[1]) * 1024,
    cgroupBytes: Number(current),
    peakBytes: Number(peak),
    cpu: fields(cpu),
    events: fields(events),
    pids: Number(pids),
    load: os.loadavg(),
    memoryPressure: pressure.trim(),
  };
};
const check = async () => {
  const value = await health();
  data.health.push(value);
  if (
    value.availableBytes < 384 * 2 ** 20 ||
    value.cgroupBytes > 560 * 2 ** 20 ||
    value.events.oom > 0 ||
    value.events.oom_kill > 0 ||
    value.pids > 110 ||
    value.load[0] > 3.5
  )
    throw new Error(`resource guard stopped load: ${JSON.stringify(value)}`);
  return value;
};
let checking = false;
const monitor = setInterval(async () => {
  if (checking) return;
  checking = true;
  try {
    await check();
  } catch (error) {
    abort.abort(error);
  } finally {
    checking = false;
  }
}, 1000);
const pause = (ms) => new Promise((resolvePause) => setTimeout(resolvePause, ms));
const save = async () => {
  data.summary = summarize(data);
  await writeFile(join(output, "results.pending"), JSON.stringify(data, null, 2) + "\n");
  await rename(join(output, "results.pending"), join(output, "results.json"));
};
const start = async (stack, suite) => {
  abort.signal.throwIfAborted();
  await setOwnCpuPeriod(cg, limits, stack.cpuPeriodUs, read, writeFile);
  const runtime = stack.runtime === "node" ? process.execPath : bun;
  const child = spawn(
    config.serverCpu === undefined ? runtime : "taskset",
    [
      ...(config.serverCpu === undefined ? [] : ["--cpu-list", config.serverCpu, runtime]),
      join(root, "bench/framework-compare/server.mjs"),
      stack.framework,
      suite,
    ],
    {
      cwd: root,
      env: { ...process.env, NODE_ENV: "production" },
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    },
  );
  const instance = { child, stack, stopping: false, sequence: 0, pending: new Map() };
  owned.add(child.pid);
  instances.add(instance);
  instance.exited = new Promise((done) => {
    const failed = (reason) => {
      for (const pending of instance.pending.values()) pending.reject(reason);
      instance.pending.clear();
      if (!instance.stopping) abort.abort(reason);
      done();
    };
    child.once("error", failed);
    child.once("exit", (code, signal) => failed(new Error(`${stack.id} exited ${code ?? signal}`)));
  });
  child.on("message", (message) => {
    const key = message.kind === "ready" ? "ready" : message.id;
    const pending = instance.pending.get(key);
    if (pending) {
      instance.pending.delete(key);
      pending.resolve(message);
    }
  });
  instance.receive = (key) =>
    new Promise((resolveMessage, reject) => {
      const finish = (error, value) => {
        clearTimeout(timer);
        abort.signal.removeEventListener("abort", cancel);
        instance.pending.delete(key);
        if (error) reject(error);
        else resolveMessage(value);
      };
      const cancel = () => finish(abort.signal.reason);
      const timer = setTimeout(() => finish(new Error(`IPC timeout ${stack.id}/${key}`)), 10000);
      instance.pending.set(key, {
        resolve: (value) => finish(null, value),
        reject: (error) => finish(error),
      });
      abort.signal.addEventListener("abort", cancel, { once: true });
      if (abort.signal.aborted) cancel();
    });
  const ready = await instance.receive("ready");
  assert.equal(ready.pid, child.pid);
  if (config.serverCpu !== undefined) {
    const allowed = (await readFile(`/proc/${child.pid}/status`, "utf8")).match(
      /^Cpus_allowed_list:\s+(.*)$/m,
    )?.[1];
    assert.equal(allowed, config.serverCpu, "server CPU affinity differs");
  }
  assert.equal(ready.framework, stack.framework);
  if (stack.framework.startsWith("keala"))
    assert.equal(
      ready.kealaEntry,
      pathToFileURL(
        join(stack.framework === "keala-before" ? process.env.BENCH_BEFORE : root, "dist/index.js"),
      ).href,
    );
  instance.kealaEntry = ready.kealaEntry;
  assert.equal(ready.suite, suite);
  assert.equal(ready.runtime, stack.runtime);
  assert.equal(ready.version, data.versions[stack.runtime]);
  assert(Number.isSafeInteger(ready.port) && ready.port > 0);
  instance.url = `http://127.0.0.1:${ready.port}`;
  return instance;
};
const stop = async (instance) => {
  instance.stopping = true;
  if (instance.child.exitCode === null && instance.child.signalCode === null) {
    instance.child.kill("SIGTERM");
    const timer = setTimeout(() => instance.child.kill("SIGKILL"), 2000);
    try {
      await instance.exited;
    } finally {
      clearTimeout(timer);
    }
  }
  instances.delete(instance);
};
const metrics = async (instance) => {
  const id = ++instance.sequence;
  const pending = instance.receive(id);
  instance.child.send({ kind: "metrics", id }, (error) => {
    if (error) abort.abort(error);
  });
  const result = (await pending).metrics;
  assert.equal(result.pid, instance.child.pid);
  return result;
};
const verify = async (instance, suite) => {
  let checks = 0;
  const cases = suite === "hello" ? HELLO : [...ROUTES, ...EXTRA_CHECKS];
  for (const scenario of cases) {
    const response = await fetch(instance.url + scenario.path, {
      method: scenario.method,
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
    });
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("content-type").replaceAll(" ", "").toLowerCase(),
      "text/plain;charset=utf-8",
    );
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(scenario.body));
    checks++;
  }
  for (const [method, path] of suite === "hello"
    ? [["GET", "/missing"]]
    : [
        ["GET", "/missing"],
        ["GET", "/event/abcd1234/comment"],
      ]) {
    const response = await fetch(instance.url + path, {
      method,
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
    });
    assert([404, 405].includes(response.status));
    await response.arrayBuffer();
    checks++;
  }
  await metrics(instance);
  data.verification.push({ stack: instance.stack.id, suite, checks });
};
const sample = async (stack, scenario, round, order) => {
  await check();
  abort.signal.throwIfAborted();
  const instance = await start(stack, scenario.suite);
  const actualCpuMax = (await read(join(cg, "cpu.max"))).trim();
  try {
    let beforeMetrics, beforeHealth;
    const load = await loadRunner(
      {
        url: instance.url + scenario.path,
        method: scenario.method,
        expectBody: scenario.body,
        connections: config.connections,
        duration: config.duration,
        processes: 1,
      },
      {
        signal: abort.signal,
        onSpawn: (pid) => owned.add(pid),
        beforeMeasurement: async () => {
          beforeHealth = await check();
          beforeMetrics = await metrics(instance);
        },
      },
    );
    const afterMetrics = await metrics(instance);
    if (config.loadDriver === "native-go") {
      const version = load.clients[0].runtimeVersion;
      data.versions.nativeClient ??= version;
      assert.equal(data.versions.nativeClient, version);
    }
    const afterHealth = await check();
    const serverCpu = cpuDelta(beforeMetrics, afterMetrics, load.total);
    const value = {
      stack: stack.id,
      actualCpuMax,
      kealaEntry: instance.kealaEntry,
      scenario: scenario.id,
      round,
      order,
      at: new Date().toISOString(),
      pid: instance.child.pid,
      hostLoadBefore: beforeHealth.load,
      hostLoadAfter: afterHealth.load,
      beforeMetrics,
      afterMetrics,
      serverCpu,
      beforeHealth,
      afterHealth,
      cgroupThrottledUs: afterHealth.cpu.throttled_usec - beforeHealth.cpu.throttled_usec,
      load,
    };
    console.log(
      `${data.samples.length + 1} ${stack.id} ${scenario.id} r${round}: ${Math.round(load.rps)} req/s; CPU ${(serverCpu.nsPerRequest / 1000).toFixed(2)}us/req; p99 ${load.latency.p99}ms; client ${load.clients[0].cpu.percentOfOneCore.toFixed(1)}%`,
    );
    return value;
  } finally {
    await stop(instance);
  }
};
try {
  await check();
  for (const suite of new Set(scenarios.map((scenario) => scenario.suite))) {
    for (const stack of stacks) {
      const instance = await start(stack, suite);
      try {
        await verify(instance, suite);
      } finally {
        await stop(instance);
      }
    }
  }
  await save();
  console.log(
    `HTTP correctness: ${data.verification.reduce((n, v) => n + v.checks, 0)} checks passed.`,
  );
  if (!verifyOnly) {
    for (let scenarioIndex = 0; scenarioIndex < scenarios.length; scenarioIndex++) {
      const scenario = scenarios[scenarioIndex];
      for (let round = 1; round <= config.rounds; round++) {
        const order = balancedOrder(stacks, scenarioIndex, round);
        for (const stack of order) {
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              data.samples.push(
                await sample(
                  stack,
                  scenario,
                  round,
                  order.map((s) => s.id),
                ),
              );
              await save();
              break;
            } catch (error) {
              if (
                abort.signal.aborted ||
                !/^(wall clock and monotonic measurement window disagree|load start skew exceeds 50ms:)/.test(
                  error.message,
                )
              )
                throw error;
              data.rejectedTimingSamples.push({
                stack: stack.id,
                scenario: scenario.id,
                round,
                attempt,
                reason: String(error),
              });
              await save();
              if (attempt === 3) throw error;
            }
          }
          await pause(config.cooldownMs);
        }
      }
    }
    assert.equal(data.samples.length, stacks.length * scenarios.length * config.rounds);
  }
  data.finishedAt = new Date().toISOString();
} catch (error) {
  data.failure = String(error);
  console.error(error);
  process.exitCode = 1;
} finally {
  clearInterval(monitor);
  for (const instance of instances) await stop(instance);
  data.cleanup = {
    ownedPids: [...owned],
    livePids: [...owned].filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    }),
  };
  if (data.cleanup.livePids.length) {
    data.failure ??= "owned child processes still alive";
    process.exitCode = 1;
  }
  await writeFile(join(cg, "cpu.max"), limits.cpuMax);
  data.restoredCpuMax = (await read(join(cg, "cpu.max"))).trim();
  assert.equal(data.restoredCpuMax, limits.cpuMax);
  data.health.push(await health());
  data.environment.loadAtEnd = os.loadavg();
  await save();
  if (data.samples.length) {
    await writeFile(join(output, "REPORT.md"), renderRemoteReport(data));
  }
}
