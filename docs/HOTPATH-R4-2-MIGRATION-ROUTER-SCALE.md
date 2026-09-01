# R4.2 — 路由规模自适应研究迁移文档

> 状态：已核销（出口 A 不变；R4.2-B1 严格 JSON comparator 已修正）
> 设计基线：[HOTPATH-R4-DESIGN.md](./HOTPATH-R4-DESIGN.md) §4/§6
> 基线提交：`31aa3ee`（R4.1 已核销）
> 工作分支：`codex/hotpath-r4-2-router-scale`
> 对照对象：Hono 4.13.5（RegExpRouter + SmartRouter，随安装版本实测）

## 1. 范围与边界

本单元回答一个问题：**keala 的 static Map + bucket fast matcher + trie 混合路由，
在 1–10k 路由规模下是否需要被编译期 dispatcher（regexp 化）取代？**

- 只新增基准 harness 与 runner；**不改任何 `src/` 代码**。若数据显示需要修复，
  修复本身是后续独立提交/单元，本单元只负责给出证据与裁决。
- JSON 对照（§4）同样只读现有实现，用于裁决 body 加速单元是否立项。
- wildcard、可选参数、自定义 pattern 不进入本矩阵：DESIGN §4 的矩阵口径是
  「静态、单参、冲突动态、失败匹配」；其余形状留待 dispatcher 单元（若立项）
  一并覆盖。
- Tillgate 不涉及。

## 2. 矩阵定义

### 2.1 三种路由表（每种独立构建，不混表）

| 表             | 注册路径（i ∈ [0, N)）    | 考察的算法路径                                                       |
| -------------- | ------------------------- | -------------------------------------------------------------------- |
| static         | `GET /res-{i}`            | staticMap O(1) 精确命中 vs Hono 单一大正则                           |
| param-distinct | `GET /res-{i}/:id`        | 每个首段独占 bucket，keala fast matcher 开启                         |
| param-shared   | `GET /items/:id/item-{i}` | 全部共享首段 bucket（count=N），fast 关闭，纯 trie 走 Map 静态子节点 |

param-shared 是「冲突动态」的落地：同一名参数占据同一位置、N 条路由共享一个
bucket，是 keala 与 regexp dispatcher 分歧最大的形状。trie 静态子节点为
`Map<string, TrieNode>`（`src/router/trie.ts`），每段 O(1)，理论匹配成本与 N
无关——本矩阵就是验证该主张在真实 JSC 下的形状。

### 2.2 规模与探针

- 规模：N ∈ {1, 10, 100, 1000, 10000}。
- 每表四个探针（同一进程内依序测量，各自独立采样）：
  - `hit-mid`：命中中间路由（`i = N >> 1`）；
  - `hit-last`：命中最后路由（`i = N - 1`，regexp 有序分支的最坏情形）；
  - `miss-global`：`/definitely-missing`（全表不匹配 → 404）；
  - `miss-deep`：命中前缀但多一段（如 `/res-{mid}/42/extra`，失败匹配）。
- 注册耗时：路由注册循环墙钟（含两框架各自的索引构建；Hono RegExpRouter
  惰性编译计入首次请求，报告中单列说明）。
- 构建后堆增量：注册前后 `heapUsed` 差（GC 后取值，仅作规模指示，不作裁决依据）。

### 2.3 正确性先于计时

计时前断言每个探针的 status、body 与参数值（param 表 handler 返回参数内容），
任何断言失败该进程作废；404 探针断言 status 404。计时循环内持续断言 status。

## 3. 方法论

- 每个变体独立 fresh process：`bun bench/router-scale.ts <framework> <kind> <size>`。
- runner（`bench/run-router-scale.mjs`）按 4 轮旋转顺序（keala/hono 交替领跑）
  采样，报告每探针「轮间中位数的 median 与 IQR」。
- 进程内：每探针 warmup 3,000 次，15 样本 × 3,000 次批，median ns/req。
- 结果同时落盘 `bench/router-scale-results.json`；报告表进本文档 §7。
- 与既有 wire 级 1000-route 数据（`bench/BENCH.md`，keala 247k vs Hono 249k RPS
  平手）互为印证：wire 级受客户端饱和摊薄，进程内数字才裁决算法。

## 4. JSON 公平对拍协议

现状 `body` 场景对照不同语义：keala `createBodyParser({ jsonLimit: 1024 })`
有完整字节预算，Hono 侧是裸 `c.req.json()`。本单元给 Hono 增设等语义对照
`body-limited`，语义逐条对齐 keala `readBodyLimited`：

1. Content-Length 声明值超限 → 413（不读流）；
2. 流式累计字节数超限 → cancel reader 并 413；
3. 解析失败 → 400；
4. 单次读取（不等价的 memoization 不模拟，只保证单次读取成本一致）。

happy path 计时对比 keala `body`；413/400 行为在计时外各验证一次。裸 Hono
JSON 数字保留为非等价参考行。

## 5. 裁决标准（预先固定，不允许看数后改口径）

对每个「表 × 规模 × 探针」格，比较 keala 与 Hono 的 median 与 IQR：

- **出口 A（不重写）**：所有 N ≥ 1000 的格，keala 慢 ≤5% 或 IQR 重叠 → 不立项
  dispatcher；R4.2 结论为「现有混合路由在 10k 内无病态」，预算转向 body/企业能力。
- **出口 B（立项 dispatcher）**：任一 N ≥ 1000 的格 keala 慢 ≥15% 且 IQR 不重叠
  → 立项「编译期 regexp dispatcher」迁移单元（compatible patterns 编译、高级
  pattern 回落 trie、static Map 保留）。
- **出口 C（定点修复注册）**：请求期全达标，但注册耗时或构建内存呈超线性
  （如 10k 注册 > 1s 或堆增量 > Hono 5 倍）→ 只做注册算法修复，不动请求期。
- 5%–15% 之间视为灰区：记录数据，挂起裁决，等 R4.3 后重测（避免为噪声立项）。
- JSON：公平对拍下 keala 慢 <8% → body 单元降级为注册期 limit 编译小优化；
  慢 ≥15% 且可归因（流式计数 vs 裸读的差）→ body 加速单元立项，红线不变
  （不取消 413，不引入裸 `request.json()`）。

## 6. 停止条件

- 任一框架在 10k 注册或匹配抛错且非 harness 缺陷；
- 机器噪声使同框架相邻两轮 median 差 >10%（弃用该轮全部数据并重跑）；
- 总时长不可控时缩减规模集合至 {10, 1000, 10000}，但须在报告注明。

## 7. 结果

环境：Apple M4 / 16GB，Bun 1.4.0，Hono 4.13.5，keala @ `31aa3ee`。矩阵 4 轮
旋转顺序（每轮 keala/hono 交替领跑），每格独立 fresh process；下表为轮间中位数，
比值为 keala/hono；完整 IQR 原始数据在 `bench/router-scale-results.json`。

### 7.1 匹配矩阵（ns/req，keala/hono，比值 <1 为 keala 更快）

**static（`/res-{i}`，staticMap vs 单一大正则）**

|  size |        hit-mid |       hit-last |    miss-global |      miss-deep |
| ----: | -------------: | -------------: | -------------: | -------------: |
|     1 | 425/386 (1.10) | 426/357 (1.19) | 432/662 (0.65) | 376/607 (0.62) |
|    10 | 418/379 (1.10) | 430/406 (1.06) | 422/646 (0.65) | 385/627 (0.61) |
|   100 | 448/388 (1.15) | 403/389 (1.04) | 419/640 (0.65) | 364/601 (0.61) |
|  1000 | 432/421 (1.03) | 426/392 (1.09) | 410/639 (0.64) | 407/616 (0.66) |
| 10000 | 382/399 (0.96) | 361/425 (0.85) | 377/724 (0.52) | 349/663 (0.53) |

命中 IQR 全部重叠（keala 中位数落在 Hono IQR 内）；**miss 全规模 keala 快
35–48%**——Hono 正则失败要全表扫描，staticMap 一次未中即返回。

**param-distinct（`/res-{i}/:id`，bucket fast matcher 开启）**

|  size |          hit-mid |         hit-last |     miss-global |       miss-deep |
| ----: | ---------------: | ---------------: | --------------: | --------------: |
|     1 |   508/455 (1.12) |   468/435 (1.08) |  556/670 (0.83) |  598/607 (0.99) |
|    10 |   524/499 (1.05) |   535/502 (1.07) |  569/636 (0.89) |  609/612 (1.00) |
|   100 |   520/776 (0.67) |   536/813 (0.66) |  540/672 (0.80) |  609/638 (0.95) |
|  1000 |  585/2932 (0.20) |  548/3653 (0.15) |  583/932 (0.63) |  655/893 (0.73) |
| 10000 | 505/24205 (0.02) | 449/33131 (0.01) | 512/5917 (0.09) | 597/5852 (0.10) |

**param-shared（`/items/:id/item-{i}`，共享 bucket，纯 trie）**

|  size |          hit-mid |         hit-last |     miss-global |       miss-deep |
| ----: | ---------------: | ---------------: | --------------: | --------------: |
|     1 |   637/485 (1.31) |   573/442 (1.30) |  540/661 (0.82) |  592/609 (0.97) |
|    10 |   614/468 (1.31) |   623/500 (1.25) |  564/634 (0.89) |  605/633 (0.96) |
|   100 |   643/591 (1.09) |   623/628 (0.99) |  603/659 (0.92) |  616/629 (0.98) |
|  1000 |  697/1887 (0.37) |  657/2172 (0.30) |  572/791 (0.72) |  622/768 (0.81) |
| 10000 | 682/11696 (0.06) | 587/16296 (0.04) | 508/2087 (0.24) | 590/2106 (0.28) |

Hono 的有序分支正则在参数路由上呈线性扫描：1000 条命中慢 3–7 倍，10000 条
慢 **17–74 倍**（hit-last 33µs vs keala 449ns），miss 也慢 4–11 倍。keala 全
规模平坦（449–697ns），与 trie 每段 O(1) 的主张一致。唯一 Hono 领先的区间：
**param-shared N ≤ 10 的小表**，keala 慢 25–31%（约 130–150ns，trie 走段 +
参数解码 vs 单条编译正则），且 N=100 已回到平价。首轮（r0）keala 部分格的
IQR 上界偏大属冷启动预热，轮间中位数不受影响。

### 7.2 构建（注册墙钟 / 首请求 / 堆增量）

| 表@10000       | regMs keala/hono | firstMs keala/hono | 到首请求合计 | heapMB keala/hono |
| -------------- | ---------------: | -----------------: | -----------: | ----------------: |
| static         |       13.0 / 2.9 |         0.6 / 13.2 |  13.6 / 16.1 |        12.1 / 3.9 |
| param-distinct |       17.9 / 2.3 |         0.7 / 63.5 |  18.6 / 65.8 |        17.3 / 3.9 |
| param-shared   |       15.4 / 2.7 |         0.7 / 35.1 |  16.1 / 37.8 |        13.5 / 4.0 |

keala 注册是 eager 的（每路由 1.3–1.7µs，线性，无超线性迹象），Hono 注册便宜
但把正则编译推迟到首请求（10k 参数表 36–65ms）。**到首请求的总成本 keala 更
低**。堆增量 keala 为 Hono 的 3.1–4.4 倍（每路由保留组合后的链），低于 §5 出口
C 的 5 倍门槛，登记为观察项。

### 7.3 JSON 公平对拍（4 轮旋转，ns/req 中位数）

| 行                                                         | keala |              Hono | 结论                                                     |
| ---------------------------------------------------------- | ----: | ----------------: | -------------------------------------------------------- |
| 裸 `c.req.json()`（非等价参考）                            |   n/a | 1163（R4.1 基线） | Hono 无预算，仅参考                                      |
| Hono 官方 `bodyLimit` 中间件（生产典型）                   |  1393 |              1540 | **keala 快 9.5%**，且谎报 CL 下 keala 413、Hono 放行 200 |
| 严格字节安全等语义（Hono `bytes()` + byteLength + decode） |  1452 |              1131 | keala 慢 28.4%，归因见下                                 |

计时外行为核验：声明超限 → 双方 413；谎报 Content-Length（声明 25 实发 2048）
→ keala 413、Hono 官方中间件 **200**（放行）、Hono 严格等语义 413；畸形 JSON
→ keala 400、Hono 默认 500 / 严格等语义 400。另用「JS 字符数 <1024、UTF-8
字节数 >1024」的中文 JSON 锁定字节预算：keala 与严格 Hono 均为 413。

keala 的 `body-limited` 与 `body-safe` 接线相同，因为预算路径本身就是谎报安全的：
声明 CL ≤ 限时一次原生 `bytes()` 读取后仍复核实际字节数。严格对照的 28.4% 差距
归因于 plugin 装饰、facade 构建、memoization 与结构化错误信封（`createBodyParser` +
`readBodyLimited` + `createError`），**不是**字节预算执行本身——两侧预算执行
同形（各一次原生字节读取 + 一次 byteLength 比较 + decode/parse）。

### 7.4 审计修正 R4.2-B1

首次核销的 Hono 严格 comparator 错用 `text.length` 作为预算；ASCII 样本掩盖了 UTF-8
多字节低估。复核时先加入中文超限断言，再改为 `raw.bytes()` + `byteLength` +
`TextDecoder`（两侧均复用 decoder），按四轮 K-H/H-K/H-K/K-H fresh process 重测得到
1452/1131ns。Router
矩阵与生产代码不受影响；旧 1117ns/24.7% 数字作废。

修正后门禁：fmt、typecheck、build、Node/Bun 全量、coverage、真实 Bun HTTP smoke、
example、24 轮 soak 全过；lint 0 error 且只有仓库既有 warning。覆盖率保持
statements/branches/functions/lines `97.15/91.89/96.03/98.53%`；Tillgate 未加载、未
修改，工作树保持 clean。

## 8. 裁决记录

按 §5 预注册标准裁定：

1. **Router：出口 A——不重写。** 所有 N ≥ 1000 的格 keala 快或 IQR 重叠
   （最差 static hit-mid 1.10x 且 IQR 重叠；参数路由 0.01–0.38x 大幅领先）。
   「编译期 regexp dispatcher / ExecutionPlan 路由部分」**不立项**：数据反向
   支持现有 staticMap + bucket + trie 混合——Hono 的正则方案恰在参数路由
   规模化时崩溃。出口 C 未触发（注册线性、到首请求更快、堆 4.4x < 5x）。
2. **小表 param-shared 缺口（N ≤ 10 慢 ~130–170ns）记录在案**，不满足预注册
   门槛（仅 N ≥ 1000 裁决）；如未来真实负载画像显示小共享桶表是主流，再按新
   证据立独立小单元。
3. **JSON：body 加速（重写类）不立项。** 生产典型配置（官方 bodyLimit）下
   keala 快 ~10% 且语义严格更强（谎报防护）；对最小严格等语义 handler 慢
   28.4%，但归因是 facade/plugin 成本而非流式预算（预注册的归因条件不满足）。
   登记可选小单元候选「JSON facade 瘦身」（目标：strict 行差距 <8%），优先级
   排在 R4.3 / R4.4 之后，由届时 profile 决定是否开工。
4. **默认下一步：R4.3 错误响应策略**（新迁移文档先行）。
5. 预算转移：R4.2 未消耗实现预算（零生产代码改动），R4.3/R4.4 按原路线推进。
