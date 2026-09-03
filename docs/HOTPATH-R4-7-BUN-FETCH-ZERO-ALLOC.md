# R4.7 Bun fetch 路径零分配（适配层切片 1）

> 状态：切片 1 完成（2026-09-03）。矩阵结论：Bun 侧效果低于本装置噪声下限，
> 以"零回归 + 机制成立"核销；Node 侧不受影响（对照）。R4.5 整体目标仍未核销。
> 切片 2'（pooling A/B）完成（2026-09-03）：首跑暴露并修复 pooling 两个真实
> 缺陷（5916e40），重跑矩阵证实 pooling 为双运行时一致净退化，前提证伪——
> 详见 [HOTPATH-R4-7-POOLING-AB](./HOTPATH-R4-7-POOLING-AB.md)。
> 基线：20ef4d7；切片 1 提交：5d9b651（仅 src/adapters/bun.ts + test/adapter.test.ts）。
> 目标：R4.5 整体性能目标（所有目标场景稳定超过 Hono 10%）仍未核销，本切片只处理
> 函数级归因确认的适配层固定成本，不宣称整体达标。

## 1. 函数级归因（切片先行的证据）

测量装置：Bun 1.4.0 `--cpu-prof --cpu-prof-md --cpu-prof-interval=250`，被测服务器经
自终止 wrapper 以 `process.exit(0)` 冲刷 profile（SIGINT/SIGTERM 不落盘，这是协议级
发现）；负载为 200 连接 10s autocannon（4 workers）。`/text` 场景，keala 2.48M 请求、
Hono 2.42M 请求，零错误。keala profile 中约 12% 为 `exit` 冲刷伪影，对比时已排除。

| 函数（自时间占比）  |                                                  keala |                                     Hono | 判读                                                                    |
| ------------------- | -----------------------------------------------------: | ---------------------------------------: | ----------------------------------------------------------------------- |
| `Response` 原生构造 |                                                  26.3% |                                    36.5% | 双方共同地板，fetch 路径内不可消除                                      |
| Context 创建        |                             25.1% `createBoundContext` |                  约 25.8% `Context` 合计 | 持平；微基准证伪"构造方式慢"（见下）                                    |
| sugar 前置分支      |                                      13.1% `sugarText` |                        约 2.7% `text` 层 | keala 偏厚，切片 2 候选                                                 |
| 适配层 `fetch`      |                                                   7.7% |                                     0.5% | **keala 独有**：每请求 `{ server }` 字面量 + `handle()` 的 Promise 包裹 |
| 路径提取            | 约 11%（`sourceUrl`/`getPath`/`slice`/`sourceMethod`） |                                   约 10% | 持平，双方同写法                                                        |
| 路由匹配            |                                      1.6% `matchRoute` | 约 20%（SmartRouter `match` + `match2`） | keala 已领先                                                            |

分配微基准（JSC，5M 次/策略，两轮）：`Object.create + 2 puts` 约 1ns/op 为最快，
优于字面量 `__proto__`（约 14ns）、class（约 8-10ns）、pool 复用（约 7-8ns）。
结论：`createBoundContext` 的 25% 是每请求分配点的 GC 压力归因，解法是减少每请求
分配次数，不是更换构造方式。pooling 是否进入 bench fixture 属口径裁决，不在本切片。

## 2. 设计契约

单变量：仅 Bun 适配层 fetch 闭包；不改 dispatch/router/compose/sugar/Response 语义，
不改 Node 适配器，不改 bench 装置与 fixture。公开契约不变：`app.handle()` 仍返回
`Promise<Response>`。行为不变量：

1. `c.ip` 仍经 `runtime.server.requestIP` 解析（既有测试保留）。
2. server 身份变化时重新捕获载体，不缓存陈旧句柄（测试双夏普尔场景）。
3. 同步抛错仍同步传播至 `Bun.serve` 的 error 回调；异步拒绝路径不变。
4. websocket、原生路由表下沉、onListen、serve 选项透传全部不变。

## 3. 实施

`startBunServer` 的 fetch 闭包两处改动（src/adapters/bun.ts）：

1. `{ server }` 载体从每请求新建改为按 server 身份惰性捕获一次。依据：Bun 对同一
   `Bun.serve` 实例的每次 fetch 调用传入同一 Server 对象；即便如此，实现仍在身份
   变化时重新捕获，不依赖该不变式维持正确性。
2. 分发改走内部 `HANDLE_REQUEST_SOURCE`（Node 适配器自 R4.5 起即如此，
   src/adapters/node.ts:427），同步链直返裸 `Response`——`Bun.serve` 接受
   `Response | Promise<Response>`，公开 `handle()` 的 `Promise.resolve` 包裹在
   适配层是纯分配。

新增测试（test/adapter.test.ts，双运行时门禁均运行）：

- 同步链（直处理路由 + `c.text`）的 fetch 返回值为 `Response` 实例而非 Promise。
- 同一 server 身份两次请求收到**同一** runtime 载体引用；身份变化后重新捕获且
  携带新 server。

## 4. 质量门禁（切片 1）

| 门禁                                                | 结果                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------- |
| Node / Vitest + coverage                            | 117 文件，2062 pass / 8 skip（+2 新测试）                                 |
| Bun / Vitest                                        | 117 文件，2033 pass / 37 skip                                             |
| coverage：statements / branches / functions / lines | 97.35 / 92.20 / 96.29 / 98.74%，不低于基线 97.35 / 92.19 / 96.29 / 98.74% |
| 改动文件 fmt / lint                                 | fmt 通过；lint 0 warning / 0 error                                        |
| typecheck / build                                   | 通过                                                                      |
| smoke / example:check / soak / process:check        | 通过                                                                      |

## 5. 测量

### 5.1 试点（仅方向性，非正式结论）

单轮非交错试点受机器噪声支配（同窗口绝对 RPS 较昨日 profile 轮整体下移约 25%），
不据此宣称任何增益；正式结论只认 §5.2 的 R4.6 协议矩阵。

### 5.2 R4.6 协议正式矩阵（切片 1 冻结后）

命令（与 R4.6 §4.3 相同协议，输出路径预先不存在）：

```sh
KEALA_BENCH_PROCESSES=4 KEALA_BENCH_OUTPUT=docs/bench/r4-7-slice1-bun.jsonl node bench/run-bun-hotpaths.mjs 200 5 5
KEALA_BENCH_PROCESSES=4 KEALA_BENCH_OUTPUT=docs/bench/r4-7-slice1-node.jsonl node bench/run-node-hotpaths.mjs 200 5 5
```

原始数据：[Bun JSONL](./bench/r4-7-slice1-bun.jsonl)（60 样本、45,257,758 请求）、
[Node JSONL](./bench/r4-7-slice1-node.jsonl)（60 样本、28,975,096 请求）。合计
74,232,854 个完成请求，errors/timeouts/non2xx 全为 0，无容量警告。装置指纹
`11fec96b…`，与 R4.6 最终矩阵同一冻结装置。

| runtime | 场景           | 相对 Hono | 五轮范围      |  RPS K/H（k） | CPU μs/req K/H |
| ------- | -------------- | --------: | ------------- | ------------: | -------------: |
| Bun     | probe-scoped-3 |     +2.2% | −2.8～+16.7%  | 173.7 / 164.4 |    5.61 / 5.95 |
| Bun     | text           |     −1.8% | −8.3～+3.0%   | 168.1 / 171.1 |    5.68 / 5.69 |
| Bun     | json           |     +1.2% | −0.5～+1.5%   | 156.8 / 156.0 |    6.13 / 6.21 |
| Bun     | param          |     −0.7% | −3.4～+3.1%   | 160.1 / 162.7 |    6.03 / 6.00 |
| Bun     | middleware-3   |     +1.6% | −13.2～+25.5% | 140.5 / 137.6 |    6.96 / 7.25 |
| Bun     | json-body-safe |     +1.2% | −3.9～+5.2%   | 123.5 / 123.4 |    7.74 / 7.85 |
| Node    | probe-scoped-3 |    +12.5% | +1.8～+16.7%  |  105.0 / 92.3 |   9.26 / 10.40 |
| Node    | text           |     +8.4% | −0.8～+9.4%   | 107.9 / 104.6 |    8.99 / 9.31 |
| Node    | json           |     +7.8% | +4.3～+18.6%  |  108.9 / 92.4 |   8.96 / 10.20 |
| Node    | param          |     +9.2% | +2.0～+14.9%  | 115.5 / 104.3 |    8.53 / 9.48 |
| Node    | middleware-3   |    +54.2% | +47.7～+56.3% |   90.8 / 58.9 |  10.95 / 16.99 |
| Node    | json-body-safe |    +14.4% | +12.3～+19.6% |   94.9 / 83.0 |  10.51 / 12.12 |

#### 5.2.1 这组结果能证明什么

1. **Node 列是切片 1 的对照**：本切片不改 Node 路径，但 Node 六场景相对 R4.6
   最终表仍漂移 −15.6～+4.8 个百分点（middleware-3：67.5%→54.2%；json-body-safe：
   30.0%→14.4%；probe：7.7%→12.5%）。这界定了跨窗口噪声量级；同一幅度的 Bun 侧
   变动（−5～+1 个百分点）不能归因于切片 1。
2. **Bun 侧结论：零回归，机制层面的增益低于装置分辨力**。六场景服务端 CPU/请求
   中位数 5 项不差于 Hono（text 持平、param 略差 0.03μs、其余略优），与 R4.6
   同形态；吞吐配对比率全部落在 R4.6 对应噪声带内。切片 1 每请求消除两次堆分配
   是 profile 证实的机制，但在当前机器状态（本轮 Bun 绝对吞吐较 R4.6 窗口整体
   下移约 30%，双框架同步下移）下，其 RPS 效果低于 5 轮配对中位数的噪声下限。
   不按"碰巧为正的中位数"宣称提速。
3. 处置：切片 1 保留（零回归、消除真实分配、与 Node 适配器同构），不宣称 Bun
   侧可测增益。**推论：fetch 路径内剩余单项（sugar 分支合并、method 槽缓存等）
   预期效果同样低于噪声下限，继续微切片无法被本装置验证**——后续只保留两个
   预期效果远大于噪声的结构杠杆：pooling 进入 bench fixture（口径裁决项）与
   原生路由表下沉扩展（设计切片）。

## 6. 后续切片（按 §5.2.1 推论重排）

- ~~切片 2：sugar happy-path 融合守卫~~ **降级**：机制真实但预期效果（约 1% 量级）
  低于装置噪声下限，做了也无法被验证；除非测量分辨力提升（更多轮次、更安静窗口），
  不再作为性能切片立项。可作为纯可读性重构另行评估，但不计入性能证据。
- 切片 2'（裁决项，优先）：**pooling 进入 bench fixture**。`createBoundContext`
  的 25.1% 采样归因是本路径最大 JS 项；pooling 是已有、受测、opt-in 的正式特性
  （dead-proto 防护），Hono 无对应物。用户已裁决（2026-09-03）：**双配置都测并
  都披露**——见 [HOTPATH-R4-7-POOLING-AB](./HOTPATH-R4-7-POOLING-AB.md)。
  **完成（2026-09-03）**：首跑暴露 retireWithBody 消费包裹两个真实缺陷（Bun 下
  sugar 文本响应丢 content-type、双运行时 4.2x/2.4x 吞吐坍塌），修复 5916e40
  后重跑四腿矩阵（200M 请求、零错误、时钟监视窗口）。**结论:pooling 在双运行时
  为一致净退化（−20~−49pp,五轮范围不与零相交）**,死防护 proto swap（~1.6μs/req）
  与回收成本大于其节省的分配;"pooling 是大杠杆"的前提证伪,维持 opt-in 定位,
  转正须先重设计死防护（独立切片）。
- 切片 3'（结构性）：**原生路由表下沉扩展**——函数 handler 下沉（覆盖参数路由
  `/users/:id`）与中间件透明性声明（让 `createBodyParser` 这类自有插件声明
  "对无正文 GET 无效"，使静态路由在带全局中间件的应用里也可下沉）。这是唯一
  能绕开 `new Response` 原生地板（双方各 26-37%）的路径，预期效果远大于噪声。
  用户已裁决（2026-09-03）：**暂缓**，先完成高分辨力测量；立项时须独立设计
  文档与镜像语义审计。
- 测量分辨力：若需验证 <3% 的 Bun 侧效果，下一轮起把轻场景轮数提高到 10+ 并在
  机器空闲窗口执行；本轮已证明 5 轮协议在当前噪声下不足以分辨。
