import { describe, expect, it } from "vitest";
import {
  remoteMatrix,
  balancedOrder,
  setOwnCpuPeriod,
  beforeMetadata,
} from "../../bench/framework-compare/remote-matrix.ts";

describe("remote diagnostic matrix controls", () => {
  it("selects both Kernel router strategies on either runtime", () => {
    const result = remoteMatrix({
      runtimes: ["node", "bun"],
      before: false,
      pilot: false,
      helloOnly: true,
      kernel: true,
      env: { BENCH_FRAMEWORKS: "kernel-regexp,kernel" },
    });
    expect(result.stacks.map((s) => s.id)).toEqual([
      "kernel-regexp-node",
      "kernel-node",
      "kernel-regexp-bun",
      "kernel-bun",
    ]);
  });
  it("keeps the native text probe on Node and requires explicit packaging", () => {
    const base = {
      runtimes: ["node", "bun"],
      before: false,
      pilot: false,
      helloOnly: true,
      kernel: true,
      env: { BENCH_FRAMEWORKS: "kernel-uws,kernel" },
    };
    expect(() => remoteMatrix(base)).toThrow();
    expect(remoteMatrix({ ...base, nativeText: true }).stacks.map((s) => s.id)).toEqual([
      "kernel-uws-node",
      "kernel-node",
      "kernel-bun",
    ]);
    expect(() =>
      remoteMatrix({
        ...base,
        nativeText: true,
        runtimes: ["bun"],
        env: { BENCH_FRAMEWORKS: "kernel-uws" },
      }),
    ).toThrow();
  });
  it("requires an explicitly packaged kernel to select the experimental entry", () => {
    const base = {
      runtimes: ["node", "bun"],
      before: false,
      pilot: false,
      helloOnly: false,
      env: { BENCH_FRAMEWORKS: "kernel,keala,hono,h3" },
    };
    expect(() => remoteMatrix(base)).toThrow();
    const result = remoteMatrix({ ...base, kernel: true });
    expect(result.stacks.map((s) => s.id)).toEqual([
      "kernel-node",
      "keala-node",
      "hono-node",
      "h3-node",
      "kernel-bun",
      "keala-bun",
      "hono-bun",
      "h3-bun",
    ]);
  });
  it("visits every position equally and reverses each adjacent pair", () => {
    const stacks = ["A", "B", "C", "D", "E", "F"];
    const positions = new Map(stacks.map((id) => [id, Array<number>(6).fill(0)]));
    for (let round = 1; round <= 12; round++) {
      const order = balancedOrder(stacks, 1, round) as string[];
      expect(new Set(order)).toEqual(new Set(stacks));
      order.forEach((id, index) => {
        positions.get(id)![index]!++;
      });
      if (round % 2 === 0) expect(order).toEqual(balancedOrder(stacks, 1, round - 1).toReversed());
    }
    for (const counts of positions.values()) expect(counts).toEqual([2, 2, 2, 2, 2, 2]);
  });
  it("selects real workload IDs without renumbering and keeps the default full matrix", () => {
    const base = { runtimes: ["node", "bun"], before: true, pilot: false, helloOnly: false };
    const full = remoteMatrix({ ...base, env: {} });
    expect(full.stacks).toHaveLength(8);
    expect(full.scenarios).toHaveLength(13);
    const selected = remoteMatrix({
      ...base,
      env: {
        BENCH_FRAMEWORKS: "keala-before,keala,hono",
        BENCH_SCENARIOS: "hello,route-8",
        BENCH_CPU_PERIODS_US: "1000,10000",
      },
    });
    expect(selected.stacks).toHaveLength(12);
    expect(
      selected.scenarios.map((s: { id: string; method: string; path: string }) => [
        s.id,
        s.method,
        s.path,
      ]),
    ).toEqual([
      ["hello", "GET", "/"],
      ["route-8", "POST", "/event/abcd1234/comment"],
    ]);
    for (const env of [
      { BENCH_SCENARIOS: "route-0" },
      { BENCH_FRAMEWORKS: "keala,keala" },
      { BENCH_CPU_PERIODS_US: "0" },
    ])
      expect(() => remoteMatrix({ ...base, env })).toThrow();
  });
  it("records the actually loaded same entry instead of the packaged mutant", () => {
    const baseline = { sourceSha256: "xi-source", distSha256: "xi-dist" };
    const before = { sourceSha256: "mutant-source", distSha256: "mutant-dist" };
    expect(beforeMetadata({ ...baseline, before }, "/bundle/.", "/bundle/")).toEqual({
      before: baseline,
      beforeKind: "same-entry-AA",
    });
    expect(beforeMetadata({ ...baseline, before }, "/bundle/before", "/bundle/")).toEqual({
      before,
      beforeKind: "packaged-before",
    });
  });
  it("changes only the owned quota file without raising its CPU budget", async () => {
    const values = new Map([["/owned/cpu.max", "15000 10000"]]);
    const read = async (path: string) => values.get(path)!;
    const write = async (path: string, value: string) => {
      values.set(path, value);
    };
    await setOwnCpuPeriod("/owned", { cpuMax: "15000 10000" }, 1000, read, write);
    expect([...values]).toEqual([["/owned/cpu.max", "1500 1000"]]);
    await expect(
      setOwnCpuPeriod("/owned", { cpuMax: "15000 10000" }, 500, read, write),
    ).rejects.toThrow();
  });
});
