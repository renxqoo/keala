import assert from "node:assert/strict";
import { median, comparePaired } from "../hotpath-metrics.ts";

export const summarize = (data) =>
  (data.runtimes ?? ["node", "bun"]).map((runtime) => {
    const groups = ["before", "after"].map((version) => {
      const samples = data.samples
        .filter((s) => s.runtime === runtime && s.version === version)
        .toSorted((a, b) => a.round - b.round);
      return {
        version,
        samples: samples.length,
        rps: median(samples.map((s) => s.load.rps)),
        rpsRange: [
          Math.min(...samples.map((s) => s.load.rps)),
          Math.max(...samples.map((s) => s.load.rps)),
        ],
        latencyAverage: median(samples.map((s) => s.load.latency.average)),
        p50: median(samples.map((s) => s.load.latency.p50)),
        p99: median(samples.map((s) => s.load.latency.p99)),
        p99Range: [
          Math.min(...samples.map((s) => s.load.latency.p99)),
          Math.max(...samples.map((s) => s.load.latency.p99)),
        ],
        cpuNsPerRequest: median(samples.map((s) => s.serverCpu.nsPerRequest)),
        cpuRange: [
          Math.min(...samples.map((s) => s.serverCpu.nsPerRequest)),
          Math.max(...samples.map((s) => s.serverCpu.nsPerRequest)),
        ],
        serverCpuPercent: median(samples.map((s) => s.serverCpu.percentOfOneCore)),
      };
    });
    const before = data.samples
      .filter((s) => s.runtime === runtime && s.version === "before")
      .toSorted((a, b) => a.round - b.round);
    const after = data.samples
      .filter((s) => s.runtime === runtime && s.version === "after")
      .toSorted((a, b) => a.round - b.round);
    assert.deepEqual(
      before.map((s) => s.round),
      after.map((s) => s.round),
    );
    return {
      runtime,
      groups,
      throughput: comparePaired(
        after.map((s) => s.load.rps),
        before.map((s) => s.load.rps),
      ),
      cpu: comparePaired(
        after.map((s) => s.serverCpu.nsPerRequest),
        before.map((s) => s.serverCpu.nsPerRequest),
      ),
      throughputIncreasePairs: after.filter((s, i) => s.load.rps > before[i].load.rps).length,
      cpuIncreasePairs: after.filter(
        (s, i) => s.serverCpu.nsPerRequest > before[i].serverCpu.nsPerRequest,
      ).length,
    };
  });

const format = (n) => Math.round(n).toLocaleString("en-US");
const percent = (ratio) => `${ratio >= 1 ? "+" : ""}${((ratio - 1) * 100).toFixed(1)}%`;
const localTime = (value) =>
  new Date(value).toLocaleString("sv-SE", { timeZone: "Asia/Singapore" });

export const renderReport = (data) => {
  const summaries = summarize(data);
  const lines = [
    `# Keala ${data.description ?? "重构前后"}：Hello World 同机 A/B`,
    "",
    `- 时间：${localTime(data.startedAt)} → ${localTime(data.finishedAt)}（Asia/Singapore，UTC+8）。`,
    `- 机器：${data.environment.cpu}，${data.environment.cpus} 逻辑 CPU，${data.environment.memory / 2 ** 30} GiB，${data.environment.platform} ${data.environment.arch}。`,
    `- 运行时：Node ${data.versions.node}、Bun ${data.versions.bun}；编译器 TypeScript ${data.versions.typescript}；srvx ${data.versions.srvx}；autocannon ${data.versions.autocannon}。`,
    `- 实测运行时：${(data.runtimes ?? ["node", "bun"]).join(", ")}；负载客户端始终使用 Node。`,
    `- 负载：${data.config.connections} 个总连接，${data.config.processes} 个独立 Node 客户端进程，HTTP/1.1 keep-alive，pipelining=1。每样本预热 1 秒，测量 ${data.config.duration} 秒；每运行时 ${data.config.rounds} 对 A/B。`,
    "- 每次使用全新的服务端进程。仅注册 GET /，返回 Hello World；无中间件、无 pooling、无 sink。两份源码使用同一套编译配置和依赖构建成 JS；测量中不运行 TypeScript 编译器或类型剥离器。",
    "- 每轮把同一运行时的 before / after 背靠背测量，奇偶轮交换先后；运行时首发顺序也轮换。只对计时无效的一整对样本重试，不按快慢筛选样本。",
    "- CPU/请求 = 服务端进程 user+system CPU 增量 / 客户端已完成请求数，单位 ns/req，包含传输、路由、处理器、GC 等进程 CPU；不包括负载客户端 CPU。冷 IPC 快照在预热后和测量结束后读取，窗口包含开始屏障及客户端收尾，不能当作单独 handler 的 CPU 时间。",
    "- 吞吐由完成请求数除以实际客户端窗口计算；延迟来自合并后的毫秒量化直方图，0 不表示零延迟，平均值的小数也不代表微秒精度。表格为各样本统计量的中位数，变化为同轮 after/before 比值的中位数，两者不能混为一谈。",
    `- 主机一分钟负载（样本前后）范围 ${Math.min(...data.samples.flatMap((s) => [s.hostLoadBefore[0], s.hostLoadAfter[0]])).toFixed(2)}–${Math.max(...data.samples.flatMap((s) => [s.hostLoadBefore[0], s.hostLoadAfter[0]])).toFixed(2)}；客户端最高单核 CPU ${Math.max(...data.samples.flatMap((s) => s.load.clients.map((c) => c.cpu.percentOfOneCore))).toFixed(1)}%。`,
    `- 严格计时校验导致 ${data.rejectedPairs.length} 对被拒绝并整对重测，原因和被拒绝的已完成样本保存在 results.json。响应错误、超时、非 2xx、正文不匹配不重试。`,
    "",
    "## 结果",
    "",
    "| 运行时 | 版本 | req/s | 平均延迟 ms | p50 ms | p99 ms | 服务端 CPU ns/req | 服务端 CPU 单核 % |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const summary of summaries)
    for (const group of summary.groups) {
      lines.push(
        `| ${summary.runtime} | ${group.version} | ${format(group.rps)} | ${group.latencyAverage.toFixed(3)} | ${group.p50.toFixed(2)} | ${group.p99.toFixed(2)} | ${format(group.cpuNsPerRequest)} | ${group.serverCpuPercent.toFixed(1)} |`,
      );
    }
  lines.push(
    "",
    "## 配对变化（after / before）",
    "",
    "比值范围是实测最小–最大值，不是置信区间。吞吐越高越好，CPU/请求越低越好。",
    "",
    "| 运行时 | 吞吐变化中位数 | 吞吐比值范围 | CPU/请求变化中位数 | CPU 比值范围 | 吞吐增加对数 | CPU/请求增加对数 |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const s of summaries)
    lines.push(
      `| ${s.runtime} | ${percent(s.throughput.medianRatio)} | ${s.throughput.minRatio.toFixed(3)}–${s.throughput.maxRatio.toFixed(3)} | ${percent(s.cpu.medianRatio)} | ${s.cpu.minRatio.toFixed(3)}–${s.cpu.maxRatio.toFixed(3)} | ${s.throughputIncreasePairs}/${data.config.rounds} | ${s.cpuIncreasePairs}/${data.config.rounds} |`,
    );
  lines.push(
    "",
    "## 每轮原始读数",
    "",
    "| 运行时 | 轮 | 版本 | req/s | 平均延迟 ms | p50 ms | p99 ms | CPU ns/req | 主机一分钟负载 |",
    "| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const s of data.samples)
    lines.push(
      `| ${s.runtime} | ${s.round} | ${s.version} | ${format(s.load.rps)} | ${s.load.latency.average.toFixed(3)} | ${s.load.latency.p50} | ${s.load.latency.p99} | ${format(s.serverCpu.nsPerRequest)} | ${s.hostLoadBefore[0].toFixed(2)}–${s.hostLoadAfter[0].toFixed(2)} |`,
    );
  lines.push("", "## 源码与复现", "");
  for (const snapshot of data.snapshots)
    lines.push(
      `- ${snapshot.name}：源码 SHA-256 \`${snapshot.sourceSha256}\`；归档 \`${snapshot.name}-source.tar.gz\`，归档 SHA-256 \`${snapshot.archiveSha256}\`。`,
    );
  lines.push(
    "",
    "before 是命令指定的基线源码快照；after 是本次测试开始时的目标工作区。两者可能包含未提交修改，具体角色以报告标题、原目录和源码摘要为准，不能只由 Git HEAD 复原。该 A/B 比较两份框架源码的完整差异，不能单独归因于某一个函数。",
    "",
    `完成 ${data.samples.length} 个正式样本、${format(data.samples.reduce((sum, s) => sum + s.load.total, 0))} 个测量请求，正式样本的错误、超时、非 2xx、正文不匹配全部为 0。完整 CPU 快照、客户端结果、计时和源码标识保存在 results.json。`,
    "",
  );
  return lines.join("\n");
};
