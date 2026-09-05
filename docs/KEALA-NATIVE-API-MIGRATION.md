# keala 原生 API 迁移（去 Koa 形态）— 方案文档

> 状态：**草稿 v2（审查修订版）** — 已吸收两位对抗审查者共 30 条发现（v1 被判不可定稿）；
> 用户 review 通过后转「定稿」
> 方法论：repo-migration-e2e-v2（方案先行 → 审计 → 裁决 → 分单元实施 → 收口核销）
> 分支策略：当前分支（0.6.2）直接开发；**一个迁移单元 = 完整实现 + 单元门全绿 = 一个 commit**；
> 禁止 TODO/挂账给"下一版本"；**零兼容层**（裁决 6）。
> 受影响面实录：**附录 [KEALA-NATIVE-API-MIGRATION-APPENDIX.md](./KEALA-NATIVE-API-MIGRATION-APPENDIX.md)**
> （grep 生成，每节附确切命令：params 宽口径 35 文件、setter 106 文件、双命中 24 文件、src 内部使用者、bench/scripts 消费方 18 文件含 params?.[ 形态）

---

## 第一部分：DESIGN（设计基线）

### 1. 背景与动机

实测定论（docs/SHOOTOUT-LINUX-SERVER-DIAGNOSIS.md）：keala 管线机器比 hono 快
（静态 +18-28%），HTTP 层被平台地板稀释为平局。剩余每请求结构税主要来自
「Koa 形态兼容」承诺（params null-proto Record 构造 ~30ns）；`c.body=`/`c.status=`
setter 家族拖着 staged-commit 状态机的主要复杂度。

**定位变更**：「Koa's ergonomics at Hono's speed」→「keala 自己的 API：洋葱模型 +
零依赖 + Bun 原生能力」。Koa 对齐不再是契约（bench 性能对照除外，裁决 7）。

### 2. 外部契约（新 API 形态）

#### 2.1 保留

- **洋葱模型** + 预编译链；request 侧全套（`c.raw/signal/method/url/path/query(name)/
queries(name)/header(field)/headers/host/protocol/secure/ip/origin/href/URL/accepts*/is*`）
- **staged headers**：`c.setHeader(field, value | Record)/c.append/c.remove/c.has/c.resHeader`
- **sugar**：`c.text(body, status?, headers?)/c.json(...)/c.html(...)` ——响应确定的
  唯一形态之一（`return Response` 为另一形态）
- **错误通道**：`c.throw/c.assert` + 单槽 `onError` mapper【裁决 3】
- **只读 `c.status`**（返回式：`_res?.status`；合成答案 405/501/OPTIONS/404 在
  finalize 前写入观察槽——post-next 观察者 metrics/logger 依赖此语义，
  respond.ts:88-90 已有注释契约，保留）
- `c.state/c.cookies（含签名）/c.app/c.routePath/c.routeName/c.flags/c.params(name)`
- SSE/WS/native sink/pooling/lifecycle 全家

#### 2.2 变更（破坏性）

| 旧（Koa 形态）                                       | 新（keala 形态）                                 | 说明                                                                                            |
| ---------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `c.params["id"]`                                     | `c.params("id")`                                 | 【裁决 1】函数式；router 产物直达，零构造                                                       |
| `c.body = x`                                         | `return Response` / `return c.text/json/html(x)` | 【裁决 2】                                                                                      |
| `c.status = 201`                                     | sugar 第二参 / `new Response(..., { status })`   | 写路径删除；**读路径保留**（§2.1）                                                              |
| `c.type = t`                                         | `c.setHeader("Content-Type", t)`                 | **有损映射**：MIME 展开/charset 不再自动——裸头契约，调用者传完整值；其语义锁测试归 U3c 删除矩阵 |
| `c.length = n`                                       | `c.setHeader("Content-Length", String(n))`       | 同上                                                                                            |
| `c.etag = v`                                         | `c.setHeader("ETag", \`"${v}"\`)`                | **有损**：引号包裹不再自动                                                                      |
| `c.lastModified = d`                                 | `c.setHeader("Last-Modified", d.toUTCString())`  | **有损**：Date→字符串转换不再自动                                                               |
| `c.attachment(n)`                                    | `c.setHeader("Content-Disposition", ...)`        | **有损**：RFC5987 编码/basename 不再自动                                                        |
| `c.redirect(url)`（void staged）                     | `return c.redirect(url)` → `Response`            | 开 redirect 校验不变                                                                            |
| `c.body`（读）/`c.type`（读）/`c.etag`（读）/`c.res` | 删除                                             | staged 状态不存在；查头用 `c.resHeader()`；查状态用 `c.status`（读）                            |

#### 2.3 响应最终化语义（保留的正确性行为——**以代码现行为准**，v1 曾写反）

1. **staged headers 按名覆盖**：对返回的 Response，staged 记录按
   `headers.delete(key); headers.set(key, value)` 覆盖同名头（respond.ts
   `applyStagedHeaders`），set-cookie 走拼接；**if-absent 仅存在于错误 takeover
   路径**（error-response.ts `applyAbsentHeaders`）。同名冲突
   （`c.setHeader("X","1")` + 返回自带头 `X:"2"` → **X:"1"**）需新增锁定测试。
2. **无 body 状态清洗**：204/304 等**空状态答案在最终化时无条件清洗**
   body 与内容描述头（不论 body 是否为 null）——比现行 committed 路径
   （body===null 时不清洗，靠状态模式 setter 副作用兜底）更严，属收紧，
   新增锁定测试（防止 etag 304 重建把原 200 的 content-type/length 带上线）。
3. **HEAD 裁剪**：最终化剥离 body。
   【明示的有意变更】返回式 `new Response(...)` 的 HEAD 答案不再从 would-be
   body 回填 Content-Length（仅 sugar 路径保留）——合法但需锁定测试。
4. **void 终端 handler 语义**（v1 未定义，现补）：`untouched → notFound(404)`，
   staged headers 照常合并到 404 答案（respond.ts:410-414 现行为）。要作答的
   中间件/handler 必须 `return` Response。`app.notFound` 只接受返回 Response 形态。
5. **etag/compress 重写为 post-next Response 变换**：`await next()` 后若链上
   已有提交 Response，clone → 协商/gzip → **替换为新 Response**（last-committer
   -wins）；304 协商短路语义保留。**变换资格门槛**：仅对快照身份的有限 body
   （复用 `directBodyResponseValue === _res` 身份判定，cache.ts:229 同款机制）；
   ReadableStream/SSE/native PlannedResponse 一律 pass-through——流式 clone 后
   `.text()` 会挂起或无限缓冲。304 重建显式删除内容描述头。重建成本计入 P4
   预算（范围限合格 body）。

#### 2.4 删除

- `test/parity/koa.test.ts`、`koa-fuzz-locks.test.ts`、`.deps.d.ts`【裁决 4】
- `security/parity-locks.test.ts` 三类拆分：koa 对齐断言（删）；keala 自身安全
  断言（迁 baseline-extended）；**已删 setter 语义断言**（etag 引号/attachment
  编码等——归 **U3c** 删除矩阵，非 U1，避免"U1 保下 U3 再删"的自相矛盾）
- 其余文件中的 koa-parity describe（附录 M8 清单：concurrency:191 等）逐条甄别

#### 2.5 零兼容层（【裁决 6】，违反 = 返工）

无过渡别名（不留 getter 垫片/@deprecated 双签名/types 旧 overload）；无双轨分支
（respond/finalize 被删 API 路径物理删除，etag/compress 不做"双模式"兼容）；
无迁移开关；收口 grep 举证：src/ 中 `c.body =`、`.params[`、`c.status =`（写）均 0 命中。

### 3. 内部问题域

- **处理**：params 惰性直达（含 trie.ts 第三构造点、sink 镜像边界）、响应 setter
  家族删除、commit 状态机瘦身、`src/middleware` 层改写（cors/auth/metrics/logger
  → return 形态；etag/compress → post-next 变换）、error-response 内部构建改造、
  registration/group 的 redirect 上抛、koa 对齐测试退役、定位文档重写、
  bench/examples/scripts 消费方同步。
- **明确不处理**（归属）：`c.throw` 形态（独立提案）；转义路径 trie 分流（安全行为）；
  native sink 的**公开签名** `SunkHandler(request, params: Record)`（镜像边界
  重建 Record——慢路径，不进 router 预算【设计决策】）；docs/*.md 历史评审文档。

### 4. 性能预算（违反 = 缺陷；命令与基线绑定）

| #   | 预算                                                                                                                                                                            | 测量命令                                                          | 基线（2026-09-05/06 本机与服务器实测）      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------- |
| P1  | router 隔离非通配形状：现状 ≤1.16x（实测 0.90-1.16x）→ **U2 后目标 ≤1.15x**；通配：现状 1.26-1.29x → **目标 ≤1.25x**（残留差为 `(.*)` 捕获语义，非 params 构造驱动；U2 后复测） | `bun bench/route-shootout/diag/router-micro.ts`                   | 本轮实测（v2 §1）                           |
| P2  | 管线+适配层（新鲜请求环）不回退 ±3%                                                                                                                                             | `bun bench/route-shootout/diag/{pipeline-fresh,adapter-fresh}.ts` | 本轮 Mac 实测值（adapter-fresh 0.91-0.97x） |
| P3  | HTTP 七场景中位 ≥0.98x                                                                                                                                                          | 服务器干净窗口 `node bench/route-shootout/run.mjs`                | 991b5db 报告（中位 ≈1.0）                   |
| P4  | 热路径不新增每请求分配（含 etag/compress 重写）                                                                                                                                 | adapter-fresh 前后对比 + 代码审查                                 | 同 P2                                       |
| P5  | U2 动态形状净省 ≥25ns（params 构造消除）                                                                                                                                        | router-micro 前后差值                                             | 预期：trie/mixed 1.09-1.11x → ≤1.05x        |

### 5. 裁决落档汇总

| #   | 裁决                                                                                     | 出处                               |
| --- | ---------------------------------------------------------------------------------------- | ---------------------------------- |
| 1   | params 函数式 `c.params("id")`                                                           | 用户（AskUserQuestion 2026-09-06） |
| 2   | 响应 setter 家族全删；redirect 返回 Response                                             | 用户（同上）                       |
| 3   | `c.throw/c.assert` 保留                                                                  | 用户（同上）                       |
| 4   | parity/koa 测试直接删除；安全/bug 测试坚守                                               | 用户（会话指示）                   |
| 5   | 当前分支；单元完整落地即 commit；禁 TODO                                                 | 用户（会话指示）                   |
| 6   | 零兼容层                                                                                 | 用户（会话指示 2026-09-06）        |
| 7   | **bench 保留 koa 对照选手**（依赖不清、run.mjs 矩阵不动）；PARITY.md 标注"仅 bench 参照" | 用户（AskUserQuestion 2026-09-06） |

---

## 第二部分：IMPLEMENTATION（施工图）

### 1. 审计结论（v2 修正，证据=附录 M）

- **A1**（API 面）：response.ts 13 成员中 8 个 Koa 家族（getter+setter 成对删除，
  `c.status` 读除外）；sugar 3 个带 status/headers 参数。
- **A2**（params 构造点 ×3，v1 漏 1）：match.ts fastMatch（:51,:61）、
  bucket-regex.ts matchTableRegex（:203）、**trie.ts recordOf（:229-240）**；
  `RouteMatch.params` 类型在 router.ts:445；`EMPTY_PARAMS` 流经
  dispatch.ts:320、**sink.ts:46,420（SunkHandler 第二参直传）**、
  context.ts:128、pool.ts。**"路由核心不动"结论作废**。
- **A3**（commit 机器）：三保留语义（§2.3）在 committed 路径有独立实现
  （applyStagedHeaders / sanitizeEmptyStatus / stripBody），与 setter 状态机
  可分离；**v1 的 merge 描述写反**，以 §2.3 修正版为准。
- **A4**（测试面，v1 差一个数量级，v2 以附录 M 为准）：params（宽口径，含 match 产物消费）35 文件/123 处；
  setter 106 文件/651 处；getter 读 ~699 处；redirect 22 文件/60 处；
  双命中 24 文件。**perf/property/security/parity-hono 均在面上**（v1 全漏）。
- **A5**（src 内部使用者，v1 整层缺失）：middleware/{etag(304/null),cors(403/204),
  metrics(registry.text),auth(401×3)}；**core/error-response.ts:389-393（错误
  漏斗自身用 setter 构建 5xx 页）**；registration.ts:82 + group.ts:184（redirect
  void）；读侧：headers.ts:107（logger）、metrics.ts:125；index.ts:20 头注释。
- **A6**（外围）：bench 33 处 params；examples 2 文件 setter；*_scripts/smoke.ts
  :38-61,174-175、soak.ts、drain-server_ 用旧 API（CI 步骤，tsconfig 含 bench）**。

### 2. 逐模块裁决表（v2 补全）

| 模块                                                                 | 裁决         | 单元                                                                                                            | 动作                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| src/core/context/response.ts                                         | 重构         | U3a/U3c                                                                                                         | redirect→Response；删 8 setter+对应 getter；保留 setHeader 家族/sugar/`c.status` 读                                                                                                                                                          |
| src/core/context/request.ts                                          | 复制+微修    | U2                                                                                                              | params 函数化（惰性读路由产物）                                                                                                                                                                                                              |
| src/core/context/context.ts                                          | 复制+微修    | U2                                                                                                              | params 挂载/错误消息文案提及新形态                                                                                                                                                                                                           |
| src/core/context/pool.ts                                             | 复制+微修    | U3c                                                                                                             | deadProtoFor 守卫清单删 6 个已亡成员；stall 警告空形态定义                                                                                                                                                                                   |
| src/router/{match,bucket-regex,trie}.ts                              | 重构（同构） | U2                                                                                                              | 产物 Record→{target, values, names}（三处构造点全改）                                                                                                                                                                                        |
| src/router/router.ts                                                 | 复制+微修    | U2                                                                                                              | RouteMatch.params 类型改；EMPTY_PARAMS 保留（sink 边界用）                                                                                                                                                                                   |
| src/core/dispatch.ts                                                 | 复制+微修    | U2/U3c                                                                                                          | params 接线；setter 分支删除                                                                                                                                                                                                                 |
| src/core/sink.ts                                                     | 复制+微修    | U2                                                                                                              | **镜像边界重建 Record**（公开签名不动，慢路径）                                                                                                                                                                                              |
| src/core/{respond,error-response}.ts                                 | 重构         | U3c                                                                                                             | setter 分支物理删除；错误页构建改直接 Response；三保留语义不动                                                                                                                                                                               |
| src/core/registration.ts / src/router/group.ts                       | 复制+微修    | U3a                                                                                                             | `c.redirect(...)` → `return c.redirect(...)`（buildURL 消费 params 随 U2）                                                                                                                                                                   |
| src/middleware/{cors,auth,metrics}.ts                                | 重构         | U3b                                                                                                             | void+staged → return 形态；**401/403 必须用 `return c.text(statusMessage(status), status, headers)`**（与现行状态文本回退 body 字节等价——`new Response(null)` 空 body 会打破 auth.test:44 锁）；204 短路用 `new Response(null,{status:204})` |
| src/middleware/headers.ts                                            | 复制+微修    | U3b                                                                                                             | **无 return 化改动**（:107 是只读 logger）；仅依赖 `c.status` 读保留                                                                                                                                                                         |
| src/middleware/etag.ts（含 compress）                                | 重写         | U3c                                                                                                             | post-next Response 变换（clone→协商/gzip→替换）；304 短路保留                                                                                                                                                                                |
| src/index.ts 头注释                                                  | 复制+微修    | U4                                                                                                              | 示例去 setter                                                                                                                                                                                                                                |
| test/（附录 M 全集）                                                 | 改写/删除    | 各单元                                                                                                          | 见 MIGRATION 矩阵                                                                                                                                                                                                                            |
| docs/KEALA-NATIVE-API.md（987 行）                                   | 重写 API 节  | U4                                                                                                              | 5 处 setter 示例、6 处 redirect、§236 notFound 契约                                                                                                                                                                                          |
| docs/PARITY.md                                                       | 标注         | U1                                                                                                              | 「仅 bench 性能对照用途，非 API 契约」【裁决 7】                                                                                                                                                                                             |
| package.json                                                         | 复制+微修    | U4                                                                                                              | description 去 "Koa's ergonomics"、keywords 去 "koa"（依赖保留【裁决 7】）                                                                                                                                                                   |
| README.md / README.zh-CN.md / test/integration/docs-examples.test.ts | 重写定位段   | U4                                                                                                              | 与真实 API 一致性校验同步                                                                                                                                                                                                                    |
| bench/（params 33 处）/ examples / scripts/{smoke,soak,drain-*}      | 机械同步     | **随所属单元**（U2 改 params；U3c 改 setter——tsconfig 含 bench、CI 跑 smoke/example-check，不同步则单元门必红） |                                                                                                                                                                                                                                              |

### 3. 测试计划

- 矩阵实体=**附录 M**（grep 实录）+ 各单元实施记录逐文件核销；双命中 23 文件
  （M7）在 U2 与 U3 各过一遍，矩阵有标记列；
- 删除仅三类：koa 对齐契约（裁决 4）/ 已删 API 的 setter 语义（裁决 2，归 U3c）/
  /parity-locks 第三类（§2.4）；其余一律改写；
- 新增锁定：同名头覆盖（§2.3-1）、HEAD 不回填 CL（§2.3-3 明示变更）、void→404
  合并（§2.3-4）、etag 304 短路新形态（§2.3-5）、`c.params()` 全形状（缺失/可选/
  通配/多参/`"toString"` 返回 undefined）；
- 回归落点 test/（router-matching-locks 扩展等），**不落 bench**；
- 覆盖率 90/90/90/90：每单元 vitest run --coverage 前后对比，缺口补齐禁调阈值；
  U1 删除 koa 双跑对比用例的覆盖损失需数字核销（parity/koa* 42 用例真实驱动 src）；
- 500 行文件不变量（oxlint max-lines）：改写会膨胀的文件标注行数预算。

### 4. 实施顺序（v2 重划：U3 拆三个可独立全绿的子单元，删 v1 拆 commit 逃生口）

| 单元                              | 内容                                                                                                                      | 依赖                                 | 规模（附录 M）     |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------ |
| **U1** koa 对齐退役               | parity/koa* 删除；parity-locks 二类拆分；M8 koa-parity describes 甄别；PARITY.md 标注；.parity/ koa 语料归档说明          | 无                                   | 42+10 用例处置     |
| **U2** params 函数化              | 三构造点+sink 边界+registration/group buildURL；M1 34 文件+bench 33 处机械替换                                            | U1                                   | 中                 |
| **U3a** redirect 返回化           | response.ts redirect、registration/group 上抛；M4 22 文件                                                                 | U2                                   | 小                 |
| **U3b** middleware 先行 return 化 | cors/auth/metrics/logger（setter 仍在即可改，缩小 U3c 面）                                                                | 无强依赖（排在 U2 后避免双命中二改） | 小                 |
| **U3c** setter 删除+commit 瘦身   | 8 setter/对应 getter 删除；respond/error-response/pool；**etag/compress post-next 重写**；M2/M3 剩余文件+examples/scripts | U3a/U3b                              | 大（最后的大单元） |
| **U4** 定位收口                   | README×2、KEALA-NATIVE-API.md、package.json、index.ts、CHANGELOG、shootout 复测（P3）                                     | 全部                                 | 中                 |

**单元门**（与 CI 对齐，v1 四门不完整）：oxfmt --check / oxlint / tsc --noEmit /
vitest run --coverage（90 阈值）/ build / `bun --bun x vitest run` /
bun scripts/smoke.ts / bun scripts/example-check.ts（受影响时）。
每单元另过**对抗审查**（独立子 agent，对照本单元行为规格基线找偏差）后 commit；
提交信息引用本文档节号。

---

## 第三部分：MIGRATION（按单元；状态：**U1、U2、U3a、U3b 已实施（2026-09-06）**，U3c-U4 待实施）

### U1 — koa 对齐测试退役（流程试运行单元）

**行为规格基线**：无行为等价要求（纯退役）。
**动作**：删 parity/koa*（3 文件）；parity-locks 拆两类（koa 一致→删；安全行为→
迁 security/baseline-extended，行数预算：415+~60 行须拆分文件防超 500）；
M8 清单（concurrency:191 等）逐 describe 甄别处置；**auth.test:44 的
koa-parity 断言是 U3b 行为等价锚点——标注保至 U3b 落地后再处置**；PARITY.md 头部加「仅 bench
性能对照」标注；.parity/koa、koa.tar.gz 移入 bench 参照说明。
**矩阵**：附录 M8（实施时生成）+ parity-locks 10 用例逐条。
**验收**：单元门全绿（含 coverage 与基线逐项对比——删 42 用例的覆盖缺口数字
核销，必要时补 keala 侧断言）；被删用例与矩阵一一对应。

**实施记录（2026-09-06，commit 见 git log "U1"）**：

- 删除 parity/koa.test.ts（17 用例）+ koa-fuzz-locks.test.ts（16 用例）+
  agent-r6-diff-koa.deps.d.ts（negotiator 声明移至其唯一消费者旁的
  test/integration/regression-sweep.deps.d.ts）。**数学核销：2658−33 删
  +8 回迁新增=2634 ✓**（全量复跑 160 文件全绿）。
- 比方案更深一层的发现：两个差分文件中的 RED 行是**已修复 bug 的回归锁**。
  验证子代理对 22 项行为逐一 grep 判定锁存在性：13 项在存活文件已有等价锁；
  **9 项为唯一锁，已回迁 keala 原生断言**（明细见附录 M8 回迁清单——
  `typeIs("*/*")`、redirect 转义四子句+安全字符集、contentDisposition ASCII
  fallback、`.bin`→octet-stream（expandContentType 层，U3c 后存活）、
  escapeHtml 透传、外域中和精确形态、parseCookies 裸 token、Allow 顺序
  无关性）。
- parity-locks.test.ts 三类拆分（167→91 行）：错误类 4 条→error-disclosure
  （404→460 行）；redirect 1 条→baseline-extended（415→426）；c.URL 1 条→
  request-ergonomics；**setter 语义 4 条留存原文件，文件头注明 U3c 随 setter
  整体删除、禁新增**。
- M8 甄别（12 点位 + 甄别时补获 errors-surface:102 漏网点）：全部为 keala
  行为锁，无一删除；"(koa parity)" 措辞降级为历史出处。auth.test.ts:44
  标注 U3b 字节等价锚点。
- PARITY.md 头部加状态注记（koa 仅 bench 对照、.parity/koa 归档、hono 仍为
  活参照）；官方套件矩阵节标注为历史记录。
- Coverage 核销（对抗审查后终态复跑）：语句/分支/函数/行与基线**四项逐项
  相等**（5494/3838/824/4859——差分驱动的语句与分支全部被存活测试+回迁
  断言覆盖）。
- 对抗审查（4 条 CONFIRMED，全部修复）：①`.html`/shorthand 扩展的 charset
  **值锁**实为自引用差分（surface-regressions 的两侧同时退化依然绿）——
  utils.test 补 `expandContentType(".html")==="text/html; charset=utf-8"`
  值断言；②"(koa contract)" 措辞 7 处残留（初版 grep 面漏变体）——全部
  降级，测试不动；③附录 M2/M3/M4 以命令同源重生成（parity-locks 曾被误
  移出 U3c 核销矩阵；attachment 8→7）；④本节数字以终态树复跑为准修正。
- 顺手修复：oxfmt 存量违规（CHANGELOG 中文裸星号会被 formatter 损坏为
  `agent-r46-_`——人工改写为反引号前缀等义表达；run.mjs 纯换行），单独
  commit，否则任何 push 的 CI 都会挂。
- 遗留（非 U1）：本机 Bun 1.4.2 下 3 个**存量**测试失败（HEAD stash 复跑
  证实与 U1 无关）——带体 204 现被正确消毒为干净 204（恰是 §2.3-2 语义）、
  `Response.redirect` 在 Bun 不再不可变、pooling+sugar 的 content-type——
  均为 Bun 上游行为漂移，待独立提交修复测试期待值。

### U2 — params 函数式化

**行为规格基线**（等价判定，改写后必须全绿）：
unit/router-matching-locks（36 用例）、unit/router-trie{,-fuzz}、
unit/router-registration-locks、unit/router-mount-regressions、unit/matcher-fuzz、
unit/router-shadow-warn、unit/request-ergonomics（"params never null"→
"c.params(name) 缺失返回 undefined"）、unit/request。
**行为映射**：`c.params["id"]`→`c.params("id")`；Record 可枚举性不再提供
（受影响用例矩阵列名改写）；null-proto 断言不再适用；fastMatch/matchTableRegex/
**recordOf 三点**产物→{target, values, names}；**sink 镜像边界重建 Record**
（SunkHandler 签名不动，native-sink 测试零改写——验证点）；pooling 对 params
的重置语义移除（无对象）。
**矩阵**：M1 35 文件（宽口径）+ M7 双命中标记 + M6 外围 18 文件（bench/examples/scripts，含 `params?.[` 形态——smoke/soak/drain/router-scale 全在，U2 单元门加跑 scripts/smoke）。
**验收**：单元门（+smoke/soak 因 scripts 同步而加跑）；P1/P5 性能预算；`grep -rE '\.params(\?\.)?\[' src/ bench/ examples/ scripts/` = 0。

**实施记录（2026-09-06）**：

- **产物形态**：`RouteMatch = {target, names, values, offset}`。三构造点：fastMatch
  （多参零拷贝复用 split 数组、单参 `[value]`）；matchTableRegex（**零拷贝**——
  exec 数组即 values，`offset` 携带 per-route groupStart）；trie（terminal 注册期
  预挂 `matchNames`——trie 是树、每非根节点唯一入边，terminal 名字链注册期固定；
  命中时 values 定长倒填、names 零分配、无需去重，重复名靠读取端 lastIndexOf
  取最新）。staticMatch 带冻结空数组 + offset 0。
- **Context**：`paramNames/paramValues/paramOffset` 三状态槽（pooling 重置随
  `Object.keys(CONTEXT_DEFAULTS)` 自动覆盖）；`c.params(name)` 方法 =
  `lastIndexOf + values[i+offset]`——数组无原型链，`"toString"`/`"__proto__"`
  天然 miss（新锁：request-ergonomics 三条——未匹配 undefined、原型名 miss、
  重复名取最新）。
- **性能（P1/P5 终测，同窗口 A/B vs pre-U2）**：4-seg 0.92x→**0.81x**、mixed
  1.10x→**1.04x**、param-only 1.27x→**1.15x**、通配 1.25x→**1.17x**、bucket
  1.17x→**1.07x**；绝对值净省 3-7ns/形状。P2 适配层 0.91-0.96x（全形状优于
  hono）。**P5 的"净省 ≥25ns"预估不成立**——null-proto Record 实值 ~5ns 而非
  诊断时估的 ~30ns，ratio 目标（非通配 ≤1.15x、通配 ≤1.25x、mixed ≤1.05x）
  全部达成，记录以实测定案。
- **过程中的两个陷阱（实施记录留档）**：①`result.slice(groupStart, …)` 对
  RegExp exec 结果数组走 generic 慢路径，实测 ~15ns/次、一度使全部动态形状
  回退 +8-13ns（CPU profile 定位：slice 占 38.4% 自耗时）——零拷贝 offset 设计
  消除后反超基线；②`buildURL(destSegments, c.params)` 传裸方法引用丢失
  `this`（redirect 全 500）——调用点改箭头包装（冷路径）。
- **测试面**：M1 35 文件 bracket 形态 + 28 处点形态（原 grep 盲区）+ 6 处展开
  形态 + 1 处 `Object.keys(c.params)` 假绿（函数使 keys 恒空、tsc 静默放行——
  改槽位断言）；产物消费 6 文件走 `paramsRecord(names, values, offset)`（序无关
  Record 比较，差分测试语义不变；另 3 个文件是槽位断言消费者）；`{...c.params}` 展开改 paramsRecord；§8 公共
  面快照 + pooling 槽断言 + own-key 顺序栅栏同步。数学：2634+2（锁扩展）
  = **2636**，Node/Bun 双全量绿。
- **外围**：bench 11 + examples 2 + scripts 6（drain-server-node.mjs 与
  artifact-server.mjs 两个 `.mjs` 先后漏扫——后者 `c.params?.id` 形态逃过
  全部收口 grep 家族且使 process-check 当场红，由对抗审查抓获）；
  smoke/example-check/soak 全过；sink 镜像边界 paramsRecord 重建（SunkHandler
  签名不动；native-sink-parity 断言零改写、仅 2 行调用形态机械替换——
  方案验证点达成）；buildURL 双形态
  （Record | lookup），`app.url()` 公开签名不变。
- **对抗审查（3 条 CONFIRMED，全部修复）**：①trie 中途通配入口空捕获时链比
  matchNames 短 1，定长倒填把邻位值归因给错误名字（`/w/:x?/*` + `/w/a//`
  → x 消失、wildcard 拿 x 的值——U2 引入的真回归）→ matchAt 链长校验回退
  链走构建 + `//` 路径四行值锁；②三层注册期共享的 names 数组未冻结，handler
  一次原地写永久腐蚀路由 → 三处 Object.freeze（读取零成本）；
  ③artifact-server.mjs `c.params?.id` 漏改（process-check 红）→ 修复，
  收口 grep 家族增补 `\.params\?\.` 变体。NOTE 项同批修复：`__proto__`
  探测锁改 null-proto 逐键断言、R3-4 过时分歧注释改统一语义描述。

### U3a — redirect 返回化

**基线**：unit/router-registration-locks（redirect 30x 语义）、unit/response
（redirect 部分）、开 redirect 防护锁（security/）。
**动作**：`c.redirect` 返回 Response；registration.ts:82/group.ts:184 上抛
return；M4 22 文件机械替换（void 调用→return）。
**验收**：单元门；`c.redirect` void 用法 0 残留。

**实施记录（2026-09-06）**：

- `c.redirect(url, code?)` → **纯构造器**返回 `Response(null, {status, location})`：
  校验（3xx 整数 TypeError）、绝对 URL 归一化、外域中和、encodeUrlValue 全部原样
  保留；默认码规则保留（显式码 > 已 staged 的 3xx > 302，读 `statusValue`）。
  不再 mutate context、不再 throw-on-commit——旧 0.7 契约"提交后 redirect 抛错"
  随 staged 形态一并退役（三处行为锁改写：regression-sweep R6-C 拆成"构建不
  生效"+"return 即替换"两锁；response.test / app-regressions R5-3 同步）。
- registration.ts / group.ts 上抛 `return c.redirect(target, code)`；M4 19 文件
  机械替换（语句位 `c.redirect(...)` → `return c.redirect(...)`）。
- **机械替换的系统性副作用**：setup 型测试助手（respondWith/captureCtx/attack）
  吞掉 setup 内 return 的 Response → 404——三处助手改传导返回值（这是 U3b/U3c
  还会再遇的模式，已记入实施记录）。property rig 的 redirect staged/committed
  双 style 分支坍缩为单路径（语义同化）。
- 数学：2637→2640（+1 R6-C 拆两锁、+2 同名覆盖/Location 优先级锁）；Node/Bun 双全量绿；staged 头经
  §2.3-1 合并规则继续搭车（applyStagedHeaders 对返回 Response 的既有行为）。
- 验收 grep：语句位 void `c.redirect(` 0 残留（src/test/bench/examples/scripts）。
- 对抗审查（1 CONFIRMED，已修）：**同名 Location 优先级翻转未锁未记**——旧
  staged 形态 redirect 是 Location 最后写者；新返回形态受 §2.3-1 通用规则支配
  （先行 staged Location 反杀 redirect 目标）。补两锁（通用同名覆盖 +
  Location 专项，component-redteam），方法文档与文件头披露。审查另证实：
  21 个恶意目标双树逐字节一致（中和/CRLF/编码零丢失）、staged 3xx 默认码
  11 分支双树一致、机械替换零残留零错改、锁改写无弱化（R6-C 反而净增
  last-committer-wins 锁）。

### U3b — middleware 先行 return 化

**基线**：middleware/{cors,auth,csrf,headers} 现有用例（行为不变，仅实现形态变）。
**动作**：cors.ts:84,95,105 / auth.ts:84,134,139 / metrics.ts:157 /
headers.ts:107 改 return Response 形态（`c.status` 读保留支撑 logger/metrics）。
**验收**：单元门；行为字节等价（现有断言不改）。

**实施记录（2026-09-06）**：

- cors 403×2 → `c.text(statusMessage(403)||"403", 403)`；204 preflight →
  `new Response(null, {status:204})`（staged Allow-* 全家经 §2.3-1 通道搭车）；
  auth 401×3 → `c.text(statusMessage(401)||"401", 401, {"www-authenticate": ...})`；
  metrics page → `c.text(registry.text(), 200, {ct})`。headers.ts 零改动。
- **等价口径（对抗审查双层探针定案）**：body/status/statusText/全部非 CT 头
  在 Node+Bun 的 handle 与真实 socket wire 双层**逐字节等价**；Node 适配器
  wire 含 CT 完全逐字节等价。唯一偏移：Bun wire 的 CT 从 runtime 默认变为
  显式 `text/plain; charset=utf-8`（名字大小写+参数空格，D1 容差类，方向为
  跨 runtime 一致化改善）——方案"body 字节等价"口径成立。
- 204 staged 头搭车、reject() 自定义路径、metrics 的 c.status 观察槽
  （经 commit 槽读路径）全部两树一致。auth.test:44 锚点核销（断言原样保留）。
- 数学：2640 不变（行为等价单元，零测试改写除锚点注记）；双运行时 +
  tsc/lint/fmt/build/smoke/example-check 全绿。

### U3c — setter 删除 + commit 瘦身（对抗审查重点单元）

**基线**（§2.3 五条语义的既有锁，改写后必须全绿）：
integration/committed-headers（merge）、integration/response-matrix 等价改写、
HEAD/无 body 清洗锁、error-policy/takeover-* 全套、void→404 锁、
etag 304/gzip 新形态锁（重写）。
**动作**：删 8 setter+对应 getter（`c.status` 读保留）；respond/error-response/
dispatch/pool 瘦身；etag/compress post-next 重写；M2/M3 剩余文件改写；
examples/scripts 同步；parity-locks 第三类删除。
**验收**：单元门；§2.5 零兼容 grep 三项 0 命中；P2/P4 测量（adapter-fresh
前后对比）；同名头覆盖新锁。

### U4 — 定位收口

README×2 / KEALA-NATIVE-API.md / package.json / index.ts / docs-examples.test.ts /
CHANGELOG；服务器干净窗口 shootout 复测（P3）。
**验收**：全 CI 链本地复跑（含 soak/process-check）；核销清单逐项。

---

## 收口核销清单

- [ ] U1-U4 各自 commit + 单元门全绿 + 矩阵核销（附录 M 对照）
- [ ] 每单元对抗审查偏差清单清零
- [ ] 覆盖率 ≥90/90/90/90 逐单元对比核销（含 U1 删除损失的补齐证明）
- [ ] 性能预算 P1-P5 全过（命令+基线对账）
- [ ] 零兼容举证：src 中 `c.body =`、`c.status =`（写）、`.params[`/
      `.params?.[`、`c.redirect(` 调用形态 均 0 命中（注释与报错文案中的
      字样豁免两处已知位：context.ts:106 错误消息、types.ts:154 注释——
      grep 后人工核对这两处）；types 无旧签名
- [ ] 假绿抽查（独立确认）：无矩阵外删除/跳过、无断言弱化
- [ ] README×2 / KEALA-NATIVE-API.md / package.json / index.ts / PARITY.md 标注完成
- [ ] 全 CI 链绿；文档状态推进「已核销」；实施记录逐波追加（8+ 节预留）

## 实施记录（收口时逐波追加）

### 第 2 波 — U2（2026-09-06）

params 函数式化落地。核心设计裁决三条：①trie 是树 → terminal 名字链注册期固定
（matchNames 预挂，请求期零名字构造）；②RegExp exec 数组零拷贝直出 + offset
寻址（slice 一个 exec 结果走 generic 路径 ~15ns——本波最大陷阱，CPU profile
定位）；③buildURL 收 lookup 函数（redirect 零 Record 重建），但必须箭头包装
保 `this`。性能终测全形状反超 pre-U2 基线 3-7ns（P1/P2/P5 ratio 全达；P5 的
25ns 绝对值预估被实测证伪——null-proto Record 只值 ~5ns，如实记录）。
假绿抓获 1 处：`Object.keys(c.params)` 对函数恒空且 tsc 放行——机械替换的
形态面（bracket/点/展开/整体传参）之外永远还有变体，验收 grep 必须
多形态并列。

### 第 1 波 — U1（2026-09-06）

koa 对齐退役落地，流程试运行达成：方案 → 验证（锁存在性子代理 22 项逐一
核实）→ 实施（删 3 文件、三类拆分、9 项唯一锁回迁、13 点位措辞甄别）→
单元门 → 对抗审查（4 条 CONFIRMED：`.html` charset 值锁自引用差分漏网、
实施记录数字失真、"(koa contract)" 措辞 7 处残留、附录 M3 矩阵 parity-locks
被误移出——全部修复，审查者另抓出验证子代理判定"已有锁"中的 1 项实为
弱锁）→ commit。关键数字：2658−33 删+8 回迁=2634；coverage 四项与基线
逐项相等（5494/3838/824/4859）。
教训三条进流程：①差分测试文件不能盲删——RED 行是修复的回归锁，删前必须
逐行为锁存在性核验（本单元 9/33 用例因此救回）；②"已有等价锁"的判定要
防自引用差分（两侧同时退化依然绿——值断言才算锁）；③formatter 对中文
裸星号的损坏（`agent-r46-*`→`agent-r46-_`）说明格式化自动修复产物必须
过人工语义审阅后才能落盘。
