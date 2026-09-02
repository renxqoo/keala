# HOTPATH-R4.5 — Bun/Node 运行时执行引擎迁移

> 状态：定稿
> 迁移单元：同一 Keala 应用在 Bun/Node 上以运行时原生路径接收请求并发送响应
> 旧实现：`src/adapters/*` + Fetch-only Context/Finalizer（相关 13 个源文件、4 组核心测试）
> 目标：单一 RequestSource/ResponsePlan 语义核心 + Bun/Node 专用终端
> 设计：[HOTPATH-R4-5-RUNTIME-DESIGN.md](./HOTPATH-R4-5-RUNTIME-DESIGN.md)
> 施工：[HOTPATH-R4-5-RUNTIME-IMPLEMENTATION.md](./HOTPATH-R4-5-RUNTIME-IMPLEMENTATION.md)

## 1. 行为规格基线

旧测试是迁移规格，不删除断言：

| 测试                               |             基线规模 | 行为                                                     |
| ---------------------------------- | -------------------: | -------------------------------------------------------- |
| `test/adapters-node.test.ts`       |             25 cases | 真实 node:http 请求/响应、生命周期、raw socket、失败表面 |
| `test/r4-4-core-hotpath.test.ts`   |              7 cases | 洋葱固定税与 body memo 语义                              |
| `test/plugins-body-parser.test.ts` |             21 cases | declared/chunked/lying/UTF-8/part budget/reader memo     |
| `test/native-bridge.test.ts`       |             10 cases | Bun runtime、sink、SSE timeout bridge                    |
| response/matrix/property/redteam   | 59 个含 sugar 的文件 | rule-4、HEAD、空状态、stream、错误、pool 隔离            |

此外保留 `agent-review-security` 的 Node framing 防走私、`agent-r5-parsers-server` 的
OPTIONS*/absolute/repeated/chunked/HEAD 锁，以及 `redteam-r3-runtime` 的适配器回归。

## 2. 审计结论

引用施工图 §1。B45-1/2/3/4 均在本迁移单元修复，不挂账；D45-1/2 在新 source/plan
中消除；C45-1/2/3 通过内部端口补齐。

## 3. 逐模块裁决

引用施工图 §2。关键裁决：`src/adapters/node.ts`、request entry 与 body read port 为重写；
router/compose 保留；旧 requestOf/pipeline 不移植。

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

- [ ] 旧 Node requestOf/pipeline 与兼容开关不存在
- [ ] RequestSource/ResponsePlan 单一实现通过行为矩阵
- [ ] Node direct body、stream 背压、request cleanup 跨进程通过
- [ ] Bun 真运行时与 Node 源码/构建产物双形态冒烟通过
- [ ] fmt / lint 0 error / typecheck / build / Node test / Bun test 全绿
- [ ] coverage 四项不低于 R4.4 `97.24/92.04/96.19/98.58%`
- [ ] smoke / example / soak 全绿
- [ ] Tillgate 只读测试、typecheck 全绿且工作树 clean
- [ ] Bun/Node 同语义 fresh-process 和真实 HTTP 达到设计预算
- [ ] 文档记录所有样本、提交、bug、修法和显式未迁项

## 8. 实施记录

文档定稿于 2026-09-02；实现从行为锁与基准锁开始。当前没有挂账项。
