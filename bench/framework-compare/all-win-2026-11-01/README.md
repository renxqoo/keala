# 同机 Node/Bun 优化证据（2026-11-01）

最终完整结果见 [COMPARISON.md](./COMPARISON.md)，原始数据见 native-full-xi。

目标是 Hello World 与十二路由的吞吐、延迟、CPU/请求逐项领先 Hono/H3。尚未达到全面领先，不能把不同候选的数据拼成一个版本。

## 本轮测量方法

wr；Node 26.9.0、Bun 1.4.4；Hono 4.13.5、H3 2.0.8、srvx 1.0.8。所有包本地构建上传，无 Docker、无全局运行时安装。服务端 CPU 0，原生 Go 客户端与协调进程 CPU 1；仅测试 cgroup 配额150%，period10ms、Nice15、MemoryHigh512M/Max640M、swap0，原服务不调整。

50个持久连接，pipelining1，预热1秒、计量3秒，最后在途请求排空的数量和时间均计入分母。Hello筛选10轮，完整矩阵3轮，轮换交错顺序，每次重新启动服务。十二路由逐条固定请求，不是混合流量。每次请求都校验状态与完整正文。样本没有因吞吐低而删除。

CPU是服务端 process.cpuUsage 的 user+system 增量/完成请求数，单位微秒。每行的吞吐、CPU、延迟分别取各轮中位数；比率不是逐轮配对比率。延迟按向下取整的整数毫秒桶记录，p99 的 x.5 仅来自偶数轮中位数，不表示0.5ms精度。所有样本发生配额节流；客户端CPU低于90%也不能证明裸机峰值。几百分点差距须结合范围/配对方向判断。

旧 autocannon、不同CPU period、无固定CPU的试验仅保留历史，不能与本组直接计算优化百分比。

## 候选来源

| 数据目录             | 候选 source SHA256                                               | 对照 source SHA256                                               |
| -------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------- |
| native-gamma-hello   | 90e77a29e4daf48d1c769ac659b2d27ee8dbbb550fd9d52f77b2c3ee7d3287aa | f76b7a94c9d685409a9f27d8e00f1e01f69c1f0f74e26e7a12fa04e361bb5237 |
| native-delta-hello   | 2fb974a87fced650cd05c02e6666167bf4b82de191b8ad195d16586a36916ba3 | 90e77a29e4daf48d1c769ac659b2d27ee8dbbb550fd9d52f77b2c3ee7d3287aa |
| native-epsilon-hello | 5c0817b69a3150b443d11a594139901317731e3a48267d02a1b7a010db07f476 | 2fb974a87fced650cd05c02e6666167bf4b82de191b8ad195d16586a36916ba3 |
| native-full-theta    | 3299cfa6421336e5564f27575d03e2e77d7acb21fdd35563661c67edb039a4eb | 290a323faa77b894e7c2a60a558f4777136bb39028c7a76b1a9e675ad6b29ec6 |
| native-lambda-hello  | c9e117c210839cc30648f0bec1fe04f7a4e022d7432d9fb301e15cc6b88eb81d | 3299cfa6421336e5564f27575d03e2e77d7acb21fdd35563661c67edb039a4eb |
| native-nu2-hello     | 83971e921ffe0918d76cbe98cb13376a121d6416290ebda85da7927a5bee6821 | c9e117c210839cc30648f0bec1fe04f7a4e022d7432d9fb301e15cc6b88eb81d |

每个目录的 manifest 固定源码、dist、harness、依赖及原生客户端摘要；results.json 是格式化副本，raw-results.json.gz 保留实际下载字节。CPU、分位数、请求计数和摘要由独立只读复核，Theta312与Lambda80均通过。

## 保留与拒绝

保留：连接级Node drain/取消观察、稳定分发函数、Context构造策略、冷热路径拆分、URL直接填槽、保留完整Response校验、Bun同步桥接和私有descriptor复用。源码快照按候选命名；Xi最终完整数据完成后另列。

拒绝：原生静态路由延迟URI会丢失响应后URL；sugar身份免检漏掉handler修改的status；延迟Request扩展无法保留所有上游Bun.serve包装层的公开raw交付；suffix分组路由微测多数退化。原型、反例及失败日志均归档，不进入产品源码。

Nu2是descriptor筛选：80样本、0错误，Bun相对Lambda与Hono均接近。Xi在它之上保留getter名称并提取静态路由短路径。Node/Bun全套共3009项：Node2984通过25条件跳过；Bun2916通过93条件跳过。verify、process/runtime和两种运行时soak日志分别归档。

最终 Xi 已完成：312 样本、176 项检查、13,909,050 请求，0 错误/重试、640 子进程全退出。Node 13/13 的吞吐与 CPU 中位数同时优于 Hono/H3，但四项 p99 对 Hono 更差；Bun 对 Hono 仅 6/13 同时胜。十二路由几何平均相对 Hono，Node 吞吐 +6.45%、CPU −6.58%；Bun −1.07%/+1.68%。服务器私有运行时与全部本轮临时目录已删除，原服务 PID 未变，OOM 为 0。
