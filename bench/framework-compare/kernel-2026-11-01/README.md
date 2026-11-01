# 独立 Kernel：执行器与路由编译实验

本轮找到了 Node 大幅提速的架构方向；尚未达到跨 Node/Bun、全部功能和所有指标的“全面领先”。Node 原生同步文本探针的十三个场景均领先本轮 Hono/H3；Bun 的 RegExp 编译方案平均更快，但仍有落后场景。三轮中位数是本机观测，几百分点差距不能当作稳定排名。

新代码位于 `experimental/kernel`，提供显式 text 与 Fetch 能力、启动时封闭的路由计划、作用域中间件、错误映射、Node/Bun 执行器。旧 `src` 与原 Keala API 保留，本轮旧源码 SHA-256 始终是 `33f23a18be16853fdaa06371aee662a1138723e229b0e9fac06d02c0b82b2067`。详细设计和运行方法见 [KERNEL-ARCHITECTURE.md](../../../docs/KERNEL-ARCHITECTURE.md)。

## 关键结果

相对同阶段、同运行时的 Hono 官方适配器；十二路由数字是各路由中位数的几何平均，非混合流量吞吐。

| 候选                   | Hello吞吐变化 | Hello CPU/请求变化 | 十二路由吞吐变化 | 十二路由CPU/请求变化 | 十三个场景吞吐 / CPU / p99更好的数量 |
| ---------------------- | ------------: | -----------------: | ---------------: | -------------------: | ------------------------------------ |
| Node 原生同步文本探针  |      +198.71% |            −74.20% |         +187.68% |              −73.13% | 13 / 13 / 13                         |
| Bun RegExp 编译 Kernel |        +6.98% |             −7.16% |           +2.38% |               −2.57% | 10 / 10 / 3                          |

Node 探针复用同一冻结 Kernel 路由、参数和处理器，只更换为 uWebSockets.js 20.67.0 HTTP 执行器。相对该阶段的普通 node:http Kernel，十二路由吞吐 +170.47%、CPU/请求 −71.20%。它证明整条 HTTP 执行链值得重构，不能把差距单独归因于一个 parser。

**Node 这一列只支持同步 text / 内部 Reply，Fetch、中间件和异步结果明确返回 501，关闭仅 force。它不是通用框架或旧 API 的等价替换。** 通用 Node 原型另有标准 Fetch 流、断连、pipeline 和有期限 drain 的 node:http 执行器。后续通用原生后端仍需要单独完成这些合同。

Bun RegExp 与 trie 使用同一完整 Kernel API。RegExp 方案相对同阶段 trie 的十二路由吞吐 +3.72%、CPU/请求 −4.21%。它按静态、参数、通配优先级编译小表；超限或引擎失败降级 trie，不分析或缓存处理器结果。Node/Bun 各有 48,000 次路由选择差分验证。当前默认仍是 trie；Bun 可显式使用 `new Kernel({ router: "regexp" })`。

## 实际数值

各行来自对应完整阶段的三轮中位数。两个阶段单独比较，不能跨阶段直接计算版本变化。延迟的每份原始样本精度为毫秒，平均、p50、p99及波动见各阶段 analysis/REPORT。

| 阶段 / 栈               | Hello req/s | Hello CPU µs/请求 | Hello p99 ms | 十二路由 req/s 几何平均 | 十二路由 CPU µs/请求几何平均 |
| ----------------------- | ----------: | ----------------: | -----------: | ----------------------: | ---------------------------: |
| Node / 原生同步文本探针 |      25,876 |             27.90 |            9 |                  23,565 |                        31.00 |
| Node / 当前 Keala       |       9,449 |             98.87 |           25 |                   8,535 |                       109.97 |
| Node / Hono             |       8,663 |            108.15 |           27 |                   8,192 |                       115.37 |
| Node / H3               |       8,405 |            111.11 |           30 |                   7,678 |                       123.95 |
| Bun / RegExp Kernel     |      22,899 |             32.39 |           10 |                  20,607 |                        36.92 |
| Bun / trie Kernel       |      22,785 |             32.66 |           11 |                  19,869 |                        38.54 |
| Bun / 当前 Keala        |      20,952 |             35.93 |           11 |                  19,591 |                        38.85 |
| Bun / Hono              |      21,406 |             34.88 |           11 |                  20,128 |                        37.89 |
| Bun / H3                |      19,498 |             39.26 |           13 |                  18,151 |                        43.47 |

## 保留与撤回

- 保留独立 Kernel API 和标准 Node/Bun 执行器；不改旧 Keala 的请求合同。
- 保留小表 RegExp 编译选项与明确的 trie 降级；Bun 完整十三场景测量有平均收益。
- 保留 Node 同步文本原生执行器的隔离探针及固定依赖摘要，作为后续后端设计证据。
- 撤回 Bun 原生路由下沉试验在主原型中的接线：四轮 A/B 中 Hello CPU +2.46%、用户名参数 CPU +5.78%，通配 −0.11% 基本持平。候选源码、测试和构建完整保存在 stage06 压缩包，未把无收益候选留为默认路径。
- 否决直接复用 Bun Response：后续请求会失败。私有模板 clone 只做了短行为验证，性能未知，未采用。见 [合同探针](05-contract-probes/README.md)。

## 测试条件与边界

wr：Ubuntu 24.04、2 vCPU Xeon E5-2680 v4、约 1.92 GiB、无 swap。Node 26.9.0 和所需私有库在本地准备、校验、打包；Bun 1.4.4 使用服务器既有安装。服务器无构建、无 npm 安装、无 Docker。

每次只运行一个服务进程和一个原生 Go 客户端。正式参数：50 连接、HTTP/1.1 keep-alive、pipeline=1、1 秒预热、3 秒测量、500ms间隔、每组合3轮；小范围筛选为4轮并完整平衡两栈顺序。Hello 仅一个路由；十二路由应用注册完整表，每次固定测一条。POST 无正文，通配只返回后缀，不做文件I/O。处理器和参数实际调用，每个请求检查状态和完整正文。

CPU/请求为服务端 process.cpuUsage(user+system) 增量/完成请求数，通过 HTTP 路径外 IPC 采样。测试组包含客户端和协调进程，CPU 上限1.5核、period10ms、内存640MiB、Tasks128、nice15、CPUWeight1；服务端CPU0，客户端/协调CPU1。结果含配额、网络栈、客户端和共享主机活动影响，不能当作服务端峰值容量。低于90%客户端CPU也不排除配额限制。

全部7个阶段共 **763份样本、510项前置HTTP检查、34,495,520个计量请求**，零错误、零超时、零状态/正文不匹配、零计时重试；有效慢样本全部保留。1583个不同自有子进程全部退出。测试组内存峰值125.21MiB；最小主机 MemAvailable1356.42MiB，OOM计数始终0。

原服务 PID 26761 xray、26769 hysteria、71250 fail2ban-server 保持；全部测试单元已 inactive，wr 独立临时目录和运行时已删除。证据见 [remote-evidence.json](remote-evidence.json)、[清理记录](cleanup-remote.log)。归档 SHA-256：`5c6181896f22354c0d2b32fbd3089605f0b4439b154a3f6431605cd1fc6025ea`。

## 原始数据与复现

| 阶段                                                     | 样本 | 用途                                                   |
| -------------------------------------------------------- | ---: | ------------------------------------------------------ |
| 00-pilot-v1                                              |    8 | 初始低负载运行校验；不用于版本排名                     |
| 01-full-v2                                               |  312 | 普通 Kernel / 当前 Keala / Hono / H3，两运行时十三场景 |
| native-pilot，原始归档内                                 |    5 | Linux 原生插件加载和低负载校验                         |
| [02-native-engine](02-native-engine/analysis.md)         |  195 | Node 同 Kernel 更换 HTTP 执行器，包含三个框架对照      |
| [03-regexp-screen](03-regexp-screen/analysis.md)         |   24 | Bun 路由编译小范围四轮 A/B                             |
| [04-regexp-full](04-regexp-full/analysis.md)             |  195 | Bun RegExp / trie / 当前 Keala / Hono / H3 完整对照    |
| [06-bun-native-screen](06-bun-native-screen/analysis.md) |   24 | 原生 Bun 路由下沉；无收益撤回                          |

每阶段 `results.json.gz` 保留原始样本，analysis.json/md 为可重算描述性统计；manifest及source/build归档记录具体代码摘要。完整服务器原始数据、REPORT和日志另存 `remote-evidence.tar.gz`。用 `node analyze.mjs <results.json.gz> <输出前缀>` 重新统计。

性能测量 Kernel 源码 SHA-256：`3b5ec7b8d5ec96d8269acb5002dbe607d274014a8f23283a2219fc8d59d19098`。交付整理仅将错误回退函数移到模块作用域以消除本轮 lint 告警，未改变成功请求的测量路径；最终源码摘要为 `9740fd7402efb6d19b1f767a577d3d50a1671c1f4fbe47e4defa78569781fb9b`，完整差异见 [final-source-adjustment.patch](final-source-adjustment.patch)，源码与构建分别归档。Node 原生阶段使用先前冻结 Kernel，源码/构建快照在01/02阶段分别保留，不冒充最终全部 API 的兼容加速。
