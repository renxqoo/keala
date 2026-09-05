import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  aggregateLoad,
  cpuDelta,
  splitConnections,
  type ClientSample,
} from "../../bench/load-metrics.ts";

const require = createRequire(import.meta.url);
const hdr = require("hdr-histogram-js") as {
  build(): { recordValueWithCount(value: number, count: number): void };
  encodeIntoCompressedBase64(value: unknown): string;
};
const sample = (count: number, value: number, start = 1000, finish = 2000): ClientSample => {
  const hist = hdr.build();
  hist.recordValueWithCount(value, count);
  return {
    pid: count,
    env: "production",
    runtimeVersion: "v22.0.0",
    connections: 1,
    startedAt: start,
    finishedAt: finish,
    cpu: { user: 200000, system: 100000, elapsedUs: (finish - start) * 1000 },
    result: {
      totalCompletedRequests: count,
      errors: 0,
      timeouts: 0,
      non2xx: 0,
      mismatches: 0,
      latencies: hdr.encodeIntoCompressedBase64(hist),
    },
  };
};

describe("R4.6 multiprocess measurement", () => {
  it("distributes total connections exactly, never per-process multiplicatively", () => {
    expect(splitConnections(201, 4)).toEqual([51, 50, 50, 50]);
    expect(splitConnections(1, 1)).toEqual([1]);
    for (const args of [
      [2, 3],
      [0, 1],
      [2, 0],
      [2.5, 1],
      [100, 33],
    ]) {
      expect(() => splitConnections(args[0]!, args[1]!)).toThrow();
    }
  });
  it("merges histogram counts, not per-process percentiles", () => {
    const result = aggregateLoad([sample(990, 1), sample(10, 100)]);
    expect(result.total).toBe(1000);
    expect(result.latency.p99).toBe(1);
    expect(result.latency.p99_9).toBe(100);
    expect(result.latency.totalCount).toBe(1000);
    expect(result.rps).toBe(1000);
  });
  it("uses the union window and records start skew", () => {
    const result = aggregateLoad([sample(100, 1), sample(200, 1, 1010, 2110)]);
    expect(result.duration).toBe(1.11);
    expect(result.rps).toBeCloseTo(300 / 1.11);
    expect(result.startSkewMs).toBe(10);
  });
  it("rejects missing, failed, skewed and corrupt samples", () => {
    expect(() => aggregateLoad([])).toThrow();
    const bad = sample(100, 1);
    expect(() => aggregateLoad([bad, bad])).toThrow("duplicate");
    expect(() => aggregateLoad([{ ...bad, env: "development" }])).toThrow();
    expect(() =>
      aggregateLoad([{ ...bad, result: { ...bad.result, latencies: "corrupt" } }]),
    ).toThrow();
    expect(() => aggregateLoad([{ ...bad, result: { ...bad.result, errors: 1 } }])).toThrow();
    expect(() =>
      aggregateLoad([{ ...bad, result: { ...bad.result, totalCompletedRequests: 99 } }]),
    ).toThrow();
    expect(() => aggregateLoad([bad, sample(200, 1, 1051, 2051)])).toThrow();
    expect(() => aggregateLoad([{ ...bad, finishedAt: 1000 }])).toThrow();
    expect(() => aggregateLoad([{ ...bad, cpu: { ...bad.cpu, user: NaN } }])).toThrow();
  });
  it("measures CPU differences in single-core units, not machine percent", () => {
    const before = { pid: 1, cpu: { user: 100, system: 100 }, monotonicUs: 1000 };
    const after = { pid: 1, cpu: { user: 1600, system: 600 }, monotonicUs: 2000 };
    expect(cpuDelta(before, after, 10)).toEqual({
      user: 1500,
      system: 500,
      elapsedUs: 1000,
      cores: 2,
      percentOfOneCore: 200,
      nsPerRequest: 200000,
    });
    expect(() => cpuDelta(before, { ...after, pid: 2 }, 10)).toThrow();
    expect(() => cpuDelta(after, before, 10)).toThrow();
    expect(() => cpuDelta(before, after, 0)).toThrow();
  });
  it("flags client capacity saturation without discarding its evidence", () => {
    const one = sample(100, 1);
    one.cpu.user = 900000;
    const result = aggregateLoad([one]);
    expect(result.clientCapacityConstrained).toBe(true);
    expect(result.clients[0]!.cpu.percentOfOneCore).toBe(100);
  });

  it("B46-6 rejects wall-clock jumps even when all clients jump together", () => {
    const one = sample(100, 1);
    const two = sample(200, 1);
    expect(() =>
      aggregateLoad([one, two].map((value) => ({ ...value, finishedAt: value.finishedAt + 1000 }))),
    ).toThrow("clock");
    expect(() => aggregateLoad([{ ...one, finishedAt: one.finishedAt - 100 }])).toThrow("clock");
    expect(aggregateLoad([{ ...one, finishedAt: one.finishedAt + 1 }]).total).toBe(100);
  });
});
