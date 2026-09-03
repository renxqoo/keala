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
});
