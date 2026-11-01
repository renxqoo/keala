import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { aggregateLoad } from "./load-metrics.ts";

const require = createRequire(import.meta.url);
const hdr = require("hdr-histogram-js");
hdr.initWebAssemblySync();

const interruptible = async (operation, signal) => {
  signal.throwIfAborted();
  let cancel;
  const cancelled = new Promise((_resolve, reject) => {
    cancel = () => reject(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
  });
  try {
    return await Promise.race([operation(), cancelled]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
};

const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;

const sampleFromResult = (message, pid, connections) => {
  if (
    message.pid !== pid ||
    message.connections !== connections ||
    !positiveInteger(message.totalCompletedRequests) ||
    !Number.isSafeInteger(message.totalLatencyNs) ||
    message.totalLatencyNs < 0 ||
    !Array.isArray(message.bins) ||
    message.bins.length === 0
  ) {
    throw new Error("invalid native client result");
  }
  const histogram = hdr.build({
    useWebAssembly: true,
    bitBucketSize: 64,
    autoResize: true,
    lowestDiscernibleValue: 1,
    highestTrackableValue: 10000,
    numberOfSignificantValueDigits: 5,
  });
  let total = 0;
  let previous = -1;
  try {
    for (const bin of message.bins) {
      if (
        !Array.isArray(bin) ||
        bin.length !== 2 ||
        !Number.isSafeInteger(bin[0]) ||
        bin[0] <= previous ||
        bin[0] > 30000 ||
        !positiveInteger(bin[1])
      ) {
        throw new Error("invalid native client latency bin");
      }
      previous = bin[0];
      total += bin[1];
      if (!Number.isSafeInteger(total)) throw new Error("native request count overflow");
      histogram.recordValueWithCount(bin[0], bin[1]);
    }
    if (total !== message.totalCompletedRequests || histogram.totalCount !== total) {
      throw new Error("native latency histogram/completed request count mismatch");
    }
    return {
      driver: "native-go",
      pid: message.pid,
      env: message.env,
      runtimeVersion: message.runtimeVersion,
      connections: message.connections,
      startedAt: message.startedAt,
      finishedAt: message.finishedAt,
      cpu: message.cpu,
      result: {
        totalCompletedRequests: total,
        errors: 0,
        timeouts: 0,
        non2xx: 0,
        mismatches: 0,
        latencies: hdr.encodeIntoCompressedBase64(histogram),
      },
    };
  } finally {
    histogram.destroy();
  }
};

/**
 * One owned Go child, sharing runLoad's result and hooks. The executable must be
 * provided by BENCH_NATIVE_CLIENT; it is never built or installed implicitly.
 * Measurement drains requests issued before the deadline and includes that
 * drain in the reported wall/monotonic window. Warmup is excluded.
 */
export const runNativeLoad = async (options, hooks = {}) => {
  if (options.processes !== 1) throw new TypeError("native load requires processes=1");
  if (!positiveInteger(options.connections) || options.connections > 4096) {
    throw new TypeError("native connections must be 1..4096");
  }
  if (!positiveInteger(options.duration) || options.duration > 86400) {
    throw new TypeError("duration must be 1..86400 integer seconds");
  }
  if (options.body !== undefined && options.body !== "") {
    throw new TypeError("native load only supports an empty request body");
  }
  if (options.headers !== undefined && Object.keys(options.headers).length !== 0) {
    throw new TypeError("native load does not support custom request headers");
  }
  if (options.expectBody !== undefined && typeof options.expectBody !== "string") {
    throw new TypeError("expectBody must be a string");
  }
  const executable = process.env.BENCH_NATIVE_CLIENT;
  if (!executable) throw new Error("BENCH_NATIVE_CLIENT must name the native Go executable");
  hooks.signal?.throwIfAborted();
  const abort = new AbortController();
  const onAbort = () => abort.abort(hooks.signal?.reason ?? new Error("native load aborted"));
  hooks.signal?.addEventListener("abort", onAbort, { once: true });
  const watchdog = setTimeout(
    () => abort.abort(new Error("native load sample deadline exceeded")),
    (options.duration + 30) * 1000,
  );
  let child;
  let exited;
  let lines;
  let closed = false;
  try {
    child = spawn(executable, [], {
      env: { ...process.env, NODE_ENV: "production", GOMAXPROCS: "1" },
      stdio: ["pipe", "pipe", "inherit"],
    });
    const messages = [];
    let pending;
    let receivedResult = false;
    const fail = (error) => abort.abort(error);
    exited = new Promise((resolve) => {
      child.once("close", (code, signal) => {
        closed = true;
        if (code !== 0) fail(new Error(`native load client exited with ${code ?? signal}`));
        else if (!receivedResult) fail(new Error("native load client exited without a result"));
        resolve();
      });
      child.once("error", fail);
    });
    child.stdin.on("error", fail);
    lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("error", fail);
    lines.on("line", (line) => {
      try {
        const message = JSON.parse(line);
        if (
          message === null ||
          typeof message !== "object" ||
          !["ready", "warmed", "result", "error"].includes(message.kind)
        ) {
          throw new Error("invalid native client control message");
        }
        if (message.kind === "error") {
          throw new Error(String(message.error ?? "native client failed"));
        }
        if (message.kind === "result") receivedResult = true;
        if (pending) pending(message);
        else messages.push(message);
      } catch (error) {
        fail(error);
      }
    });
    const wait = (kind) =>
      new Promise((resolve, reject) => {
        const cancel = () => finish(undefined, abort.signal.reason);
        const finish = (message, error) => {
          pending = undefined;
          abort.signal.removeEventListener("abort", cancel);
          if (error !== undefined) reject(error);
          else if (message?.kind !== kind) {
            reject(new Error(`expected native ${kind}, received ${message?.kind}`));
          } else resolve(message);
        };
        abort.signal.addEventListener("abort", cancel, { once: true });
        if (abort.signal.aborted) return cancel();
        const message = messages.shift();
        if (message) finish(message);
        else pending = (value) => finish(value);
      });
    const send = (message) => {
      abort.signal.throwIfAborted();
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) fail(error);
      });
    };
    if (child.pid !== undefined) hooks.onSpawn?.(child.pid);
    await wait("ready");
    send({
      kind: "warmup",
      options: {
        url: options.url,
        method: options.method ?? "GET",
        expectBody: options.expectBody ?? "",
        connections: options.connections,
        duration: options.duration,
      },
    });
    await wait("warmed");
    await interruptible(async () => hooks.beforeMeasurement?.(abort.signal), abort.signal);
    send({ kind: "run" });
    const message = await wait("result");
    const exitDeadline = setTimeout(
      () => fail(new Error("native load client exit deadline exceeded")),
      2000,
    );
    try {
      await interruptible(() => exited, abort.signal);
      abort.signal.throwIfAborted();
    } finally {
      clearTimeout(exitDeadline);
    }
    return aggregateLoad([sampleFromResult(message, child.pid, options.connections)]);
  } finally {
    clearTimeout(watchdog);
    hooks.signal?.removeEventListener("abort", onAbort);
    abort.abort(new Error("native load closed"));
    if (child && exited && !closed) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      const killDeadline = setTimeout(() => child.kill("SIGKILL"), 2000);
      try {
        await exited;
      } finally {
        clearTimeout(killDeadline);
      }
    }
    lines?.close();
  }
};
