import { describe, expect, it } from "vitest";
import { serverMetrics, validateServerMetrics } from "../bench/server-metrics.ts";

describe("R4.6 server measurement protocol", () => {
  it("validates PID, runtime, both production modes and CPU counters", () => {
    const snapshot = { ...serverMetrics("production"), env: "production" };
    expect(validateServerMetrics(snapshot, process.pid, snapshot.runtime)).toBe(snapshot);
    for (const value of [null, {}, { ...snapshot, protocol: 1 }]) {
      expect(() => validateServerMetrics(value, process.pid, snapshot.runtime)).toThrow(
        "protocol 2",
      );
    }
    for (const patch of [
      { pid: 0 },
      { runtime: "wrong" },
      { env: "development" },
      { applicationEnv: "development" },
      { runtimeVersion: null },
    ]) {
      expect(() =>
        validateServerMetrics({ ...snapshot, ...patch }, process.pid, snapshot.runtime),
      ).toThrow("mismatch");
    }
    for (const patch of [
      { cpu: null },
      { cpu: { user: NaN, system: 0 } },
      { monotonicUs: -1 },
      { rss: Infinity },
    ]) {
      expect(() =>
        validateServerMetrics({ ...snapshot, ...patch }, process.pid, snapshot.runtime),
      ).toThrow("snapshot");
    }
  });

  it("reports the pooling fixture switch and tolerates its absence in older payloads", () => {
    expect(serverMetrics("production").pooling).toBe(false);
    expect(serverMetrics("production", { pooling: true }).pooling).toBe(true);
    const pooled = { ...serverMetrics("production", { pooling: true }), env: "production" };
    expect(validateServerMetrics(pooled, process.pid, pooled.runtime)).toBe(pooled);
    expect(() =>
      validateServerMetrics({ ...pooled, pooling: "yes" }, process.pid, pooled.runtime),
    ).toThrow("config");
    const legacy: Record<string, unknown> = { ...pooled };
    delete legacy["pooling"];
    expect(validateServerMetrics(legacy, process.pid, pooled.runtime)).toBe(legacy);
  });

  it("reports the sink fixture switch and tolerates its absence in older payloads", () => {
    expect(serverMetrics("production").sink).toBe(false);
    expect(serverMetrics("production", { sink: "param" }).sink).toBe("param");
    const sunk = { ...serverMetrics("production", { sink: "text" }), env: "production" };
    expect(validateServerMetrics(sunk, process.pid, sunk.runtime)).toBe(sunk);
    expect(() => validateServerMetrics({ ...sunk, sink: 7 }, process.pid, sunk.runtime)).toThrow(
      "config",
    );
    const legacy: Record<string, unknown> = { ...sunk };
    delete legacy["sink"];
    expect(validateServerMetrics(legacy, process.pid, sunk.runtime)).toBe(legacy);
  });
});
