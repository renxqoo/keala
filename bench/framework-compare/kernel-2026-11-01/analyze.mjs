import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { median, geometricMean } from "../report.mjs";

export const readData = async (path) => {
  const bytes = await readFile(path);
  return JSON.parse(path.endsWith(".gz") ? gunzipSync(bytes).toString() : bytes.toString());
};
export const metrics = (data) =>
  data.stacks.flatMap((stack) =>
    data.scenarios.map((scenario) => {
      const samples = data.samples.filter(
        (s) => s.stack === stack.id && s.scenario === scenario.id,
      );
      assert.equal(samples.length, data.config.rounds);
      return {
        stack: stack.id,
        framework: stack.framework,
        runtime: stack.runtime,
        scenario: scenario.id,
        rounds: samples.length,
        rps: median(samples.map((s) => s.load.rps)),
        cpuUs: median(samples.map((s) => s.serverCpu.nsPerRequest / 1000)),
        meanMs: median(samples.map((s) => s.load.latency.average)),
        p50Ms: median(samples.map((s) => s.load.latency.p50)),
        p99Ms: median(samples.map((s) => s.load.latency.p99)),
        rpsRange: [
          Math.min(...samples.map((s) => s.load.rps)),
          Math.max(...samples.map((s) => s.load.rps)),
        ],
        cpuRange: [
          Math.min(...samples.map((s) => s.serverCpu.nsPerRequest / 1000)),
          Math.max(...samples.map((s) => s.serverCpu.nsPerRequest / 1000)),
        ],
        clientLimited: samples.some((s) => s.load.clientCapacityConstrained),
      };
    }),
  );
const fmt = (value) => Number(value).toFixed(2);
export const compare = (data) => {
  assert(!data.failure, data.failure);
  assert(data.finishedAt && data.cleanup.livePids.length === 0);
  const rows = metrics(data);
  const comparisons = [];
  for (const candidate of data.stacks.filter((s) => s.framework.startsWith("kernel"))) {
    for (const peer of data.stacks.filter(
      (s) => s.runtime === candidate.runtime && s.id !== candidate.id,
    )) {
      const pairs = data.scenarios.map((s) => ({
        scenario: s.id,
        candidate: rows.find((r) => r.stack === candidate.id && r.scenario === s.id),
        peer: rows.find((r) => r.stack === peer.id && r.scenario === s.id),
      }));
      const routes = pairs.filter((p) => p.scenario !== "hello");
      const hello = pairs.find((p) => p.scenario === "hello");
      comparisons.push({
        candidate: candidate.id,
        peer: peer.id,
        helloRpsPercent: hello ? (hello.candidate.rps / hello.peer.rps - 1) * 100 : null,
        helloCpuPercent: hello ? (hello.candidate.cpuUs / hello.peer.cpuUs - 1) * 100 : null,
        routesRpsPercent:
          routes.length === 12
            ? (geometricMean(routes.map((p) => p.candidate.rps / p.peer.rps)) - 1) * 100
            : null,
        routesCpuPercent:
          routes.length === 12
            ? (geometricMean(routes.map((p) => p.candidate.cpuUs / p.peer.cpuUs)) - 1) * 100
            : null,
        rpsWins: pairs.filter((p) => p.candidate.rps > p.peer.rps).length,
        cpuWins: pairs.filter((p) => p.candidate.cpuUs < p.peer.cpuUs).length,
        p99Wins: pairs.filter((p) => p.candidate.p99Ms < p.peer.p99Ms).length,
        p99NotWorse: pairs.filter((p) => p.candidate.p99Ms <= p.peer.p99Ms).length,
        total: pairs.length,
        details: pairs.map((p) => ({
          scenario: p.scenario,
          rpsPercent: (p.candidate.rps / p.peer.rps - 1) * 100,
          cpuPercent: (p.candidate.cpuUs / p.peer.cpuUs - 1) * 100,
          p99Ms: [p.candidate.p99Ms, p.peer.p99Ms],
        })),
      });
    }
  }
  return { rows, comparisons };
};
export const render = (data, analysis) => {
  const lines = [
    "# Kernel 架构实验：本阶段观测值",
    "",
    `完整样本 ${data.samples.length}，${data.config.rounds} 轮；每次 ${data.config.connections} 连接、预热 1 秒、测量 ${data.config.duration} 秒。`,
    "",
    "这是共享主机限额内的描述性中位数；三轮不构成稳定排名证明。12 路由为各路由中位数的几何平均，非混合流量。CPU百分比为负表示节省。毫秒延迟有量化和配额影响。",
    "",
    "| 候选 / 对照 | Hello吞吐变化 | Hello CPU变化 | 12路由吞吐变化 | 12路由CPU变化 | 吞吐更高中位数场景 | CPU更低场景 | p99更低 / 不高于 |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const c of analysis.comparisons)
    lines.push(
      `| ${c.candidate} / ${c.peer} | ${fmt(c.helloRpsPercent)}% | ${fmt(c.helloCpuPercent)}% | ${c.routesRpsPercent === null ? "—" : fmt(c.routesRpsPercent) + "%"} | ${c.routesCpuPercent === null ? "—" : fmt(c.routesCpuPercent) + "%"} | ${c.rpsWins}/${c.total} | ${c.cpuWins}/${c.total} | ${c.p99Wins} / ${c.p99NotWorse} |`,
    );
  lines.push(
    "",
    "| 场景 | 栈 | req/s | CPU µs/请求 | 平均延迟ms | p50 ms | p99 ms |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const r of analysis.rows)
    lines.push(
      `| ${r.scenario} | ${r.stack} | ${fmt(r.rps)} | ${fmt(r.cpuUs)} | ${fmt(r.meanMs)} | ${r.p50Ms} | ${r.p99Ms} |`,
    );
  return lines.join("\n") + "\n";
};
if (process.argv[2]) {
  const data = await readData(process.argv[2]);
  const analysis = compare(data);
  const output = process.argv[3];
  if (output) {
    await writeFile(output + ".json", JSON.stringify(analysis, null, 2) + "\n");
    await writeFile(output + ".md", render(data, analysis));
  }
  console.log(
    JSON.stringify(
      analysis.comparisons.map(({ details: _details, ...rest }) => rest),
      null,
      2,
    ),
  );
}
