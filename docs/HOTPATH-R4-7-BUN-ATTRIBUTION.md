# R4.7 Bun 热路径归因与靶向优化

> 状态：已完成（2026-09-03）
> 基线：db403e5（R4.6 装置与其完整快照）；最终 src 与基线一致，无改动。
> 用户裁决：先以生产模式、多进程发压与 CPU 归因装置弄清「Bun 热路径还剩多少框架可优化成本」，
> 再决定优化哪里；全部安全守卫保留。本文合并本切片的 DESIGN / IMPLEMENTATION / MIGRATION。

## 1. 背景与归因结论

上一轮分析已确认三件事：Node 侧延迟构造 Response 的收益不覆盖 Bun（Bun 直接消费原生
Response）；JSON「持平」受发压端单核饱和压缩；文本路径优势被 HTTP 收发共同成本稀释。
本轮在同一测量协议（生产模式、4 进程发压、服务端 CPU ns/请求）下加入**裸运行时对照**，
把「框架自身成本」从运行时与装置成本中分离出来：

- Bun：text / param / probe-scoped-3 / json 四场景，Keala 相对裸 `Bun.serve` 的中位开销在
  **−30ns ~ −13ns**（噪声级，且对照组自身每请求付一次 `new URL` 解析成本）；Hono 为
  +35ns ~ +150ns。
- Bun：json-body-safe Keala +68ns（1.1%），Hono +296ns；middleware-3 Keala **+876ns（18%）**，
  Hono +1442ns。
- Node：同样形态。四简单场景 Keala −322ns ~ +200ns；json-body-safe +863ns；middleware-3
  **+2835ns（34%）**，Hono +10453ns。
- 唯一存在大幅框架归因成本的场景是 **middleware-3**（异步中间件链 + 头暂存 + 带记录
  finalize），两个运行时一致。其余场景 Keala 已贴着裸运行时地板，继续优化没有可归因的收益空间。

R4.6 遗留的 POST 单进程容量对照亦已补齐：Bun 下 1 进程发压端单核 100.7%/101.1%（3/3 样本
容量受限），测得 Keala/Hono = 0.995 —— 与 4 进程（发压端 30-65%）下 1.18 的真实差异相比，
「持平」确认为发压端瓶颈伪象。Node 下 1 进程发压端 86.3%/79.5%（未触 90% 预算），比率 1.166。

## 2. 裸运行时对照装置（bench-only）

`KEALA_BENCH_CONTROLS=1` 时 runner 追加第三服务端 `bare`（按运行时选择
`bench/server-bare.ts` / `bench/server-bare-node.ts`），进入同一轮转、同一校验、同一
CPU 汇总；`versusHono` 配对口径不变。开关默认关闭，R4.6 已锁定的 runner 契约测试
（4 条记录、协议 2 元数据）不受影响；新增 `test/bare-control.test.ts` 以开关全流程
跑通双运行时（5 条记录、bare 样本协议 2、汇总含 bare CPU）。

裸 fixture 契约：无任何框架导入；六场景路由逐条对齐（含 `/mw` 三个 x-step 头、
echo-safe 的 1024 字节上限短路 413 / 坏 JSON 400）；冷端点复用 `server-metrics.ts`
（协议 2）。对照组每请求付一次 `new URL` 解析，因此「裸地板」略偏保守（偏慢）——
所有负开销读数应理解为「不高于地板 + URL 解析成本」。

## 3. 候选优化与配对否决

依据第 1 节归因，实现了两处候选微优化并做了完整配对复测：

1. **头名校验记忆化**（`src/utils/text.ts`）：`validateHeaderName` 是名字的纯函数，
   已证有效的名字进有界（512）Set 记忆，命中即跳过正则；非法名字抛错前永不入集，
   接受/拒绝语义位级一致；值校验保持逐次全量执行。
2. **fromState 带记录路径单次 Headers 构造**（`src/core/respond.ts`）：非 multi-value
   时 record 直交 PlannedResponse，省去「`new Headers()` + N 次 set 后再复制一份」的
   双重构造；fetch 式 source 保留原 Headers 构建路径。

配对复测（`KEALA_BENCH_BASELINE` 指向 db403e5 worktree，4 进程，两运行时六场景各 5 轮，
主指标为每轮 keala/keala-baseline 配对比率中位数）：

| 场景           | Bun vs 基线（区间）      | Node vs 基线（区间）     |
| -------------- | ------------------------ | ------------------------ |
| probe-scoped-3 | 1.0029 [0.981,1.048]     | 1.0011 [0.975,1.042]     |
| text           | 1.0032 [0.995,1.016]     | 1.0007 [0.971,1.029]     |
| json           | 0.9962 [0.994,1.002]     | 0.9969 [0.986,1.023]     |
| param          | 1.0032 [0.985,1.011]     | 1.0249 [0.926,1.098]     |
| middleware-3   | **0.9984 [0.983,1.010]** | **1.0016 [0.968,1.023]** |
| json-body-safe | 1.0004 [0.967,1.031]     | 1.0126 [1.009,1.015]     |

**结论：否决并回退。** 靶向目标 middleware-3 在两个运行时均为零收益（0.998/1.002，
区间跨 1）；唯一信号是 Node json-body-safe 的 +1.3%（窄区间），但目标运行时 Bun 上
同改动无效果，且与本切片目标不符。原假设「校验与双重 Headers 构造占 mw-3 增量大头」
被配对数据证伪——该 876ns（Bun）/ 2835ns（Node）主要由异步中间件链的 promise 跳数
（用户代码 `await next()` 固有 + compose/dispatch 层）与运行时调度构成，不属于可在
保留语义下移除的成本。按仓库纪律，无配对证据的性能改动不保留，src 已回退至基线。

已验证排除的其余方向：`handle()` 的 Promise 边界拆除（用户隔离实验三轮涨跌不定）；
路由匹配、body-parser 穿透、Context 分配（裸对照证明在噪声内）。**Bun 热路径在当前
六个官方场景下已无框架可归因的优化空间，middleware 形态的异步跳数除外。**

## 4. 验收记录

### 4.1 质量门禁（最终状态：src 与基线一致，仅装置/测试/文档改动）

| 门禁                                                | 结果                                        |
| --------------------------------------------------- | ------------------------------------------- |
| Node / Vitest + coverage                            | 118 文件，2060 pass / 8 skip                |
| Bun / Vitest                                        | 118 文件，2031 pass / 37 skip               |
| coverage：statements / branches / functions / lines | 97.44 / 92.30 / 96.29 / 98.81%，不低于基线  |
| fmt / typecheck / build                             | 通过                                        |
| 改动文件 lint                                       | 0 warning / 0 error；全仓 43 既存 / 0 error |
| smoke / example / soak / process:check              | 通过（含 24×20,000 请求与四进程形态）       |

新增 `test/r4-7-hotpath.test.ts`：native（node 适配器）与 fetch 双路径锁定 text/json/bytes
带暂存头的线上行为；大规模名字词汇下校验接受/拒绝稳定；重复名字可上线。
`test/bare-control.test.ts`：开关全流程双运行时（5 条记录、bare 协议 2、汇总含 bare CPU）。

### 4.2 配对复测数据

见 `docs/bench/r4-7-paired-{bun,node}.jsonl`（keala / keala-baseline / hono-official
三方同轮轮转，baseline 为 db403e5 worktree）。

## 5. Hono 4.13.5 源码级对比（.parity/hono）

针对「Bun 上为何不能大幅领先 Hono」做了逐模块算法对比。结论：**Hono 的热路径算法
没有一处值得 Keala 采用**；Keala 在全部可测轴上持平或更优，且第 1 节已证明简单场景
贴近裸运行时地板，剩余差距由地板封顶。

| 轴           | Hono 实现                                                                                                | Keala 实现                                                                   | 裁决与证据                                                            |
| ------------ | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 中间件组合   | `compose()` 每请求创建组合闭包，每层 `async dispatch(i)` + `await`，每层一个 `() => dispatch(i+1)` 闭包  | 注册期编译为嵌套层级；同步链全程同步，零 per-request 组合分配                | **Keala 优**。mw-3 比率 Bun 1.06-1.09 / Node 1.65-1.69                |
| Context 构造 | `new Context(req, {options 对象})` 类实例 + 选项分配；`HonoRequest` 惰性但 `c.req` 一触即分配            | 单个 `Object.create(proto)` 平面对象 + 原型哨兵，惰性 facade                 | **Keala 优**。简单场景 Keala−Hono ≈ −65 ~ −163ns                      |
| 路由匹配     | RegExpRouter：静态哈希 + 全部动态路由合并为单个大正则 `path.match(re)`；SmartRouter 首请求回放后猴子补丁 | 静态哈希（原始/去尾斜杠/解码三形态）+ 单参 fast matcher + 首段桶 + trie 兜底 | **Keala 优**（param 1.011-1.020）；大正则对单参路径劣于定点切分       |
| 文本响应     | 惰形路径单次 `new Response(text)`                                                                        | PlannedResponse 延迟构造（服务 Node 直写）                                   | **打平**。Bun 上计划由 Bun.serve 物化，text 场景 Keala 仍 −26ns vs 裸 |
| JSON 响应    | `JSON.stringify` + 小记录 init `new Response`                                                            | `JSON.stringify` + 计划构造                                                  | **Keala 优**（json 1.032-1.038）                                      |
| 请求 body    | `bodyCache` 每请求对象；形态间转换经 `new Response(body)[key]()` 往返                                    | body-parser 一次有界读取 + 备忘                                              | **Keala 优**（json-body-safe 1.028-1.053）                            |
| 分发边界     | 单 handler 同步直返 `Response`（无 Promise 包装）                                                        | `handle()` 恒定 `Promise.resolve` 包装；Node 适配器已直连内部源              | **Hono 形式略优，实测无效**（见 §6）                                  |
| 路径提取     | `getPath` 手写 charCode 扫描                                                                             | `getPath` 手写 charCode 扫描                                                 | **打平**                                                              |

## 6. 同步直返边界的配对否决

§5 中唯一 Hono 有而 Keala（Bun 适配器）没有的结构：同步链不经 Promise 直返
`Response`（Hono 的 `#dispatch` 单 handler 路径如此；Keala 的 Node 适配器
`node.ts:427` 亦已直连 `[HANDLE_REQUEST_SOURCE]`，仅 Bun 适配器走公共
`handle()` 包装）。已实现该改动（Bun 适配器 fetch 直连内部源，公共契约不变）并配对复测：

- 全矩阵 5 轮：同步四场景全正（text +3.9%、probe +0.8%、json +0.7%、param +0.5%），
  异步两场景恰好不动（mw-3 0.996、json-body-safe 1.003）——差异分布与机制吻合。
- 但 text 单场景 10 轮收紧后：**median 1.0038 [0.979, 1.043]**，+3.9% 塌缩为 +0.4%，
  5 轮高读数确认为噪声。

**裁决：+0.4~0.8% 低于主张门槛，回退。** Bun.serve 对已解析 Promise 的调度足够便宜，
单跳 promise 不构成可主张的成本；用户早前的隔离实验（三轮涨跌不定）在新装置下得到
确认。至此「Bun 未大幅领先 Hono」的解释完整：Keala 已在裸运行时地板上领先全部六场景
（−65 ~ −566ns），幅度被 4.4µs 的运行时 HTTP 栈封顶；唯一剩余的 Hono 结构差异
经 15 轮配对测量证明无可主张收益。

## 7. query 场景：真实缺口的发现与收窄

对比 `.parity/hono/benchmarks` 后补齐了其旗舰 HTTP bench 的第三个端点形态（param +
query 读取 + 暂存响应头 + 插值文本），成为官方矩阵第 7 场景 `query`
（`GET /search/12345?name=keala&page=3`，四 fixture + 裸对照同步对齐，
`test/query-scenario.test.ts` 双运行时锁定）。**这是唯一一个 Keala 真实落后 Hono 的
场景**（同轮配对）：

- Bun：**0.9130 [0.814, 0.937]**；框架开销 Keala +429ns vs 裸、Hono +71ns。
- Node：**0.9336 [0.878, 1.023]**；Keala +2293ns、Hono +1475ns。

进程内分解（`/tmp/query-micro.mjs`，Node）：整链 251ns = url 物化 40.5 +
querystring 22.4 + **parseQuery 150.7**；Hono 式两次单键定点提取仅 43.5ns。
原因：`c.query` 的 koa 合同在首次触达时全量物化 QueryMap（先物化 path+search 拼接、
再在其中定位 query、再单遍解析 + 每段 decode 早退检查），而 Hono 的
`c.req.query(key)` 做零分配定点提取。

**合同内修复（两处，语义位级一致，`/a#f`、`/a?f#g` 边界由既有测试锁定）：**

1. `querystring` 单遍扫描原始请求目标（`urlValue ?? sourceUrl`）——只触 query 不再
   物化拼接串；
2. `parseQuery` 无转义快速路径——整串无 `+`/`%` 时 decode 为恒等，跳过全部调用。

**配对复测**（baseline 为 35b5588 worktree + 当前 fixture，query 单场景 5 轮）：
Node **+5.1% [1.007, 1.070]**（紧区间）、Bun +1.1%——与 R4.5「Node 显著、Bun 持平
即保留」的先例一致，保留。进程内 parseQuery 150.7→112.4ns。

修复后官方矩阵（7 场景全量，`r4-7-query-fixed-*`）：Bun query 差距收窄至
**0.9559 [0.925, 0.971]**；Node 本轮 0.858 方差大（hono 相对裸地板的开销跨轮
+1475→+373ns 漂移，交叉轮 vs-hono 不可靠，以同轮配对为准）。其余六场景无回归
（mw-3 1.067/1.628、json-body-safe 1.093/1.271）。

**残差定性**：剩余 4-10% 差距是 API 形态差异而非算法劣汰——koa 的 `c.query` 返回
完整 QueryMap（读全部键时一次解析反而占优），Hono 的 `c.req.query(key)` 为单键
习语。在不动公共合同的前提下已无进一步可主张的空间；引入单键 API 属产品决策，
不为基准分数增加。

## 8. 复现

```sh
# 裸对照矩阵（开销归因）
KEALA_BENCH_PROCESSES=4 KEALA_BENCH_CONTROLS=1 \
  KEALA_BENCH_OUTPUT=/tmp/r47-bun.jsonl node bench/run-bun-hotpaths.mjs 200 5 5
KEALA_BENCH_PROCESSES=4 KEALA_BENCH_CONTROLS=1 \
  KEALA_BENCH_OUTPUT=/tmp/r47-node.jsonl node bench/run-node-hotpaths.mjs 200 5 5
# 单进程容量对照（R4.6 §3.5 验收项）
KEALA_BENCH_PROCESSES=1 KEALA_BENCH_OUTPUT=/tmp/r47-cap.jsonl \
  node bench/run-bun-hotpaths.mjs 200 5 3 json-body-safe
# 配对基线（src 改动前后同轮对比）
git worktree add /tmp/keala-baseline db403e5
KEALA_BENCH_PROCESSES=4 KEALA_BENCH_BASELINE=/tmp/keala-baseline \
  KEALA_BENCH_OUTPUT=/tmp/r47-paired.jsonl node bench/run-bun-hotpaths.mjs 200 5 5
```

已归档：`docs/bench/r4-7-controls-{bun,node}.jsonl`（含 bare 的完整矩阵）、
`docs/bench/r4-7-capacity-{bun,node}-1proc.jsonl`（单进程容量对照）、
`docs/bench/r4-7-paired-{bun,node}.jsonl`（候选优化的配对否决数据）、
`docs/bench/r4-7-sync-boundary-{bun,text10-bun}.jsonl`（同步边界否决：5 轮全矩阵 +
10 轮 text 单场景）、`docs/bench/r4-7-query-{bun,node}.jsonl`（query 场景发现矩阵）、
`docs/bench/r4-7-query-fixed-{bun,node}.jsonl`（修复后官方 7 场景矩阵）、
`docs/bench/r4-7q-paired-{bun,node}.jsonl`（query 修复配对证明）。
