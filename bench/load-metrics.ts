import { createRequire } from "node:module";

interface Histogram {
  totalCount: number;
  mean: number;
  maxValue: number;
  getValueAtPercentile(value: number): number;
  add(other: Histogram): void;
}
// Pinned autocannon 8 raw-result protocol, shared with its own aggregator.
const require = createRequire(import.meta.url);
const { decodeHist } = require("autocannon/lib/histUtil.js") as {
  decodeHist(value: string): Histogram;
};

export interface CpuSnapshot {
  pid: number;
  cpu: { user: number; system: number };
  monotonicUs: number;
}

export interface ClientSample {
  pid: number;
  env: string;
  runtimeVersion: string;
  connections: number;
  startedAt: number;
  finishedAt: number;
  cpu: { user: number; system: number; elapsedUs: number };
  result: {
    totalCompletedRequests: number;
    errors: number;
    timeouts: number;
    non2xx: number;
    mismatches: number;
    latencies: string;
  };
}

const positive = (value: number): boolean => Number.isFinite(value) && value > 0;
const count = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

export const splitConnections = (connections: number, processes: number): number[] => {
  if (
    !count(connections) ||
    !count(processes) ||
    processes < 1 ||
    processes > 32 ||
    connections < processes
  ) {
    throw new TypeError("connections must be positive; processes must be 1..32 and <= connections");
  }
  return Array.from(
    { length: processes },
    (_, index) => Math.floor(connections / processes) + (index < connections % processes ? 1 : 0),
  );
};

export const cpuDelta = (before: CpuSnapshot, after: CpuSnapshot, requests: number) => {
  const user = after.cpu.user - before.cpu.user;
  const system = after.cpu.system - before.cpu.system;
  const elapsedUs = after.monotonicUs - before.monotonicUs;
  if (
    !count(before.pid) ||
    before.pid === 0 ||
    before.pid !== after.pid ||
    !count(user) ||
    !count(system) ||
    !positive(elapsedUs) ||
    !count(requests) ||
    requests === 0
  ) {
    throw new TypeError("invalid CPU measurement window");
  }
  const cores = (user + system) / elapsedUs;
  return {
    user,
    system,
    elapsedUs,
    cores,
    percentOfOneCore: cores * 100,
    nsPerRequest: ((user + system) * 1000) / requests,
  };
};

export const aggregateLoad = (samples: readonly ClientSample[]) => {
  if (samples.length === 0) throw new TypeError("load samples must not be empty");
  if (new Set(samples.map((sample) => sample.pid)).size !== samples.length)
    throw new Error("duplicate client PID");
  let merged: Histogram | undefined;
  let total = 0;
  const clients = samples.map((sample) => {
    const { result, cpu } = sample;
    if (
      sample.env !== "production" ||
      !/^v\d+\./.test(sample.runtimeVersion) ||
      !positive(sample.startedAt) ||
      !positive(sample.finishedAt - sample.startedAt) ||
      !count(sample.pid) ||
      !positive(sample.pid) ||
      !count(sample.connections) ||
      !positive(sample.connections) ||
      !count(result.totalCompletedRequests) ||
      result.totalCompletedRequests === 0 ||
      [result.errors, result.timeouts, result.non2xx, result.mismatches].some((n) => n !== 0) ||
      !count(cpu.user) ||
      !count(cpu.system) ||
      !positive(cpu.elapsedUs)
    ) {
      throw new TypeError("invalid or failed load sample");
    }
    // Date.now is cross-process comparable but adjustable; hrtime is monotonic.
    // Millisecond rounding is allowed, NTP/manual clock steps are not.
    if (Math.abs(sample.finishedAt - sample.startedAt - cpu.elapsedUs / 1000) > 2) {
      throw new Error("wall clock and monotonic measurement window disagree");
    }
    const histogram = decodeHist(result.latencies);
    if (histogram.totalCount !== result.totalCompletedRequests) {
      throw new Error("latency histogram/completed request count mismatch");
    }
    if (merged === undefined) merged = histogram;
    else merged.add(histogram);
    total += result.totalCompletedRequests;
    if (!count(total)) throw new Error("completed request count overflow");
    return {
      ...sample,
      cpu: { ...cpu, percentOfOneCore: (100 * (cpu.user + cpu.system)) / cpu.elapsedUs },
    };
  });
  const starts = samples.map((sample) => sample.startedAt);
  const startedAt = Math.min(...starts);
  const finishedAt = Math.max(...samples.map((sample) => sample.finishedAt));
  const startSkewMs = Math.max(...starts) - startedAt;
  if (startSkewMs > 50) throw new Error(`load start skew exceeds 50ms: ${startSkewMs}`);
  const duration = (finishedAt - startedAt) / 1000;
  const hist = merged!;
  return {
    rps: total / duration,
    total,
    duration,
    startedAt,
    finishedAt,
    startSkewMs,
    errors: 0,
    timeouts: 0,
    non2xx: 0,
    latency: {
      average: hist.mean,
      p50: hist.getValueAtPercentile(50),
      p90: hist.getValueAtPercentile(90),
      p99: hist.getValueAtPercentile(99),
      p99_9: hist.getValueAtPercentile(99.9),
      max: hist.maxValue,
      totalCount: hist.totalCount,
    },
    clientCapacityConstrained: clients.some((sample) => sample.cpu.percentOfOneCore >= 90),
    clients,
  };
};
