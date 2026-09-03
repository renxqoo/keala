# R4.6 生产模式与多进程测量装置

> 状态：本测量切片已完成并复验；R4.5 整体性能目标未核销（2026-09-03）
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
每客户端墙钟时长还必须与单调时钟 CPU 窗口相差不超过 2ms（允许 Date.now 毫秒取整），
否则按系统校时/采样窗口污染拒绝，不能仅用启动偏斜排除采样中途校时。

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
成功结果须等所有客户端在结果后 2s 内正常退出才成立；此窗口仍接收取消与异常退出，
不能提前锁定成功值。正常退出不发送 SIGTERM，失败才进入强制回收路径。
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
- 中途按 repo-migration-e2e-v2 补独立对抗审查，不给审查者实现推理；审查覆盖方案
  三部分、0a9760a 到 db403e5 的新旧差异、装置适配及旧断言。发现 B46-6/7，先新增
  五项回归确认红，再修正；没有以历史样本碰巧正常豁免错误路径。
- B46-6：共同向前校时不会改变 startSkew，却让 5s 样本按 6s 算 RPS。新增墙钟与
  单调窗口 2ms 一致性守卫。旧正式样本最大偏差约 1ms，没有发现受污染样本。
  单测 fixture 的 CPU elapsedUs 从固定 1 秒改为其已声明的起止时长；原吞吐、
  直方图及 CPU 断言均未改弱，不以不一致的虚构窗口绕过新守卫。
- B46-7：收到结果后提前 return、在 finally 才回收，期间的 abort/异常退出不能推翻
  已锁定成功值。改为先有界等待正常退出，再返回聚合结果；新增迟到取消、结果后崩溃、
  正常无信号退出及结果后挂起四项确定性 IPC 回归，真实多进程回归继续保留。

### 4.2 质量门禁

| 门禁                                                | 结果                                                    |
| --------------------------------------------------- | ------------------------------------------------------- |
| Node / Vitest + coverage                            | 117 文件，2060 pass / 8 skip                            |
| Bun / Vitest                                        | 117 文件，2031 pass / 37 skip                           |
| coverage：statements / branches / functions / lines | 97.35 / 92.19 / 96.29 / 98.74%，与基线一致              |
| fmt / typecheck / build                             | 加固后全量通过                                          |
| 改动文件 lint                                       | 0 warning / 0 error                                     |
| 全仓 lint                                           | 43 项既存 warnings / 0 error；未把局部 0-0 写成全仓 0-0 |
| smoke / example / soak                              | 通过，包含 24×20,000 请求及并发保留内存检查             |
| Node / Bun × source / dist                          | 4 种真实进程形态全部通过                                |

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
KEALA_BENCH_PROCESSES=4 KEALA_BENCH_OUTPUT=/tmp/new-r46-node-four.jsonl node bench/run-node-hotpaths.mjs 200 5 3 json-body-safe
KEALA_BENCH_PROCESSES=4 KEALA_BENCH_OUTPUT=/tmp/new-r46-bun-four.jsonl node bench/run-bun-hotpaths.mjs 200 5 3 json-body-safe
```

指定 KEALA_BENCH_BASELINE 时，独立 checkout 也须复制本协议的当前 fixture 和
server-metrics.ts，只改变所导入的基线 src；旧快照缺文件或协议不符直接报错。
这不要求改动基线 src，也不把旧环境/旧装置统计偷偷混入新运行。

单进程容量实验和四进程矩阵是分时执行，不把两组独立中位数之商包装成同轮配对
因果增益。框架间主指标仍为每轮 Keala/Hono 比率的中位数；5 轮 min/max 不是置信区间。

## 5. 首轮完整生产模式矩阵（加固前历史记录）

Apple M4，Node 22.20.0、Bun 1.4.0、Hono 4.13.5、官方 Node adapter 2.1.1，
autocannon 8.0.0 / hdr-histogram-js 3.0.1。各运行时 6 场景 × 5 轮 × 2 框架，
每样本新服务进程、4 个真实 Node 发压进程、总连接数 200、1s 预热、5s 测量。
框架顺序在轮内交错轮换；四门/soak 与本矩阵未并发执行。

- [Bun 原始数据](./bench/r4-6-measurement-bun.jsonl)：60 样本、66,023,308 请求。
- [Node 原始数据](./bench/r4-6-measurement-node.jsonl)：60 样本、32,719,439 请求。
- 合计 98,742,747 个完成请求，errors / timeouts / non2xx 全为零；每个客户端的
  完成数均与其 latency 直方图计数一致，聚合结果亦一致。
- 最大实际启动偏斜 Bun 6ms、Node 2ms，均小于 50ms 限制。所有样本实际环境均为
  production，PID 与运行时校验通过。发压 CPU 最大 Bun 65.7%、Node 43.4% 单核，
  无 90% 容量警告；不把这等价为已排除网络/内核/调度的所有影响。
- src 指纹仍为 `54c485e2ce1884c38a8a6832f203ef5684d993eca190a7180daf43a2ef44ac08`，
  与 0a9760a 相同。装置指纹两组均为
  `b2aca209b9b9b346baa84e252805240baa0bc2b48636d7a54bb0c8ab6888052e`。

RPS 是各自中位数，单位千请求/秒；「相对 Hono」与范围是**轮内配对比率**，不等于
表中两个独立 RPS 中位数的商。p99 为每样本合并直方图 p99 的中位数（ms）；CPU 为
服务端进程 CPU μs/完成请求的中位数。`K/H` 表示 Keala/Hono。

| runtime | 场景           |  RPS K/H（k） | 相对 Hono |      五轮范围 | p99 K/H |  CPU μs K/H |
| ------- | -------------- | ------------: | --------: | ------------: | ------: | ----------: |
| Bun     | probe-scoped-3 | 234.1 / 232.3 |     +0.6% |   −1.6～+1.7% |     2/1 |   4.33/4.38 |
| Bun     | text           | 247.0 / 248.8 |     −2.3% |   −6.6～+2.2% |     1/1 |   4.10/4.10 |
| Bun     | json           | 240.3 / 232.2 |     +3.2% |   +2.2～+8.2% |     1/1 |   4.22/4.38 |
| Bun     | param          | 242.0 / 240.7 |     +2.0% |   −3.5～+6.6% |     1/1 |   4.20/4.26 |
| Bun     | middleware-3   | 197.4 / 181.8 |     +8.5% |  −1.3～+21.2% |     1/2 |   5.21/5.69 |
| Bun     | json-body-safe | 183.4 / 174.1 |     +5.3% |  +1.9～+11.2% |     2/2 |   5.56/5.86 |
| Node    | probe-scoped-3 | 127.1 / 120.4 |     +5.6% |   +2.6～+9.5% |     2/2 |   7.93/8.37 |
| Node    | text           | 135.7 / 131.0 |     +7.3% |   −7.8～+9.3% |     2/2 |   7.45/7.76 |
| Node    | json           | 124.9 / 111.3 |    +12.0% | +10.9～+17.9% |     2/2 |   8.04/9.08 |
| Node    | param          | 120.9 / 115.3 |     +5.9% |  −4.0～+15.0% |     3/3 |   8.25/8.71 |
| Node    | middleware-3   |   91.4 / 55.9 |    +65.3% | +57.7～+68.7% |     3/4 | 11.04/18.20 |
| Node    | json-body-safe |   96.4 / 81.6 |    +17.9% | +12.7～+19.6% |     3/3 | 10.52/12.51 |

### 5.1 这组结果能证明什么

1. **本轮不是框架提速**：src 未变，是生产模式、负载容量和统计证据的修正，不能用新旧
   装置绝对 RPS 相除声称算法优化。Node 的带头路径优势依然明显，但不是每个场景都
   稳定领先 10%；Bun 仍未满足整体目标，且探针 p99 本轮为 2/1ms，不能声称尾延迟
   所有场景都领先或完全持平。
2. Bun 探针/文本的双方服务端 CPU 成本约 4.1–4.4μs/请求，当前差额很小；多进程发压
   没有使其自动变成大幅领先。服务端约占一核不等于已经定位到 JS、Response 构造或
   某个安全分支，函数级归因需要独立 CPU profile 与可复现的单变量实验。
3. `probe-scoped-3` 是三条不匹配的作用域注册，`middleware-3` 是两层路由级洋葱加
   handler；没有把它们冒称全局匹配链。`json-body-safe` 是 25 字节 declared JSON，
   Hono fixture 只做读前/读后限值检查，没有 Keala 的 chunked 缓冲预算，不能推导
   完整安全语义等价。业务全链、跨机器、异常负载和长时间可用性不由这个矩阵认证。

## 6. 发压容量对照

每配置每框架 3 轮，总连接数仍为 200、1s 预热、5s 测量，只改变 1/4 个发压进程。
与上午主矩阵存在时间间隔，单进程对照后又在同一时段重测四进程，不直接用上午的
绝对吞吐作为下午的因果基线。两配置仍非逐轮交错，所以表中 RPS 只能做容量诊断，
不把它们相除包装为严格的性能增益。每个配置内 K/H 仍按轮内配对统计。

原始数据：[Bun 1 进程](./bench/r4-6-measurement-bun-one.jsonl)、
[Bun 4 进程重测](./bench/r4-6-measurement-bun-four-recheck.jsonl)、
[Node 1 进程](./bench/r4-6-measurement-node-one.jsonl)、
[Node 4 进程重测](./bench/r4-6-measurement-node-four-recheck.jsonl)。

| 运行时 | 发压进程 |  RPS K/H（k） | K/H 配对中位数 | 客户端 CPU 最大 K/H（单核%） | ≥90% 样本 K/H |
| ------ | -------: | ------------: | -------------: | ---------------------------: | ------------: |
| Bun    |        1 | 159.3 / 154.2 |          +2.7% |                101.2 / 101.0 |           3/3 |
| Bun    |        4 | 177.1 / 166.8 |          +7.4% |                  50.4 / 53.5 |           0/0 |
| Node   |        1 |   97.5 / 82.3 |         +19.7% |                  88.5 / 81.0 |           0/0 |
| Node   |        4 |   99.0 / 85.4 |         +15.9% |                  36.9 / 30.0 |           0/0 |

Bun 单进程发压确实达到约一核，改为四进程后容量警告消失、所测吞吐增加；Node
单进程尚未触及相同上限，增加客户端也没有出现同量级变化。这支持“旧 Bun POST
结果受发压端容量影响”，但不证明发压端是唯一瓶颈：Bun 单进程下服务端自身也达到
约 103–108% 单核 CPU，改变负载进程数也会改变调度、请求到达和 GC 行为。

本节在 B46-6/7 加固前采样，HTTP errors/timeouts/non2xx 均为零。加固后将本节和
§5 全部 144 样本（113,958,265 请求）交给当前 aggregateLoad / cpuDelta 重算，
RPS、总数、时窗、偏斜、分位数、CPU 和容量标记逐字段完全一致；最大墙钟与单调
窗口偏差 1.002ms。没有将退出前的 HTTP 成功统计等同为旧装置已经验证全部正常退出。

## 7. 加固后最终复验

加固后重新跑完整 Node/Bun 六场景五轮，成功路径必须等全部客户端正常退出才输出
sample；最终数据在临时目录完成并核验后才落仓。两个运行时仍使用相同的冻结装置，
指纹为 `11fec96b20e373f1b1243a1641d123c9d4c7d3058c5f0773d9d9757e16d6ba32`，
src 仍为 §5 的未修改版本。

### 7.1 被拒绝运行的处置

首次 Node 运行在 param 第 4 轮触发 wall/monotonic 窗口一致性守卫，退出码 1；
已写入的 36 个 sample / 3 个 summary 是**不完整批次**，全部不纳入最终矩阵。
该批次的 text 曾出现 p99 4/3ms，吞吐轮间波动较大，这项不利观测也没有隐藏。
失败原因是预先规定的时钟一致性检查，而不是某场景成绩不佳；没有抽取其有利样本
与新批次拼接，也没有放宽 2ms 阈值。按完全相同源码、装置和参数重跑整套 Node。

记录保留在 [拒绝批次日志](./bench/r4-6-rejected-node.log)。错误发生时未保留该客户端
的完整失败样本，无法追溯具体偏差值；目前只能确定墙钟与单调窗口不一致，不能凭此
断言是 NTP、人工校时还是两个时间读取之间的调度暂停。它不被记为框架 HTTP 错误，
也不被冒充为成功测量。Bun 已完整通过的 60 个样本保持原样，不另挑“更好的一次”。

### 7.2 最终完整数据

[Bun 最终 JSONL](./bench/r4-6-verified-bun.jsonl)：60 样本、69,841,511 完成请求；
[Node 最终 JSONL](./bench/r4-6-verified-node.jsonl)：60 样本、33,047,152 完成请求。
合计 **102,888,663** 请求，HTTP errors/timeouts/non2xx 全为 0；两份均完整 67 行
（1 run、60 sample、6 summary），全部客户端正常退出后才确认样本成功。

结束后独立重算每个样本的总数、直方图、RPS、CPU、连接分配及容量标记，全部一致；
当前 src、完整 harness 和各 fixture 指纹与最终元数据逐一相符。Bun 最大启动偏斜
2ms、墙钟/单调差 0.920ms；Node 分别为 3ms、0.917ms。客户端最大 CPU 分别为
67.8% / 42.9% 单核，均无容量警告；结束后无本轮 benchmark 子进程残留。

以下才是本切片最终表，统计单位和配对方法同 §5，不能与首轮混挑较优数字。

| runtime | 场景           |  RPS K/H（k） | 相对 Hono |      五轮范围 | p99 K/H |  CPU μs K/H |
| ------- | -------------- | ------------: | --------: | ------------: | ------: | ----------: |
| Bun     | probe-scoped-3 | 251.6 / 249.0 |     +1.1% |   −0.6～+5.1% |     1/1 |   4.06/4.12 |
| Bun     | text           | 260.3 / 263.1 |     −1.0% |   −3.4～+1.4% |     1/1 |   3.92/3.90 |
| Bun     | json           | 252.9 / 246.7 |     +2.5% |   +0.5～+2.8% |     1/1 |   4.01/4.14 |
| Bun     | param          | 253.4 / 250.0 |     −0.1% |   −2.1～+3.1% |     1/1 |   4.02/4.12 |
| Bun     | middleware-3   | 206.6 / 195.3 |     +6.2% |   +5.1～+7.8% |     1/2 |   4.98/5.34 |
| Bun     | json-body-safe | 194.0 / 185.4 |     +4.7% |  +0.5～+14.3% |     1/2 |   5.28/5.56 |
| Node    | probe-scoped-3 | 129.8 / 113.8 |     +7.7% |  +6.9～+15.9% |     2/2 |   7.78/8.85 |
| Node    | text           | 131.5 / 118.0 |     +9.8% |  +8.8～+13.1% |     2/2 |   7.67/8.58 |
| Node    | json           | 130.2 / 123.8 |     +5.2% |   +0.1～+7.8% |     2/2 |   7.73/8.17 |
| Node    | param          | 131.0 / 122.5 |     +4.5% |   −0.6～+8.2% |     2/2 |   7.71/8.25 |
| Node    | middleware-3   |   94.3 / 56.3 |    +67.5% | +62.5～+71.5% |     2/4 | 10.75/18.12 |
| Node    | json-body-safe |   97.6 / 76.6 |    +30.0% | +14.8～+39.2% |     2/4 | 10.38/13.19 |

Node 六组吞吐配对中位数均为正，但参数路由仍有一轮落后；Bun 文本/参数路由没有
稳定领先。两运行时仍未达到“所有目标场景稳定超过 Hono 10%”，更不能由这些场景
外推出所有生产部署、错误负载或完整 chunked 安全语义的结论。最终 p99 相等或较优，
不抹掉前两批出现过的不利尾延迟观测，也不将短时间合成负载认证为普遍低尾延迟。

## 8. 切片验收与后续边界

- [x] 新测量协议、实际生产模式、真实 Node 发压身份均有独立可运行校验。
- [x] GET/POST 同一多进程实现，总连接数守恒；无旧 POST 特殊实现或协议静默回退。
- [x] 共同窗口 RPS、HDR 分位数合并、CPU 差分、时钟污染及容量警告均有测试。
- [x] 真 HTTP 测试保留；不可达、失败响应、取消、异常退出及挂起回收覆盖完整。
- [x] 独立对抗审查与假绿抽查完成；B46-6/7 五项先红后绿，静态复审确认修复。
- [x] 最终 23 项新装置测试纳入全量 Node/Bun 门禁，旧断言无删除、跳过或弱化。
- [x] 改动文件 lint 0-0、typecheck/build/test、覆盖率不降及双形态进程门通过。
- [x] 最终两套完整矩阵、容量对照、拒绝批次与指纹均落档，不挑选有利样本拼接。
- [x] 仅本仓 bench/test/docs；src 与 Tillgate 未修改，无数据迁移，独立提交可回滚。

本次交付的是可复核的测量及故障处理，不是框架源码提速，更不是“最优算法”的证明。
R4.5 整体目标及全仓既存 43 项 lint warnings 仍未核销。后续源码优化归属 Bun
adapter / Response 构造与执行路径，须先做函数级 CPU profile 和单变量验证；本轮
进程 CPU 数据只把范围收敛到服务端固定成本，不能代替函数级归因，更不支持删除安全守卫。
