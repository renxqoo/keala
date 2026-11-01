export const median = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
export const geometricMean = (values) =>
  Math.exp(values.reduce((sum, x) => sum + Math.log(x), 0) / values.length);

export const summarize = (data) =>
  data.scenarios
    .flatMap((scenario) =>
      data.stacks.map((stack) => {
        const samples = data.samples.filter(
          (s) => s.stack === stack.id && s.scenario === scenario.id,
        );
        if (!samples.length) return undefined;
        const rates = samples.map((s) => s.load.rps);
        return {
          stack: stack.id,
          scenario: scenario.id,
          rounds: samples.length,
          rps: median(rates),
          min: Math.min(...rates),
          max: Math.max(...rates),
          p50: median(samples.map((s) => s.load.latency.p50)),
          p99: median(samples.map((s) => s.load.latency.p99)),
          clientCapacityConstrained: samples.some((s) => s.load.clientCapacityConstrained),
        };
      }),
    )
    .filter(Boolean);

const number = (n) => Math.round(n).toLocaleString("en-US");
const localTime = (value) =>
  new Date(value).toLocaleString("sv-SE", { timeZone: "Asia/Singapore" });

export const renderReport = (data) => {
  const summaries = summarize(data);
  const lines = [
    "# Node 26 / Bun 1.4.4：Keala、Hono、H3 实测",
    "",
    `- 测试时间：${localTime(data.startedAt)} → ${data.finishedAt ? localTime(data.finishedAt) : "运行中"}（Asia/Singapore，UTC+8）。`,
    `- 机器：${data.environment.cpu}，${data.environment.cpus} 逻辑 CPU，${(data.environment.memory / 2 ** 30).toFixed(0)} GiB，${data.environment.platform} ${data.environment.release} ${data.environment.arch}。`,
    `- 版本：Node ${data.versions.node}、Bun ${data.versions.bun}；Keala ${data.versions.keala}（工作区构建）、Hono ${data.versions.hono}、H3 ${data.versions.h3}；@hono/node-server ${data.versions.honoNode}、srvx ${data.versions.srvx}。`,
    `- 负载：autocannon ${data.versions.autocannon}，${data.config.connections} 个总连接，${data.config.processes} 个独立 Node 客户端进程，HTTP/1.1 keep-alive，pipelining=1。`,
    `- 每次采样先预热 1 秒，再测 ${data.config.duration} 秒；${data.config.rounds} 轮，交错并轮换顺序。表格为轮间中位数，范围为实测 min–max，不代表置信区间。`,
    "- Hello World 应用仅注册 GET /；十二路由应用注册完整路由表，每次固定请求其中一条。所有响应状态为 200、语义相同的 text/plain UTF-8，正文逐字节一致；每个压测请求也检查正文。",
    "- 参数必须实际读取并回显；POST 无请求体；/static/* 仅回显后缀，无文件 I/O。H3 用 /static/** 实现多段通配契约。",
    "- Keala 使用默认原生适配器（Bun 为 app.listen，Node 为 keala/node）；Hono 使用 Bun.serve / 官方 Node 适配器；H3 使用官方 serve（srvx）。均为生产模式、单进程服务，无额外中间件。",
    "- 客户端和服务端共用本机；其他系统活动、网络栈和客户端均可能影响结果。客户端任一进程 CPU ≥90% 单核的样本会标记，不能直接解释为服务端极限。",
    `- 主机一分钟负载（测量前后采样）范围：${Math.min(...data.samples.flatMap((s) => [s.hostLoadBefore[0], s.hostLoadAfter[0]])).toFixed(2)}–${Math.max(...data.samples.flatMap((s) => [s.hostLoadBefore[0], s.hostLoadAfter[0]])).toFixed(2)}；若接近或超过逻辑 CPU 数，需注意竞争负载与调度影响。`,
    `- 严格计时校验未通过的样本共 ${data.rejectedTimingSamples.length} 次，记录原因后重新预热、重新测量，单组合最多尝试 3 次。正文、状态、超时等失败不重试；有效的低吞吐样本不会被删除。`,
    `- Git HEAD：${data.source.commit}；构建产物 SHA-256：${data.source.distSha256}。工作区${data.source.dirty ? "包含未提交修改（清单见 results.json）" : "干净"}。`,
    "",
    "## 汇总",
    "",
    "十二路由一列为十二条路由各自吞吐中位数的几何平均，仅用于概括；它不是混合流量测试的吞吐量。",
    "",
    "| 框架 | 运行时 | Hello World req/s | 十二路由几何平均 req/s |",
    "| --- | --- | ---: | ---: |",
  ];
  for (const stack of data.stacks) {
    const hello = summaries.find((s) => s.stack === stack.id && s.scenario === "hello");
    const routes = summaries.filter((s) => s.stack === stack.id && s.scenario !== "hello");
    lines.push(
      `| ${stack.framework} | ${stack.runtime} | ${hello ? number(hello.rps) : "—"} | ${routes.length === 12 ? number(geometricMean(routes.map((s) => s.rps))) : "—"} |`,
    );
  }
  lines.push(
    "",
    "本表是共享主机上的初测。轮间范围重叠时，不能据此确认稳定排名；几百分点的差距需要在空闲环境增加采样后再判断。",
    "",
  );
  lines.push(
    "",
    "## 全部场景吞吐量（req/s）",
    "",
    `| 场景 | ${data.stacks.map((s) => s.id).join(" | ")} |`,
    `| --- | ${data.stacks.map(() => "---:").join(" | ")} |`,
  );
  for (const scenario of data.scenarios) {
    const cells = data.stacks.map((stack) => {
      const summary = summaries.find((s) => s.stack === stack.id && s.scenario === scenario.id);
      return summary
        ? `${number(summary.rps)}${summary.clientCapacityConstrained ? " †" : ""}`
        : "—";
    });
    lines.push(
      `| ${scenario.id === "hello" ? "Hello World" : `\`${scenario.method} ${scenario.route}\``} | ${cells.join(" | ")} |`,
    );
  }
  lines.push(
    "",
    "## 延迟、波动与样本数",
    "",
    "p50 / p99 为每轮请求延迟分位数的中位数，单位 ms；autocannon 的分位数精度为毫秒，0 不表示没有延迟。† 表示检测到客户端 CPU 接近单核上限。",
    "",
    "| 场景 | 栈 | 样本数 | req/s 范围 | p50 ms | p99 ms | 客户端受限 |",
    "| --- | --- | ---: | ---: | ---: | ---: | --- |",
  );
  for (const summary of summaries) {
    lines.push(
      `| ${summary.scenario} | ${summary.stack} | ${summary.rounds} | ${number(summary.min)}–${number(summary.max)} | ${summary.p50.toFixed(2)} | ${summary.p99.toFixed(2)} | ${summary.clientCapacityConstrained ? "†" : "否"} |`,
    );
  }
  const count = data.samples.reduce((sum, s) => sum + s.load.total, 0);
  lines.push(
    "",
    `完成 ${data.samples.length} 次测量、${number(count)} 个测量请求；成功样本的错误、超时、非 2xx、正文不匹配均为 0。预热请求不计入此总数。`,
    "",
    "原始每轮结果、客户端 CPU、版本、源码标识和执行顺序保存在同目录 results.json。",
    "",
  );
  return lines.join("\n");
};
