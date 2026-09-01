# HOTPATH-R4 — 企业级执行架构施工图

> 状态：审计中
> 设计基线：[HOTPATH-R4-DESIGN.md](./HOTPATH-R4-DESIGN.md)
> 首个迁移单元：[HOTPATH-R4-MIGRATION-COMMIT-FAST-LANE.md](./HOTPATH-R4-MIGRATION-COMMIT-FAST-LANE.md)

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

| 旧文件                           | 裁决       | 审计状态 | R4.1 动作                                                          |
| -------------------------------- | ---------- | -------- | ------------------------------------------------------------------ |
| `src/core/context/response.ts`   | 重构       | 已审     | 校验后调用 committed-header 端口；不能快化则沿用 staging           |
| `src/core/respond.ts`            | 重构       | 已审     | 保留唯一 Semantic rebuild；识别 fast 已完成状态，不复制 merge 规则 |
| `src/core/context/state.ts`      | 小改       | 已审     | 定义 capability 状态；注释完整位语义                               |
| `src/core/context/context.ts`    | 小改       | 已审     | 固定顺序初始化/回收 capability；pool 防跨请求泄漏                  |
| `src/core/committed-headers.ts`  | 新建       | 待实现   | 单一职责：安全尝试普通 header 原地 set/delete/append               |
| `src/core/compose.ts`            | 保留       | 已审     | 不改提交时序                                                       |
| `src/core/dispatch.ts`           | 保留       | 已审     | 错误与 never-reject 契约不改                                       |
| `src/context/cookies.ts`         | 保留       | 已审     | R4.1 不快化 Set-Cookie                                             |
| `src/router/*`                   | 保留/测量  | 已审     | 只补 scale 研究基准，不在 R4.1 改算法                              |
| `src/adapters/bun.ts`            | 保留       | 已审     | 不引入运行时专用 header 分支                                       |
| `src/adapters/node.ts`           | 保留       | 已审     | 用真实 immutable Response 集成测试 fallback                        |
| `bench/compare-hono-hotpaths.ts` | 扩展       | 已审     | 增加 mutable/immutable、set/remove/vary 与正确性断言               |
| `test/*pipeline/runtime/prop*`   | 扩展       | 已审     | 表驱动与属性回归，复用现有装置                                     |
| `scripts/smoke.ts`               | 扩展或复用 | 已审     | live Bun HTTP 锁 late header + text Content-Type                   |

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

## 6. 停止条件

出现任一条件立即回退本阶段并停止扩大实现：

- mutable/immutable 不能在无部分写入前提下安全区分；
- 任一 body/HEAD/Set-Cookie/rule-4 属性测试不等价；
- 目标收益 <10% 或 IQR 与基线高度重叠；
- probe/body/bare text 稳定回退 >3%；
- 需要公开 API 或改变 listen 后注册语义才能继续；
- Tillgate 验证要求修改其源码。

## 7. 当前待确认裁决

- [ ] R4.1 先做 header-only commit fast lane，而不是 router/compose 重写
- [ ] `onError` 保持观察 API；错误 response mapper 延后且另命名
- [ ] body 预算始终默认强制，不用不安全模式参加同语义排名
- [ ] 首版不快化 Set-Cookie/cookies、多值数组与 status/body
- [ ] R4.1 核销后再决定 router、高可用子系统的下一迁移单元
