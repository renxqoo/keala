# Node 请求路径重构证据

先看[最终结论与逐场景对比](SUMMARY.md)。

基线为 `f14940b`，源码摘要 `05df8d2775e7fe59d944cde7cac74f7462db566292d262d413621b0319a2ba4a`。所有 wr 测试均使用同一私有 Node 26.9.0、既有 Bun 1.4.4、同一组锁定依赖；本地编译上传，不使用 Docker。

| 阶段               | 源码                                                               | 数据                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 第一完整矩阵       | `6f20eeb0cc68fb73365ff2e396197d89e63af50a1c03dbca2122a9d5d46b6117` | [REPORT.md](REPORT.md)、[原始结果](results.raw.json.gz)、[manifest](manifest.json)、[远程核验](verification-full.json)；312 样本、176 预检、8,161,595 请求 |
| 最终版 Node 重测   | `290a323faa77b894e7c2a60a558f4777136bb39028c7a76b1a9e675ad6b29ec6` | [node-final/REPORT.md](node-final/REPORT.md)，156 样本、88 预检、3,214,881 请求；只修正第一矩阵之后的冷关闭流程，请求代码不变                              |
| 本地最终热路径 A/B | `05df` → `6f20`                                                    | [local-final-ab](local-final-ab/REPORT.md)；4 对均改善，配对中位吞吐 +5.89%、CPU −5.53%，不能替代 wr 数据                                                  |
| 本地第一阶段 A/B   | 独立中间候选                                                       | [local-transport-ab](local-transport-ab/REPORT.md)；源码快照与数据独立保存                                                                                 |
| 单轮 Node 筛选     | `6f20`                                                             | [screen](screen/REPORT.md)，只作筛选，不作最终排名                                                                                                         |
| 拒绝的响应头原型   | 独立试验快照                                                       | `experiments/rejected-header-isolated` 无稳定收益；`rejected-header-overlap` 与测试进程重叠，整批不作性能裁决                                              |

正式参数：50 连接、pipelining=1、1 个 Node 负载进程，1 秒预热、3 秒计量、3 轮、500 ms 冷却，每样本重启服务。前两轮采用相同轮转起点并严格反向，第三轮按半数组轮转；Node-only 重测按四栈排列，完整矩阵按八栈排列。CPU/请求通过 HTTP 外 IPC 的 `process.cpuUsage(user+system)` 增量除以完成数；窗口包括启动屏障及清理。延迟分位数为毫秒精度。

共享 cgroup 包含协调、服务、负载进程：CPU ≤1.5 核，MemoryHigh=512 MiB、MemoryMax=640 MiB、无 swap、TasksMax=128，Nice=15、CPUWeight=1。健康守卫检查可用内存、内存事件、任务数及负载。全部正式样本受到配额节流，客户端也竞争同一配额，不能把结果解释为服务端峰值或据极小差异断言稳定排名。

第一完整矩阵的 Node 十二路由汇总较基线吞吐 +9.39%、CPU −11.19%；较 Hono +5.63%/−4.81%，较 H3 +10.22%/−11.47%。11/12 路由的吞吐与 CPU 中位数优于 Hono，其中只有 7/12 三轮均同时优于 Hono。Hello 与事件评论列表仍落后。Bun 三框架汇总吞吐相差不到 0.6%，不足以判定稳定胜负。

`candidate-source.tar.gz` 对应第一矩阵，`candidate-final-source.tar.gz` 对应最终版，`before-source.tar.gz` 对应基线。[source-roundtrip.json](source-roundtrip.json) 记录解压后重新计算的源码摘要。[raw-files.json](raw-files.json) 记录压缩前字节数和 SHA-256；格式化后的 JSON 与解压原始 JSON 已做结构等值检查。

`linux-profiles/` 是同机同配额的诊断 profile，50 连接、1 个负载进程、8 秒计量，顺序为基线、候选、Hono、H3，仅一轮且开启 inspector；**不并入正式排名**。`profiles/` 是早期本地基线/候选诊断。`.cpuprofile.gz` 解压后可用 V8 profile 工具读取。采样时间含调度和配额等待，不能把样本比例当作 CPU 因果份额。通用诊断入口：

```sh
BENCH_PROFILE_CONNECTIONS=50 BENCH_PROFILE_PROCESSES=1 node bench/framework-compare/profile.mjs hono hello / 'Hello World' /tmp/hono.cpuprofile
```

`validation/` 无 `-final` 后缀的完整验证对应 `6f20`；最终版的 `node-verify-final.txt`、`bun-tests-final.txt`、`node20-final.txt` 分别覆盖 Node 26、Bun、真实 Node 20.19.5。`close-*-red.txt` 保存新增关闭回归在修正前的失败，`close-fixed-green.txt` 保存修正后的 111 项相关验证。
