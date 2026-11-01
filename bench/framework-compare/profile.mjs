// Diagnostic only: node profile.mjs FRAMEWORK SUITE PATH EXPECT_BODY OUTPUT.cpuprofile
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { runLoad } from "../load-pool.ts";
import { cpuDelta } from "../load-metrics.ts";

const [framework, suite, path, expectBody, output] = process.argv.slice(2);
assert(
  framework && suite && path && expectBody && output,
  "provide framework, suite, path, expected body and output",
);
const config = {
  connections: Number(process.env.BENCH_PROFILE_CONNECTIONS ?? 200),
  duration: Number(process.env.BENCH_PROFILE_DURATION ?? 8),
  processes: Number(process.env.BENCH_PROFILE_PROCESSES ?? 4),
};
const profiler = process.env.BENCH_PROFILE_ENABLED !== "0";
for (const value of Object.values(config)) assert(Number.isInteger(value) && value > 0);
assert(config.connections <= 200 && config.duration <= 30 && config.processes <= 4);
const child = spawn(
  process.execPath,
  [
    fileURLToPath(new URL(profiler ? "./profile-server.mjs" : "./server.mjs", import.meta.url)),
    framework,
    suite,
  ],
  {
    env: { ...process.env, NODE_ENV: "production" },
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  },
);
const exited = new Promise((done) => {
  child.once("exit", done);
  child.once("error", done);
});
let id = 0;
const receive = (kind, requestId) =>
  new Promise((done, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", message);
      child.off("exit", failed);
      child.off("error", rejectError);
    };
    const rejectError = (error) => {
      cleanup();
      reject(error);
    };
    const failed = () => rejectError(new Error("profile server exited"));
    const message = (value) => {
      if (value.kind !== kind || (requestId !== undefined && value.id !== requestId)) return;
      cleanup();
      if (value.error) reject(new Error(value.error));
      else done(value);
    };
    const timer = setTimeout(() => rejectError(new Error(`profile IPC ${kind} timeout`)), 15000);
    child.on("message", message).once("exit", failed).once("error", rejectError);
  });
const request = (kind, args = {}) => {
  const next = ++id;
  const pending = receive(kind, next);
  child.send({ kind, id: next, ...args });
  return pending;
};
try {
  const ready = await receive("ready");
  const url = `http://127.0.0.1:${ready.port}${path}`;
  assert.equal(await (await fetch(url)).text(), expectBody);
  let before;
  const load = await runLoad(
    { url, ...config, expectBody },
    {
      beforeMeasurement: async () => {
        if (profiler) await request("profile", { action: "start" });
        before = (await request("metrics")).metrics;
      },
    },
  );
  const after = (await request("metrics")).metrics;
  if (profiler) await request("profile", { action: "stop", file: resolve(output) });
  console.log(
    JSON.stringify({
      profile: profiler ? resolve(output) : null,
      framework,
      suite,
      path,
      config,
      profiler,
      diagnosticOnly: true,
      rps: load.rps,
      cpu: cpuDelta(before, after, load.total),
      latency: load.latency,
    }),
  );
} finally {
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}
