import { describe, expect, it } from "vitest";
import { comparePaired, median, positiveInteger } from "../bench/hotpath-metrics.ts";

describe("paired hotpath benchmark statistics", () => {
  it("does not substitute the ratio of independent medians for paired ratios", () => {
    const stats = comparePaired([120, 210, 1200], [100, 200, 1000]);
    expect(stats.medianRatio).toBe(1.2);
    expect(stats.independentMedianRatio).toBe(1.05);
    expect(stats.pairedRatios).toEqual([1.2, 1.05, 1.2]);
    expect(stats.minRatio).toBe(1.05);
    expect(stats.maxRatio).toBe(1.2);
  });
  it("averages even samples without changing round order", () => {
    const values = [9, 1, 5, 3];
    expect(median(values)).toBe(4);
    expect(values).toEqual([9, 1, 5, 3]);
    expect(median([2])).toBe(2);
  });
  it("rejects missing, unpaired, failed or nonfinite measurements", () => {
    expect(() => comparePaired([], [])).toThrow(TypeError);
    expect(() => comparePaired([1], [1, 2])).toThrow(TypeError);
    expect(() => comparePaired([1], [0])).toThrow(TypeError);
    expect(() => comparePaired([NaN], [1])).toThrow(TypeError);
    expect(() => median([])).toThrow(TypeError);
    expect(() => median([Infinity])).toThrow(TypeError);
  });
  it("rejects invalid parameters before starting servers", () => {
    expect(positiveInteger(undefined, 5, "rounds")).toBe(5);
    expect(positiveInteger("200", 5, "connections")).toBe(200);
    for (const value of ["", "0", "-1", "1.5", "Infinity", "invalid"]) {
      expect(() => positiveInteger(value, 5, "rounds")).toThrow(TypeError);
    }
  });
});
