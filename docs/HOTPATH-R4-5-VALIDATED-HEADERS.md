# R4.5 默认状态带头响应：先验证，按需物化

> 状态：局部实现与复验完成；R4.5 整体未核销（2026-09-03）
> 基线：`800f228`；仅 bun-koa；本切片合并 DESIGN / IMPLEMENTATION / MIGRATION。
> 用户裁决：优化带头响应的验证与构造成本，保留全部安全守卫，不保留旧逻辑兼容层。

## 1. 设计与预算

外部 API 不变：`c.text/json/html`、state-mode、Response 的 headers/body/readers/clone
继续按原契约工作。早抛错、二进制快照、唯一公开 Headers 所有者、clone/used/locked、
错误信封及 HTTP 分帧守卫全部保留；错误观察 API 不变。

默认状态（status 为 undefined/200，statusText 为 undefined/空串）的 headers 在构造时
只交给原生 Headers 验证和快照。快照只供框架内部写出，不作为公开 response.headers。
首次公开观察 headers/body/clone/readers 时，物化唯一 Response，并释放内部头快照；
所有后续 API 使用该原生对象。非默认或需要强制转换的状态仍交原生 Response 验证。
这是按输入语义分类，不是保留新旧双轨实现。writer 仅接受一种规范化 Headers 表示。

默认裸响应维持两个 own fields；默认带头响应不构造 Response/body stream，不增加
Promise、跨请求缓存、计时器或 IO。框架只做一次标准化快照及一次写出遍历；Headers
内部的排序/合并由运行时负责，不据此宣称整个算法严格 O(n)。二进制 body 在计划构造时
仍复制一次。字符串默认 Content-Type 以运行时原生行为为准：已实测 Node
22.20.0 为 `text/plain;charset=UTF-8`，Bun 1.4.0 的 headers 中为空；显式空值不可被覆盖。

本切片验收目标：Node middleware-3 对 800f228 的同轮配对 RPS 中位数至少 +10%，
5 轮均不回退；其余既有场景不能出现可重复的 >5% 回退。两运行时均复验。该局部预算
不替换原 R4.5 的整体 +10% 及其他未达目标，不宣称算法最优或任意生产部署领先。
不处理路由算法、全局链、JSON body、Tillgate、错误策略；归属各原有模块及后续切片。

## 2. 审计与逐模块裁决

| 文件                                    | 裁决 | 审计证据 / 动作                                                                        |
| --------------------------------------- | ---- | -------------------------------------------------------------------------------------- |
| src/core/response-plan.ts               | 重构 | P45-H1：任何 headers init 都立即构造 Response；保留原生 Headers 验证，延迟 body 所有者 |
| src/adapters/node.ts                    | 微调 | P45-H2：writeHeaders 读取公开 res.headers，迫使物化；改为共享规范化 Headers writer     |
| src/core/context/sugar.ts               | 不改 | 所有公开 string/JSON/HTML 构造均指定隐式或显式类型；HEAD/空状态已有独立契约            |
| src/core/respond.ts                     | 不改 | state-mode 默认 200 带头路径是本切片目标；rule-4/HEAD 等公开观察保持物化               |
| test/r4-5-response-plan.test.ts         | 保留 | 11 项已有所有权/验证/快照等规格，全部原样回归                                          |
| test/r4-5-node-header-ownership.test.ts | 保留 | 3 项请求头/body/已删除类型契约                                                         |
| test/r4-5-node-failure-framing.test.ts  | 保留 | 3 项 used/locked/producer-error 管线错误信封                                           |

真 bug：B45-H3（P1，Node writer 分帧），800f228 上已复现 `c.text` 同时提供 Content-Length/Transfer-Encoding
会输出冲突分帧，客户端报解析错误。本波修复：写出时有 Transfer-Encoding 就去掉
Content-Length（含普通流响应），已知直接 body 且无 TE 时继续重算精确字节长度。
新增 keep-alive 连接连续 fixed/chunked/fixed 回归。B45-14 至 B45-18 不得复发。
重复清单：D45-H1，
计划头与原生响应头若分开实现 writer 会重复 cookies/headers 逻辑，统一为一个 writer。
契约缺口：内部快照不可泄露为第二个公开可修改头对象；字符串隐式类型必须覆盖双运行时差异。

## 3. 测试与实施顺序

1. 新增结构预算用例，在基线上确认默认带头仍物化；新增 Headers/record/tuple/一次性
   iterable 快照、非法名字/值、显式空类型、隐式类型、clone/live headers/body 锁定矩阵。
2. 实现仅上述两个源文件，保留全部旧测试；新增真实 HTTP 头/多 cookie/Unicode 长度、
   stale Content-Length 和后续请求分帧、观察前后响应一致、错误信封回归。
3. 四门及完整 Node/Bun、coverage、source/dist 进程检查；覆盖率不低于基线
   statements 97.35 / branches 92.15 / functions 96.29 / lines 98.73%。不降低门限。
4. 源码冻结后，与独立 800f228 checkout 和同版本 Hono 顺序交错压测；每样本新进程，
   相同 connections/duration/pipeline，保留原始 JSONL、配对比率、p99、错误统计。
5. 记录实际结论后独立提交；本切片可单独 revert，回滚无数据动作。无需消费方 API 迁移。

## 4. 验收记录

- 既有测试迁移：全部保留，无删除、无断言降级。
- 构造预算测试在 800f228 上先失败；其余六项新增构造行为测试在基线上通过。
  新实现七项通过。B45-H3 独立运行基线 HTTP 确认 CL/TE 冲突，再新增回归并修复。
- 装置适配：Bun 1.4 原生 string body 在 getReader 时就 bodyUsed=true，Node 要到 read；
  新测试与所在运行时的原生 Response 对照，不把 Node 的时序强加给 Bun。原有测试无改动。
  native clone 不持有 Keala 直接 body 事实，流测试不传入无法验证的伪长度；已知计划
  则显式传入错误长度验证修正，两者均检查输出。没有将 native clone 变成直写计划。
- Node / Vitest：112 文件，2037 pass / 8 skip；Bun：112 文件，2008 pass / 37 skip。
- 覆盖率：statements 97.35 / branches 92.19 / functions 96.29 / lines 98.74%，不低于基线。
- fmt / typecheck / build 通过；改动的源文件和测试 lint 0 warning / 0 error；全仓仍有
  既存 lint warnings，0 error。既存 warning 未归零，不冒称全仓达到 lint 0-0。
- smoke / example / soak（24×20,000）通过；Node/Bun × source/dist 进程检查全部通过。
- Tillgate 不在修改范围，也没有将上一轮消费方测试冒充本轮结果。
- R4.5 整体未达项继续以 [复核报告](./HOTPATH-R4-5-CONTRACT-AUDIT.md) 为准。

## 5. 性能复验

Apple M4，Node 22.20.0 / Bun 1.4.0，Hono 4.13.5 / 官方 Node adapter 2.1.1。
沿用上一轮相同 harness 和 fixtures；基线改为独立 checkout `800f228`，没有与缺少
安全守卫的 3c4347f 比较。每运行时 6 场景 × 5 轮 × 3 变体，顺序轮换；每样本重启
服务，200 connections / pipeline 1 / 1s warmup / 5s measurement；GET 4 workers，
POST 0 workers。压测与其他重负载测试分开，整个矩阵内不修改源码。

源码指纹：当前 `54c485e2ce1884c38a8a6832f203ef5684d993eca190a7180daf43a2ef44ac08`，
基线 `70d3c1f04f77282c9f63a068a60b27a2120054c4badd536a3f575288693b947f`。
run 元数据中的当前 revision 为修改前 HEAD，修改后的具体内容以 sourceSha256 标识。
原始文件记录每样本 PID、次序、吞吐、延迟分位数、错误及内存快照。

主指标是每轮配对 RPS 比率的中位数，不是独立 RPS 中位数的商；5 个比率的 min/max
不是置信区间。middleware-3 是两层路由级洋葱加 handler，不冒充全局链；JSON body
仅比较 declared 请求的前后字节检查，Hono fixture 没有 Keala 的 chunked 缓冲上限。
内存为瞬时快照，不是峰值或 GC 后存活量；短跑无错误不证明所有生产负载下无故障。

### 5.1 Node

[原始 JSONL](./bench/r4-5-headers-node.jsonl)：90 个完整样本，50,309,286 个完成请求，
errors/timeouts/non2xx 全部为 0。p99 为当前 Keala / Hono 的中位数，单位 ms。

| 场景           | 相对 800f228 | 相对 Hono | p99 |
| -------------- | -----------: | --------: | --: |
| probe-scoped-3 |        -0.2% |     +7.0% | 2/2 |
| text           |        -1.3% |    +15.1% | 2/2 |
| json           |        +0.2% |     +4.9% | 2/2 |
| param          |        -2.6% |     +5.8% | 2/2 |
| middleware-3   |       +20.8% |    +63.1% | 2/4 |
| json-body-safe |        +0.4% |    +16.5% | 2/2 |

带头链当前独立中位数 91,193.6 RPS，基线 75,475.2 RPS，Hono 56,790.4 RPS。
对应 p99 中位数为当前 2ms、基线 3ms、Hono 4ms。
对基线五轮提升范围 +20.2%～+22.3%，均超过局部 +10% 目标；其余路径没有重复出现
大于 5% 的下降。这证明本切片的局部收益，不用跨时刻历史数据声称精确收回全部 18.5%。

### 5.2 Bun

[原始 JSONL](./bench/r4-5-headers-bun.jsonl)：90 个完整样本，96,101,174 个完成请求，
errors/timeouts/non2xx 全部为 0。两运行时合计 146,410,460 个请求；结束后重新计算
源码指纹，与两次 run 元数据完全一致。实际安装的依赖版本也与上述版本相同。

| 场景           | 相对 800f228 | 相对 Hono | p99 |
| -------------- | -----------: | --------: | --: |
| probe-scoped-3 |        +0.6% |     +2.4% | 1/1 |
| text           |        +0.6% |     +0.0% | 1/1 |
| json           |        -0.5% |     +2.3% | 1/1 |
| param          |        -0.4% |     +1.2% | 1/1 |
| middleware-3   |        -0.2% |     +1.9% | 2/2 |
| json-body-safe |        -0.1% |     +0.2% | 2/2 |

Bun 各场景对基线接近持平；本切片没有改变 Bun 的正常响应写出路径，不把这些小幅
波动解释为优化收益。Bun text/body 相对 Hono 也仍是持平，不能称为框架整体超越。

复现（baseline 需独立 checkout 到 800f228，依赖版本一致；输出文件必须尚不存在）：

```sh
KEALA_BENCH_BASELINE=/path/to/baseline KEALA_BENCH_OUTPUT=/tmp/new-headers-node.jsonl node bench/run-node-hotpaths.mjs 200 5 5
KEALA_BENCH_BASELINE=/path/to/baseline KEALA_BENCH_OUTPUT=/tmp/new-headers-bun.jsonl node bench/run-bun-hotpaths.mjs 200 5 5
```

## 6. 局部交付与整体边界

- [x] 默认 200 带头路径先验证快照，未观察时不构造 Response/body stream；不增加公共 API。
- [x] 原生校验、byte 快照、唯一公开 Headers、clone/used/locked、错误隔离等旧守卫保留。
- [x] B45-H3 基线复现及回归通过；固定长度、chunked、foreign stream 连续复用连接。
- [x] 原用例全部保留；新增 9 项用例，双运行时通过，覆盖率不下降。
- [x] fmt/typecheck/build、smoke/example/soak、双运行时 source/dist 通过。
- [x] 改动文件 lint 0-0；全仓既存 warnings 如实保留，未声称全仓 0-0 已核销。
- [x] Node 带头链五轮全部提升超过 10%，其余路径无可重复 >5% 回退；原始数据已落档。
- [x] 只修改 bun-koa；独立提交可回滚，无数据迁移，无兼容层。

整体仍未达：Bun 全场景稳定高于 Hono 10%、全局链匹配负载、完整 chunked 安全语义
对拍、跨机器稳定性等原目标没有本轮达标证据。Node 也不是每个场景都超过 Hono 10%。
本切片解决的是已测得的带头构造成本，不是对整体最优算法或任意生产负载的保证。
