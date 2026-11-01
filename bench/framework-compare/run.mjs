import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runLoad } from "../load-pool.ts";
import { HELLO, ROUTES, EXTRA_CHECKS } from "./scenarios.mjs";
import { renderReport, summarize } from "./report.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
process.chdir(root);
if (process.versions.bun !== undefined || process.versions.node.split(".")[0] !== "26") {
  throw new Error("Run the orchestrator with real Node 26");
}
const bun = process.env.BENCH_BUN ?? "bun";
const bunVersion = execFileSync(bun, ["--version"], { encoding: "utf8" }).trim();
assert.equal(bunVersion, "1.4.4", "This matrix requires Bun 1.4.4");
const args = process.argv.slice(2);
const verifyOnly = args.includes("--verify-only");
const positional = args.filter((arg) => arg !== "--verify-only");
if (positional.length > 4)
  throw new Error(
    "usage: node run.mjs [connections=200] [seconds=5] [rounds=3] [processes=4] [--verify-only]",
  );
const config = {
  connections: Number(positional[0] ?? 200),
  duration: Number(positional[1] ?? 5),
  rounds: Number(positional[2] ?? 3),
  processes: Number(positional[3] ?? 4),
};
for (const [name, value] of Object.entries(config)) {
  assert(Number.isSafeInteger(value) && value > 0, `${name} must be a positive integer`);
}
assert(config.processes <= 32 && config.connections >= config.processes);
const output = resolve(process.env.BENCH_OUTPUT ?? join(root, "bench/framework-compare"));
await mkdir(output, { recursive: true });
const packageVersion = async (path) => JSON.parse(await readFile(join(root, path), "utf8")).version;
const hashTree = async (directory, prefix = "", hash = createHash("sha256")) => {
  for (const item of (await readdir(directory, { withFileTypes: true })).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const relative = `${prefix}${item.name}`;
    if (item.isDirectory()) await hashTree(join(directory, item.name), `${relative}/`, hash);
    else
      hash
        .update(relative)
        .update("\0")
        .update(await readFile(join(directory, item.name)))
        .update("\0");
  }
  return hash;
};
const git = (...arguments_) =>
  execFileSync("git", arguments_, { cwd: root, encoding: "utf8" }).trim();
const stacks = ["node", "bun"].flatMap((runtime) =>
  ["keala", "hono", "h3"].map((framework) => ({
    id: `${framework}-${runtime}`,
    framework,
    runtime,
  })),
);
const scenarios = [
  { ...HELLO[0], id: "hello", suite: "hello" },
  ...ROUTES.map((route, i) => ({ ...route, id: `route-${i + 1}`, suite: "routes" })),
];
const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => abort.abort(new Error(`interrupted by ${signal}`)));
}
const dirtyFiles = git("status", "--porcelain");
const data = {
  startedAt: new Date().toISOString(),
  config,
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
    keala: await packageVersion("package.json"),
    hono: await packageVersion("node_modules/hono/package.json"),
    h3: await packageVersion("node_modules/h3/package.json"),
    honoNode: await packageVersion("node_modules/@hono/node-server/package.json"),
    srvx: await packageVersion("node_modules/srvx/package.json"),
    autocannon: await packageVersion("node_modules/autocannon/package.json"),
  },
  source: {
    commit: git("rev-parse", "HEAD"),
    dirty: dirtyFiles !== "",
    dirtyFiles: dirtyFiles.split("\n"),
    distSha256: (await hashTree(join(root, "dist"))).digest("hex"),
  },
  stacks,
  scenarios,
  verification: [],
  samples: [],
  rejectedTimingSamples: [],
};

const stop = async (instance) => {
  if (instance.child.exitCode !== null || instance.child.signalCode !== null) return;
  instance.stopping = true;
  instance.child.kill("SIGTERM");
  const timer = setTimeout(() => instance.child.kill("SIGKILL"), 2000);
  try {
    await instance.exited;
  } finally {
    clearTimeout(timer);
  }
};
const start = async (stack, suite, instances) => {
  const child = spawn(
    stack.runtime === "node" ? process.execPath : bun,
    [join(root, "bench/framework-compare/server.mjs"), stack.framework, suite],
    {
      cwd: root,
      env: { ...process.env, NODE_ENV: "production" },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const instance = { child, stack, stopping: false };
  instances.push(instance);
  let failReady;
  instance.exited = new Promise((resolveExit) => {
    child.once("exit", (code, signal) => {
      resolveExit();
      if (!instance.stopping) {
        const error = new Error(`${stack.id} exited unexpectedly (${code ?? signal})`);
        failReady?.(error);
        abort.abort(error);
      }
    });
    child.once("error", (error) => {
      resolveExit();
      failReady?.(error);
      abort.abort(error);
    });
  });
  const ready = new Promise((resolveReady, rejectReady) => {
    failReady = rejectReady;
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.includes("\n")) {
        try {
          resolveReady(JSON.parse(buffer.slice(0, buffer.indexOf("\n"))));
        } catch (error) {
          rejectReady(error);
        }
      }
    });
  });
  const timer = setTimeout(() => failReady(new Error(`${stack.id} startup timed out`)), 15000);
  try {
    instance.identity = await ready;
    assert.equal(instance.identity.kind, "ready");
    assert.equal(instance.identity.pid, child.pid);
    assert.equal(instance.identity.framework, stack.framework);
    assert.equal(instance.identity.suite, suite);
    assert.equal(instance.identity.runtime, stack.runtime);
    assert.equal(instance.identity.version, data.versions[stack.runtime]);
    assert(Number.isSafeInteger(instance.identity.port) && instance.identity.port > 0);
    instance.url = `http://127.0.0.1:${instance.identity.port}`;
    return instance;
  } finally {
    clearTimeout(timer);
  }
};

const verify = async (instance, suite) => {
  let checked = 0;
  for (const scenario of suite === "hello" ? HELLO : [...ROUTES, ...EXTRA_CHECKS]) {
    abort.signal.throwIfAborted();
    const response = await fetch(`${instance.url}${scenario.path}`, {
      method: scenario.method,
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
    });
    assert.equal(response.status, 200, `${instance.stack.id} ${scenario.path}`);
    assert.equal(
      (response.headers.get("content-type") ?? "").replaceAll(" ", "").toLowerCase(),
      "text/plain;charset=utf-8",
    );
    assert.deepEqual(
      Buffer.from(await response.arrayBuffer()),
      Buffer.from(scenario.body),
      `${instance.stack.id} ${scenario.path}`,
    );
    checked++;
  }
  for (const [method, path] of suite === "hello"
    ? [["GET", "/missing"]]
    : [
        ["GET", "/missing"],
        ["GET", "/event/abcd1234/comment"],
      ]) {
    const response = await fetch(`${instance.url}${path}`, {
      method,
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
    });
    assert([404, 405].includes(response.status), `${instance.stack.id} accepted ${method} ${path}`);
    await response.arrayBuffer();
    checked++;
  }
  data.verification.push({ ...instance.identity, checks: checked });
};
const checkpoint = async () => {
  data.summary = summarize(data);
  await writeFile(join(output, "results.json"), `${JSON.stringify(data, null, 2)}\n`);
};

try {
  for (const suite of ["hello", "routes"]) {
    const instances = [];
    try {
      for (const stack of stacks) {
        abort.signal.throwIfAborted();
        await verify(await start(stack, suite, instances), suite);
      }
      console.log(`${suite}: all six stacks passed HTTP correctness checks`);
      if (verifyOnly) continue;
      const suiteScenarios = scenarios.filter((s) => s.suite === suite);
      // Rotate across both scenarios and rounds. Alternate direction to reduce
      // order bias even when fewer than six rounds are requested.
      for (let scenarioIndex = 0; scenarioIndex < suiteScenarios.length; scenarioIndex++) {
        const scenario = suiteScenarios[scenarioIndex];
        for (let round = 0; round < config.rounds; round++) {
          const offset = (scenarioIndex + round) % stacks.length;
          const order = [...instances.slice(offset), ...instances.slice(0, offset)];
          if (round % 2) order.reverse();
          for (const instance of order) {
            abort.signal.throwIfAborted();
            let load;
            let hostLoadBefore;
            for (let attempt = 1; attempt <= 3; attempt++) {
              hostLoadBefore = os.loadavg();
              try {
                load = await runLoad(
                  {
                    url: `${instance.url}${scenario.path}`,
                    method: scenario.method,
                    expectBody: scenario.body,
                    connections: config.connections,
                    duration: config.duration,
                    processes: config.processes,
                  },
                  { signal: abort.signal },
                );
                break;
              } catch (error) {
                if (
                  !/^(wall clock and monotonic measurement window disagree|load start skew exceeds 50ms:)/.test(
                    error.message,
                  ) ||
                  abort.signal.aborted
                )
                  throw error;
                data.rejectedTimingSamples.push({
                  scenario: scenario.id,
                  stack: instance.stack.id,
                  round: round + 1,
                  attempt,
                  at: new Date().toISOString(),
                  hostLoad: os.loadavg(),
                  reason: String(error),
                });
                await checkpoint();
                console.warn(
                  `Rejected timing sample: ${scenario.id} ${instance.stack.id}, attempt ${attempt}: ${error.message}`,
                );
                if (attempt === 3) throw error;
              }
            }
            data.samples.push({
              scenario: scenario.id,
              stack: instance.stack.id,
              round: round + 1,
              order: order.map((entry) => entry.stack.id),
              server: instance.identity,
              hostLoadBefore,
              hostLoadAfter: os.loadavg(),
              load,
            });
            await checkpoint();
            console.log(
              `${scenario.id} ${instance.stack.id} round ${round + 1}/${config.rounds}: ${Math.round(load.rps).toLocaleString("en-US")} req/s, p99 ${load.latency.p99}ms${load.clientCapacityConstrained ? " [CLIENT CPU >=90%]" : ""}`,
            );
          }
        }
      }
    } finally {
      await Promise.all(instances.map(stop));
    }
  }
  data.finishedAt = new Date().toISOString();
  data.environment.loadAtEnd = os.loadavg();
  assert.equal(
    (await hashTree(join(root, "dist"))).digest("hex"),
    data.source.distSha256,
    "dist changed during benchmark",
  );
  if (!verifyOnly) {
    assert.equal(data.samples.length, scenarios.length * stacks.length * config.rounds);
    assert(data.summary.every((row) => row.rounds === config.rounds));
    await checkpoint();
    await writeFile(join(output, "REPORT.md"), renderReport(data));
    console.log(`Report: ${join(output, "REPORT.md")}`);
  } else {
    console.log(
      `Verified ${data.verification.reduce((sum, item) => sum + item.checks, 0)} HTTP cases across both runtimes; no load generated.`,
    );
  }
} catch (error) {
  if (!verifyOnly) {
    data.failure = String(error);
    await checkpoint();
  }
  throw error;
}
