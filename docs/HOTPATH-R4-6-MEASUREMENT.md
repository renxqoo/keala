# R4.6 生产模式与多进程测量装置

> 状态：方案定稿，实施中（2026-09-03）
> 基线：0a9760a；仅重构 bench 与测试，不修改 src、不修改 Tillgate。
> 用户裁决：继续上一轮确定的测量装置、生产模式及 CPU 归因工作，保留全部安全守卫。
> 本文合并本切片的 DESIGN / IMPLEMENTATION / MIGRATION。

## 1. 设计契约

两运行时使用相同 fixture、生产环境、总连接数、负载进程数、payload、预热和采样时间。
所有子进程显式 NODE_ENV=production；Keala fixture 显式 env=production；开始测量前
核对服务器报告的实际环境、PID、运行时和测量协议。旧快照缺少协议时明确失败，不静默
回退到不测 CPU 的旧路径。原基线选项保留，但 baseline 必须提供同一测量协议的 fixture。

GET/POST 都改为独立 Node 进程发压，默认 4 个（不超过总连接数），最多 32 个。
总 connections 精确分配，例如 201/4 -> 51,50,50,50；每客户端 workers=0、pipeline=1。
客户端进程启动完成、各自预热结束后进入屏障，服务器 CPU 基线也在预热后采集。
统一发出未来启动时间，记录实际起止和偏斜，偏斜超过 50ms 则拒绝样本。

吞吐为完成请求总数除以联合测量窗口（最早 start 到最晚 finish），不把不同时间窗的
各客户端平均 RPS 相加冒充精确吞吐。合并 HDR latency 直方图后计算分位数，不平均
p99；保留各客户端直方图及原始计数。使用锁定的 autocannon 8.0.0 内部原始结果协议，
不增加运行时依赖。协议或计数不符时失败，不输出看似正常的结果。

CPU 使用 process.cpuUsage 差值 / 单调时钟窗口：100% 表示一个核，允许多线程进程
超过 100%，不称为机器总 CPU 或主线程 CPU。服务器还记录 CPU ns/完成请求和内存
快照。每客户端达到 90% 单核预算时标记容量受限，保留样本及警告，不伪装为服务端极限。
该标记是高 CPU 风险指示，不是仅凭总进程 CPU 就证明 JS 主线程饱和；需结合改变负载
进程数的对照。服务端窗口包含 100ms 启动屏障及结果 IPC/回收，保留实际 elapsedUs；
ns/request 是该窗口的进程 CPU 成本，不是某个函数的独占耗时。

每个 worker 最多一个阶段 watchdog；统一 AbortSignal 取消、异常退出、IPC 失败和
超时均结束所有本次子进程并 await exit，必要时 2s 后 SIGKILL。主进程信号走相同清理。
不处理框架路由、Context、Response、body 安全算法；这些仍归 src。CPU 计数归因不是
火焰图，不宣称已定位到某个函数，也不自动触发下一步源码优化。

## 2. 审计与模块裁决

| 文件/部位                                 | 裁决       | 证据与动作                                                                 |
| ----------------------------------------- | ---------- | -------------------------------------------------------------------------- |
| run-node-hotpaths.mjs fire                | 重构       | B46-1：POST 单进程发压约满一核，双进程同连接数吞吐上升；统一多进程装置     |
| 同文件 spawn/metadata                     | 重构       | B46-2：继承环境、未记录有效生产模式；强制环境并核验；补全过程指纹          |
| 同文件 memory                             | 重构       | B46-3：仅内存快照，无法区分客户端/服务端 CPU；引入测量窗口差分             |
| 四个 server fixture                       | 微调       | D46-1：重复内存采集；共享 metrics helper，新增冷端点信息，不插桩热 handler |
| hotpath-metrics.ts / 原 4 项测试          | 保留       | 既有配对统计与 CLI 校验有效，不改口径、不删断言                            |
| 新 load-metrics / load-pool / load-worker | 新职责拆分 | C46-1：多进程同步、计数/直方图聚合、清理需独立协议及测试                   |

B46-1/2/3 为性能证据缺陷，不是已确认框架服务缺陷。新结果不能与旧装置 RPS 直接
相除，声称本次提高框架性能。fixture、harness、src、实际依赖版本均记录指纹/版本。

## 3. 实施及测试迁移

1. 先补连接分配、CPU 窗口、联合吞吐、HDR 合并、异常计数和偏斜的单元测试，确认红。
2. 实现 worker/pool 协议；真实 HTTP 子进程测试 POST 完成计数、生产环境、不同 PID、
   CPU、坏地址/取消的退出回收；旧 GET/body/status/type/late-header/413 校验全部保留。
3. 四个 fixture 接入冷 metrics，runner 接入统一装置并写版本 2 原始 JSONL。
4. fmt/typecheck/lint（改动文件 0-0）/build/Node+Bun test/coverage；旧业务门禁及双形态
   进程检查保持。覆盖率不得低于 97.35/92.19/96.29/98.74%。旧测试全部保留。
5. 源码和装置冻结后，Bun/Node 六场景各 5 轮；POST 用 1 与 4 进程同连接数检查容量。
   实际差异与不确定性落档，不能仅凭小幅正数宣称整体领先 Hono。

无公共 API 迁移，无数据库/数据动作；整个切片独立可 revert。不保留旧单进程特殊实现：
1 进程只是新装置的参数。真实外部服务 real 门不适用，本装置仅使用隔离 localhost 服务。

## 4. 验收记录

### 4.1 集成缺陷与回归

- B46-4：首次完整 Bun 门禁发现 PATH 的 `node` 实际启动 Bun。`bun --bun` 注入
  `bun-node-*` shim；只看命令名或 process.version 会误认运行时。新增冷路径 Node
  executable 解析，跳过 Bun 本体及 shim，执行探测确认真实 Node；worker 自身再拒绝
  Bun。新增实进程身份回归，Node/Bun 测试均使用同一实现，不跳过 Bun 测试。
- B46-5：测试 fixture 先 closeAllConnections 再 close 在 Bun 1.4 返回
  ERR_SERVER_NOT_RUNNING。不含框架的 node:http 短脚本在 Node 正常、Bun 复现；
  两运行时均以先 close 注册回调、再 closeAllConnections 成功。修复测试关闭顺序，
  不吞掉错误、不增加按运行时分支、不修改框架服务器。
- 新装置 17 项测试在 Bun 定向复验全部通过，涵盖真实 POST、异常响应、进程死亡、
  启动/测量/阻塞 hook 的取消回收、有效环境、PID、直方图及统计。旧用例全部保留。

### 4.2 质量门禁

| 门禁                                                | 结果                                                        |
| --------------------------------------------------- | ----------------------------------------------------------- |
| Node / Vitest + coverage                            | 116 文件，2054 pass / 8 skip                                |
| Bun / Vitest                                        | 116 文件，2025 pass / 37 skip                               |
| coverage：statements / branches / functions / lines | 97.35 / 92.19 / 96.29 / 98.74%，与基线一致                  |
| fmt / typecheck / build                             | 通过；最后 CLI 校验与取消细节调整后完整 runner 3 项再次通过 |
| 改动文件 lint                                       | 0 warning / 0 error                                         |
| 全仓 lint                                           | 43 项既存 warnings / 0 error；未把局部 0-0 写成全仓 0-0     |
| smoke / example / soak                              | 通过，包含 24×20,000 请求及并发保留内存检查                 |
| Node / Bun × source / dist                          | 4 种真实进程形态全部通过                                    |

执行：`npm run verify`、`npm run test:bun`、`npm run build`、`npm run smoke`、
`npm run example:check`、`npm run soak`、`npm run process:check`。src 无改动，
没有调整框架错误路径、Response 所有权或 413 守卫；Tillgate 未修改、未重测。

### 4.3 复现与协议迁移

编排命令必须由真实 Node 执行；Bun 是被测服务器运行时。总连接数 200，不是每个
发压进程 200；输出路径必须尚不存在。实际版本与 SHA 以每份 JSONL 的 run 行为准。

```sh
KEALA_BENCH_PROCESSES=4 KEALA_BENCH_OUTPUT=/tmp/new-r46-bun.jsonl node bench/run-bun-hotpaths.mjs 200 5 5
KEALA_BENCH_PROCESSES=4 KEALA_BENCH_OUTPUT=/tmp/new-r46-node.jsonl node bench/run-node-hotpaths.mjs 200 5 5
KEALA_BENCH_PROCESSES=1 KEALA_BENCH_OUTPUT=/tmp/new-r46-bun-one.jsonl node bench/run-bun-hotpaths.mjs 200 5 3 json-body-safe
KEALA_BENCH_PROCESSES=1 KEALA_BENCH_OUTPUT=/tmp/new-r46-node-one.jsonl node bench/run-node-hotpaths.mjs 200 5 3 json-body-safe
```

指定 KEALA_BENCH_BASELINE 时，独立 checkout 也须复制本协议的当前 fixture 和
server-metrics.ts，只改变所导入的基线 src；旧快照缺文件或协议不符直接报错。
这不要求改动基线 src，也不把旧环境/旧装置统计偷偷混入新运行。

单进程容量实验和四进程矩阵是分时执行，不把两组独立中位数之商包装成同轮配对
因果增益。框架间主指标仍为每轮 Keala/Hono 比率的中位数；5 轮 min/max 不是置信区间。
