# HOTPATH-R4.5 — Bun/Node 运行时执行引擎迁移

> 状态：复核中（2026-09-03；[追加审计与修复](./HOTPATH-R4-5-CONTRACT-AUDIT.md)）
> 后续切片：[已验证头快照](./HOTPATH-R4-5-VALIDATED-HEADERS.md)，外部 API 无迁移。
> 迁移单元：同一 Keala 应用在 Bun/Node 上以运行时原生路径接收请求并发送响应
> 旧实现：`src/adapters/*` + Fetch-only Context/Finalizer（相关 13 个源文件、4 组核心测试）
> 目标：单一 RequestSource/ResponsePlan 语义核心 + Bun/Node 专用终端
> 设计：[HOTPATH-R4-5-RUNTIME-DESIGN.md](./HOTPATH-R4-5-RUNTIME-DESIGN.md)
> 施工：[HOTPATH-R4-5-RUNTIME-IMPLEMENTATION.md](./HOTPATH-R4-5-RUNTIME-IMPLEMENTATION.md)

## 1. 行为规格基线

旧测试是迁移规格，不删除断言：

| 测试                               |             基线规模 | 行为                                                     |
| ---------------------------------- | -------------------: | -------------------------------------------------------- |
| `test/adapters-node.test.ts`       |             27 cases | 真实 node:http 请求/响应、生命周期、raw socket、失败表面 |
| `test/r4-4-core-hotpath.test.ts`   |              7 cases | 洋葱固定税与 body memo 语义                              |
| `test/plugins-body-parser.test.ts` |             21 cases | declared/chunked/lying/UTF-8/part budget/reader memo     |
| `test/native-bridge.test.ts`       |             10 cases | Bun runtime、sink、SSE timeout bridge                    |
| response/matrix/property/redteam   | 59 个含 sugar 的文件 | rule-4、HEAD、空状态、stream、错误、pool 隔离            |

此外保留 `agent-review-security` 的 Node framing 防走私、`agent-r5-parsers-server` 的
OPTIONS*/absolute/repeated/chunked/HEAD 锁，以及 `redteam-r3-runtime` 的适配器回归。

## 2. 审计结论

引用施工图 §1。B45-1/2/3/4/5 均在本迁移单元修复，不挂账；D45-1/2 在新 source/plan
中消除；C45-1/2/3 通过内部端口补齐。实现期额外发现并锁定：惰性绝对 URL、重建响应头
事实污染、Bun 1.4 文本 Content-Type、未读/超限 body 的 keep-alive 清理、benchmark
误用 Node 子进程和“独立中位数相除”统计偏差。

## 3. 逐模块裁决

引用施工图 §2。关键裁决：`src/adapters/node.ts`、request entry 与 body read port 为重写；
router/compose 不做语义重写，但加入注册期单 handler 特化、静态 match 复用、单动态路由
快匹配与冗余 decode 消除；旧 requestOf/pipeline 不移植。

## 4. API 对照

| 旧签名                          | 新签名     | 变化                                              |
| ------------------------------- | ---------- | ------------------------------------------------- |
| `app.handle(Request, runtime?)` | 相同       | 公开 Fetch 契约不变，内部包装 Fetch source        |
| `startNodeServer(app, options)` | 相同       | 内部直接传 Node source，不先造 Request            |
| `c.raw`                         | 相同       | 从 eager Request 改首次访问物化                   |
| `c.req.json/text/...`           | 相同       | 从 Web body 入口改 source 有界读取，memo 语义不变 |
| `c.text/json/html`              | 相同       | 返回 Response 并携私有构造事实                    |
| Node writer                     | 无公开签名 | 旧 pipeline 删除，direct/stream 单引擎替代        |

## 5. 测试迁移矩阵

| 旧测试                    | 新去处                        | 动作                                |
| ------------------------- | ----------------------------- | ----------------------------------- |
| Node adapter 25 cases     | 原文件 + runtime e2e          | 改写装置但断言不删                  |
| body parser 21 cases      | 原文件 + Node wire body cases | 保留并扩展 source 所有权            |
| core hotpath 7 cases      | 原文件                        | 保留，增加 metadata 不分配/不泄漏锁 |
| native bridge 10 cases    | 原文件 + Bun smoke            | 保留，增加最终物化断言              |
| response/property/redteam | 原文件                        | 全量保留，不因内部表示调整期望      |
| 旧性能脚本                | 新 fresh-server harness       | 重写；旧非官方 Node-Hono 口径不移植 |

没有删除测试。实现期发现的每个真实 bug都以 B45 编号补一个回归用例。

## 6. 回滚方案

每阶段独立提交，可按逆序 `git revert`；无数据库或持久数据动作。响应 writer、request
source、body source 三阶段不能半开 feature flag：回滚整个阶段提交恢复上一完整世界。

## 7. 验收清单

- [x] 旧 Node requestOf/pipeline 与兼容开关不存在
- [x] RequestSource/ResponsePlan 单一实现通过新增契约复核及完整行为矩阵
- [x] Node direct body、stream 背压、request cleanup 跨进程通过
- [x] Bun 真运行时与 Node 源码/构建产物双形态冒烟通过
- [x] fmt / lint 0 error / typecheck / build / Node test / Bun test 全绿
- [x] coverage 四项不低于 R4.4 `97.24/92.04/96.19/98.58%`
- [x] smoke / example / soak 全绿
- [x] Tillgate 只读测试、typecheck 全绿且工作树 clean
- [ ] Bun/Node 同语义 fresh-process 和真实 HTTP 达到原性能预算（历史证据不足）
- [x] 追加复核记录所有样本、提交、bug、修法和验收缺口

## 8. 实施记录

以下为 2026-09-02 历史记录，核销已在追加审计中重开。原门禁：Node/Vitest 107 文件、2008 pass/8 skip；
Bun 1979 pass/37 skip；coverage `97.32/92.07/96.29/98.69%`；build、smoke、example、
24×20,000 soak、Bun/Node × source/dist 进程矩阵全绿。Tillgate 临时 `file:` 替换验证
5 个直接消费者，typecheck 17/17 tasks、test 17/17 tasks（718 tests）；原仓库零修改。

历史性能摘要混用了配对中位数与独立中位数，也未逐样本重启服务；不能由这些数字证明
所有主路径稳定领先或原 `+10%` 目标达成。最新可复核结果与缺陷记录以
[追加审计](./HOTPATH-R4-5-CONTRACT-AUDIT.md) 为准。不保留旧引擎兼容分支。
