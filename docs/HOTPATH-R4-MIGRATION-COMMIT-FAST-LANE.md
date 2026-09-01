# R4.1 — committed header Fast 通道迁移文档

> 状态：审计中
> 迁移单元：外层 middleware 在 `await next()` 后修改已提交 Response header
> 旧实现：6 个核心文件约 1,813 行；相关 rule-4/committed 回归分布于 15 个测试文件
> 目标位置：`src/core/committed-headers.ts` 与现有 response/finalizer 接线
> 设计基线：[HOTPATH-R4-DESIGN.md](./HOTPATH-R4-DESIGN.md)
> 施工图：[HOTPATH-R4-IMPLEMENTATION.md](./HOTPATH-R4-IMPLEMENTATION.md)

## 1. 行为规格基线

### 1.1 既有行为

```ts
app.use(async (c, next) => {
  await next();
  c.set("x-request-id", "r1");
});

app.get("/", (c) => c.text("hello"));
```

必须得到 status 200、body `hello`、`x-request-id: r1` 和
`content-type: text/plain; charset=utf-8`。外层写是 rule-4 的最新意图；实现可以改变，
输出、错误和时序不能改变。

### 1.2 规格来源

| 测试文件                              | 现有关注点                         | 本单元动作                    |
| ------------------------------------- | ---------------------------------- | ----------------------------- |
| `test/app.test.ts`                    | 双模式 Response 胜负、late set     | 保留并增加不重建观察装置      |
| `test/agent3-pipeline.test.ts`        | late append/remove/cookie 历史 bug | 全部作为 fallback 锁          |
| `test/agent-r5-runtime.test.ts`       | 提交前状态不得污染提交后 rewrite   | 保留                          |
| `test/agent-r5-runtime-locks.test.ts` | stream、dirty rebuild、status/body | 扩展 immutable Response       |
| `test/redteam.test.ts`                | HEAD + deferred header/cookie      | 保留                          |
| `test/redteam-r3-pipeline.test.ts`    | 204/304、vary、message             | 保留                          |
| `test/agent-r6-rtc.test.ts`           | flags 32/64/128                    | 保留，fast 后再 semantic 组合 |
| `test/agent-r6-prop*.ts`              | 随机 post-commit 不变量            | 增加 fast/fallback 差分       |
| `test/agent-r7-core-red.test.ts`      | open body 不得被读取               | 保留                          |
| `test/agent-r8-review.test.ts`        | body replacement 不带旧 length     | 保留                          |
| `scripts/smoke.ts`                    | 真 Bun.serve wire 结果             | 增加/复用 late text wire 锁   |

不删除任何现有用例。机制断言若依赖“必须新建 Response”，改写为 Fast on/off 结果等价与
分配计数；公开行为断言原样保留。

## 2. 审计结论引用

- 提交点与重建税：施工图 A1–A2；
- accessor/flag/cookie 语义：A3–A6；
- 跨 runtime guard：C1；
- 共享实现要求：D1–D2；
- `has/resHeader` 的存量观察契约：D3。

## 3. 逐模块裁决表

| 文件                            | 裁决                 | 动作                                                       |
| ------------------------------- | -------------------- | ---------------------------------------------------------- |
| `src/core/context/response.ts`  | 重构                 | 普通单值 set/remove 在校验后尝试 fast；fallback 原逻辑不变 |
| `src/core/respond.ts`           | 保留主算法、小改接线 | dirty 判定仍只处理未应用变更；Semantic rebuild 保持唯一    |
| `src/core/context/state.ts`     | 小改                 | capability 命名常量/slot，禁止散落 magic number            |
| `src/core/context/context.ts`   | 小改                 | create/reset/pool 回收归零                                 |
| `src/core/committed-headers.ts` | 新写                 | 封闭 header mutation 与 guard 探测，无业务依赖             |
| `src/core/compose.ts`           | 复制行为、不改代码   | commit 时序不动                                            |
| `src/context/cookies.ts`        | 复制行为、不改代码   | 首版继续 staged/rebuild                                    |
| `src/core/dispatch.ts`          | 复制行为、不改代码   | error/never-reject 不动                                    |
| `src/adapters/*`                | 复制行为、不改代码   | 通过集成测试验证，不写 runtime 特判                        |

## 4. API 对照表

| 旧签名                               | 新签名                                         | 变化理由                     |
| ------------------------------------ | ---------------------------------------------- | ---------------------------- |
| `c.set(field, value): void`          | 不变                                           | 内部状态表示优化，零迁移成本 |
| `c.remove(field): void`              | 不变                                           | 同上                         |
| `c.append(field, value): void`       | 不变                                           | Phase 3 前仍走旧算法         |
| `c.vary(field): void`                | 不变                                           | Phase 3 前仍走旧算法         |
| `app.onError(listener): Application` | 不变                                           | 观察面冻结，不属于本单元     |
| 内部无端口                           | `trySet/tryDeleteCommittedHeader(...): applied | fallback`                    | 把 guard 与 mutation 封闭，禁止 accessor 复制 try/catch |

内部函数名在实现时可调整，但必须保持判别返回，不得用异常作为 accessor 的正常控制
流暴露给调用方。

## 5. 测试迁移矩阵

| 旧测试/场景                       | 新去处                | 动作                                         |
| --------------------------------- | --------------------- | -------------------------------------------- |
| late `c.set` on sugar Response    | dedicated R4.1 test   | 改写为 mutable fast + 输出等价               |
| late `c.remove`                   | dedicated R4.1 test   | mutable fast；不存在 header 仍为幂等         |
| late append/vary                  | pipeline tests        | Phase 2 fallback 锁；Phase 3 再放行          |
| late cookies/Set-Cookie           | pipeline/redteam      | 明确 fallback，验证多 cookie 不折叠          |
| fetch/redirect immutable Response | runtime locks         | 新增 Node 真实 guard fixture                 |
| fast header → late status/body    | runtime locks         | 新增组合顺序用例                             |
| HEAD/open stream                  | runtime/core-red      | 保留，不读取 body                            |
| random operations                 | property tests        | 同 seed 跑 fast enabled/forced fallback 差分 |
| live Bun text Content-Type        | smoke                 | wire 断言必须保持 text/plain                 |
| benchmark                         | compare-hono-hotpaths | fresh process，正确性断言先于计时            |

## 6. 回滚方案

- 无 DDL、无数据迁移、无 Tillgate 写入；每阶段提交可独立 `git revert`。
- Phase 1 只有测试/基准，可保留作为回归装置。
- Phase 2 回滚新 helper、context capability 与两处接线后，系统自动回到 R3 全量 rebuild。
- Phase 3 每个 operation 单独提交；append/vary 任一失败不影响已核销的 set/remove。
- 不增加长期 runtime feature flag，避免每请求永久分支；紧急回滚以提交为单位。

## 7. 验收

- [ ] mutable 普通 set/remove 不新建 Response/Headers、不物化 staged record
- [ ] immutable/复杂 header 自动 fallback，输出与 R3 逐字节等价
- [ ] 后续 status/body rewrite 保留较早 fast header，rule-4 顺序正确
- [ ] HEAD/204/304/stream/Set-Cookie/error/notFound/405 全回归
- [ ] pooled capability 不跨请求泄漏
- [ ] target ≥15%；probe/body/bare text 回退 ≤3%；immutable fallback 回退 ≤5%
- [ ] fmt、lint、typecheck、build、Node、Bun、coverage、smoke、example 全绿
- [ ] 覆盖率 statements/branches/functions/lines 不低于 R3 基线
- [ ] Tillgate 只读测试通过且工作树前后 clean
- [ ] 文档追加真实数字、发现的 bug 与未完成挂账后才改为已核销

## 8. 实施记录

尚未开始实现。当前只完成代码审计、跨 runtime guard 探针与执行方案；等待默认裁决
确认后进入 Phase 1。
