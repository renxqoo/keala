# HOTPATH-R4 — 企业级执行架构施工图

> 状态：R4.1–R4.3 已核销；R4.4 施工图已定稿、实施中
> 设计基线：[HOTPATH-R4-DESIGN.md](./HOTPATH-R4-DESIGN.md)
> 首个迁移单元：[HOTPATH-R4-MIGRATION-COMMIT-FAST-LANE.md](./HOTPATH-R4-MIGRATION-COMMIT-FAST-LANE.md)
> 当前迁移单元：[HOTPATH-R4-4-MIGRATION-CORE-HOTPATH.md](./HOTPATH-R4-4-MIGRATION-CORE-HOTPATH.md)

## 1. 旧实现审计结论

### 1.1 审计编号

| 编号 | 结论                                                                                      | 证据                                      | 裁决                                            |
| ---- | ----------------------------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------- |
| A1   | 返回式 Response 在 compose settle 时写入 `c._res`，外层 post-next 写发生在提交后          | `src/core/compose.ts`                     | 保留时序，不改 commit 点                        |
| A2   | 任意 staged header 或 flag 16 会进入 `rebuildCommitted`，复制全部 headers 并新建 Response | `src/core/respond.ts`                     | R4.1 的唯一性能修改点                           |
| A3   | `set/append/remove/vary` 同时承担校验、staging 与 committed 合并语义                      | `src/core/context/response.ts`            | 提取单一 header mutation 端口，避免两套校验漂移 |
| A4   | status/message/body 使用 32/64/128 标志精确区分提交前后写                                 | `response.ts`、`state.ts`                 | 保留，R4.1 不快化                               |
| A5   | cookies facade 直接持有 `headersRecord`，不经过 response API                              | `context.ts`                              | R4.1 留在 Semantic；后续另审计                  |
| A6   | finalizer 从不读取 committed body；HEAD/空状态通过新 Response 安全重建                    | `respond.ts` 与 runtime lock tests        | 不得破坏                                        |
| A7   | `app.onError` 是 emitter listener，返回 void；错误 response 由 dispatch 内部构造          | `application.ts`、`app.ts`、`dispatch.ts` | 公开名称冻结，响应策略延期                      |
| A8   | 静态路由 Map O(1)，简单单动态 pattern 有 bucket fast matcher，其余迭代 trie               | `router/router.ts`、`router/trie.ts`      | 无规模数据前不重写                              |
| A9   | listen 后可增量注册 route/ws/sink，middleware/param 会重编链                              | `app.ts`、`bun.ts`                        | 不夹带 freeze/compile API                       |
| A10  | Bun 是唯一引用 Bun global 的适配器；Node 共享 Fetch Response 核心                         | `adapters/bun.ts`、`adapters/node.ts`     | 可变性判断必须在 Fetch 核心中跨 runtime 工作    |

### 1.2 确认缺口

- **C1 — Headers guard 跨来源不一致**：Node 22 本地 Response 可变，但
  error/redirect/fetch Response 不可变；Bun 1.4 样本均可变。直接 mutation 必须有
  per-context 三态与 fallback。
- **C2 — fast/semantic 责任混在 accessor**：现有 accessor 只会 staging，finalizer 才
  决定 rebuild，无法表示“已等价应用，无需重建”。
- **C3 — cookie 绕过统一端口**：现在正确但不能直接纳入第一版 fast path；强行纳入会
  扩大 Set-Cookie 多值风险。
- **C4 — 错误 hook 名称冲突**：把 `onError` 改成 response mapper 会破坏已发布观察
  契约，是 API bug，不是优化。
- **C5 — router 最优性尚无证据**：已有算法渐近复杂度合理，但缺少与 Hono 在不同路由
  规模/失败命中分布下的 fresh-process 矩阵，不能宣称全局最优，也不能凭感觉重写。

### 1.3 重复与债务

- **D1**：header 校验/staging 位于 response API，committed merge 位于 respond；新增
  fast path 若复制规则会形成第三份。必须通过窄 helper 共享语义判定，不能复制实现。
- **D2**：flags 使用裸数字，跨 response/respond/dispatch。R4.1 若新增 capability，优先
  用命名常量或独立固定 slot，禁止继续散落 magic number。
- **D3**：`has()`/`resHeader()` 只观察 staged record，不观察 committed Response。这是
  既有契约，R4.1 不顺手修改；否则 post-next 可观察行为会改变。

## 2. 逐模块裁决表

| 旧文件                           | 裁决      | 审计状态 | R4.1 动作                                                          |
| -------------------------------- | --------- | -------- | ------------------------------------------------------------------ |
| `src/core/context/response.ts`   | 重构      | 已审     | 校验后调用 committed-header 端口；不能快化则沿用 staging           |
| `src/core/respond.ts`            | 重构      | 已审     | 保留唯一 Semantic rebuild；识别 fast 已完成状态，不复制 merge 规则 |
| `src/core/context/state.ts`      | 小改      | 已审     | 用两个命名 flags 表示三态 capability；不增加 context slot          |
| `src/core/context/context.ts`    | 小改      | 已审     | cookies facade 进入 staging；既有 flags reset 保证 pool 隔离       |
| `src/core/committed-headers.ts`  | 新建      | 已实施   | 单一职责：安全尝试普通 header 原地 set/delete/append               |
| `src/core/context/headers.ts`    | 新建      | 已实施   | 统一校验、Fast、观察镜像与 Semantic staging                        |
| `src/core/compose.ts`            | 微修      | 已实施   | 提交时序不变；新 Response 清理 capability/applied 位               |
| `src/core/dispatch.ts`           | 保留      | 已审     | 错误与 never-reject 契约不改                                       |
| `src/context/cookies.ts`         | 保留      | 已审     | R4.1 不快化 Set-Cookie                                             |
| `src/router/*`                   | 保留/测量 | 已审     | 只补 scale 研究基准，不在 R4.1 改算法                              |
| `src/adapters/bun.ts`            | 保留      | 已审     | 不引入运行时专用 header 分支                                       |
| `src/adapters/node.ts`           | 保留      | 已审     | 用真实 immutable Response 集成测试 fallback                        |
| `bench/compare-hono-hotpaths.ts` | 扩展      | 已审     | 增加 mutable/immutable、set/remove/vary 与正确性断言               |
| `test/*pipeline/runtime/prop*`   | 扩展      | 已审     | 表驱动与属性回归，复用现有装置                                     |
| `scripts/smoke.ts`               | 复用      | 已验证   | live Bun HTTP 锁 late header + text Content-Type                   |

## 3. 目标结构与依赖方向

```text
context/response.ts
  ├─ validate/normalize public operation
  ├─ committed-headers.ts  (窄、无 app/router 依赖)
  └─ staged record fallback

respond.ts
  ├─ untouched committed return
  ├─ semantic rebuild (唯一实现)
  └─ state-mode construction
```

`committed-headers.ts` 只能依赖 Fetch 标准类型和 context 的最小结构，不依赖 app、router、
adapter、cookies 或 body parser。它返回判别结果（applied / fallback），不返回新的
Response；异常 guard 只在内部转成 fallback，header 校验异常仍由公开 accessor 抛给用户。

## 4. 测试计划

### 4.1 先补红灯/锁定

1. 可变 committed Response：post-next `set/remove/vary` 结果与当前 rule-4 相同；
2. 不可变 Response：第一次尝试后 staging + rebuild，后续操作不重复探测；
3. direct set 后再 status/body rewrite：早先 header 必须随 Semantic rebuild 保留；
4. direct remove 后再 set，同名最后写获胜；
5. Set-Cookie、多值数组、Content-Type/Length、cookies facade 明确继续走 fallback；
6. HEAD、204/304、open/locked/disturbed stream、notFound/405/error 结果不变；
7. pooled context 的 mutable/immutable 状态不能串请求；
8. 属性测试随机组合 set/append/remove/vary/status/body，Fast on/off 结果逐字节等价。

### 4.2 分层门禁

- 单元：新 helper 的 applied/fallback、首次探测、无部分写入；
- 核心集成：compose + response API + finalizer 的 rule-4 矩阵；
- 双运行时：Node 真实 immutable fetch/redirect Response，Bun 本地与 live serve；
- 进程冒烟：`npm run smoke` 锁 status/body/content-type/late header；
- 回归：全量 Node、真 Bun、coverage、example；
- 消费方：Tillgate 只读测试，前后 `git status` 一致。

### 4.3 性能矩阵

| 组       | 场景                                   | 目的                       |
| -------- | -------------------------------------- | -------------------------- |
| 回归     | probe / body / bare text               | 确认非目标路径 ≤3% 回退    |
| 主目标   | correct dirty text set/remove/vary     | 证明 fast path ≥15% 改善   |
| fallback | immutable Response + late header       | 确认 ≤5% 回退、结果正确    |
| 复杂语义 | cookie / status / body / HEAD stream   | 证明仍走 Semantic 且无 bug |
| Hono     | 同 late header + 显式正确 Content-Type | 同语义比较，不使用错误输出 |

## 5. 实施顺序与提交边界

### Phase 0 — 方案定稿

- 用户确认默认裁决；三件文档从草稿/审计中推进到定稿。
- 验收：无实现代码；R3 基线提交可复现。

### Phase 1 — 行为锁与基准锁

- 只提交测试与 benchmark harness；记录 R3 数字和 immutable fixture。
- 验收：新增测试能区分“重建”与“原地应用”，但只断言公开结果；全量仍绿。

### Phase 2 — 最窄 set/remove Fast 通道

- 新 helper、三态 capability、context reset；只放行普通单值 set/remove。
- 验收：契约矩阵全绿，目标 ≥15%，非目标 ≤3%，独立提交可 revert。

### Phase 3 — append/vary 逐项放行

- 只有 Phase 2 证据达标才推进；每个操作先证明原子性和顺序等价。
- Set-Cookie/cookies 不自动进入该阶段。

### Phase 4 — 全门收口

- fmt、lint、typecheck、build、Node、Bun、coverage、smoke、example、soak；
- Tillgate 只读验证；fresh-process + live HTTP 前后报告；文档核销。

### Phase 5 — 后续方向重新裁决

- router scale 研究、错误响应策略、高可用生命周期各自新建迁移单元；R4.1 完成不代表
  自动开始。

## 6. 核销结果（2026-09-02）

R4.1 按 Phase 1–4 完整实施。初版曾给 context 增加 capability slot，并在初始 commit
重置；第一次 ABBA 显示 probe、裸 text 分别回退 3.5%/5.1%，超过预算。最终改为既有
`flags` 内两个命名位，普通初始 commit 不写 capability 状态；没有保留双轨字段或
runtime feature flag。

### 6.1 fresh-process 性能

R3 与 R4 各 8 个样本，四轮交替顺序；每个样本独立 Bun 进程，并在计时前验证 status、
body、Content-Type 和 late header：

| 场景                    | R3 中位数 | R4 中位数 |      R4 相对 R3 |
| ----------------------- | --------: | --------: | --------------: |
| probe                   |    419 ns |    428 ns | +2.1%（预算内） |
| 有界 JSON body          |   1471 ns |   1442 ns |           −2.0% |
| 裸 text                 |    353 ns |    351 ns |           −0.6% |
| 正确 dirty text         |   1119 ns |    775 ns |      **−30.7%** |
| 强制 immutable fallback |   1204 ns |   1241 ns | +3.1%（预算内） |

同一 harness 下 Hono 4.13.5（8 样本）中位数：probe 516ns、裸 text 346ns、正确
dirty text 1194ns、裸 JSON 1163ns。R4 分别为快 17.1%、慢 1.4%（噪声带内平价）、
快 35.1%、慢 24.0%；JSON 行不是同安全语义，Hono 没有强制字节预算。

真实 Bun HTTP（100 connections、10 pipelining、2 秒、3 轮 A-B-B-A，共 12 样本）：
R3 36,768 RPS → R4 37,168 RPS（+1.1%），p99 52ms → 53ms；所有样本 0 error / 0
timeout。网络/客户端饱和摊薄了进程内收益，但没有 wire 回退。

### 6.2 门禁

- Node：95 files，1909 passed / 2 skipped；Bun：95 files，1886 passed / 25 skipped。
- 覆盖率 statements/branches/functions/lines：`97.15/91.89/96.03/98.53%`，四项均高于
  R3 的 `97.06/91.79/95.93/98.47%`。
- fmt、typecheck、build、smoke、example、soak 全过；lint 0 error、无新增 warning，
  输出仍只有仓库既有 warning。
- Tillgate 临时加载当前构建并用 `--force` 禁用 Turbo 缓存：HTTP 133/133、Gateway
  205/205，两个包 typecheck 全过；依赖恢复后工作树 clean。

## 7. 停止条件

出现任一条件立即回退本阶段并停止扩大实现：

- mutable/immutable 不能在无部分写入前提下安全区分；
- 任一 body/HEAD/Set-Cookie/rule-4 属性测试不等价；
- 目标收益 <10% 或 IQR 与基线高度重叠；
- probe/body/bare text 稳定回退 >3%；
- 需要公开 API 或改变 listen 后注册语义才能继续；
- Tillgate 验证要求修改其源码。

## 8. 用户确认裁决

- [x] R4.1 先做 header-only commit fast lane，而不是 router/compose 重写
- [x] `onError` 保持观察 API；错误 response mapper 不混入本迁移单元
- [x] body 预算始终默认强制，不用不安全模式参加同语义排名
- [x] Set-Cookie/cookies、多值数组与 status/body 保持完整 Semantic fallback
- [x] R4.1 完整实施并核销，不留下占位代码

## 9. R4.4 施工追加

R4.4 不复用 R4.1 的 header fast-lane 假设，而是两个可独立回滚的纵向单元：

1. 先扩展 fresh-process harness，加入 0/1/3/6 层全局 passthrough 的 probe 矩阵；
2. 删除 `handle` 与同步 `dispatchChain` 的无条件闭包，在不改变公开 Promise 契约的前提
   下建立同步收尾快路；
3. 用表驱动测试锁定洋葱前后序、双 next、浮动 next、sync/async throw、route fallback、
   pooling，并根据剖析结果选择专用链编译器或保留通用 compose；
4. body parser 先锁 declared/chunked/lying/UTF-8/malformed/并发/跨 reader/小限额复检，
   再将 cache、facade 与 reader 方法重写为单一固定形状状态机；
5. 每个子单元分别跑前后 fresh-process 中位数。目标场景没有统计显著收益，或非目标
   热路径稳定回退超过 3%，该实现不进入后续门禁；
6. 最后运行 fmt、lint、typecheck、build、Node、Bun、coverage、smoke、example、soak，
   再以本地构建替换依赖执行 Tillgate 只读验证并确认其工作树无变化。

逐文件审计、测试矩阵、预算与停止条件以当前迁移单元文档为准。
