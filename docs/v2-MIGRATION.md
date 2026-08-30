# bun-koa v2 — 逐条迁移矩阵

用途：P1-P4 每阶段出口的套件构成以此为准；任何"归档"处置必须先完成其中的断言普查。测试资产实测基数：**35 文件 / 1000 例（989 通过 + 11 skip）**。

---

## 1. 源码模块处置

| 处置       | 模块                                                                                                                                                                                                 | 说明                                                                                                 |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 近逐字迁移 | `src/utils/{query,mime,text,url}.ts`、`src/negotiation/{accepts,typeis}.ts`、`src/http/{errors,status}.ts`、`src/context/cookies.ts`                                                                 | ~1000 行 hardened 代码 + 配套测试；迁移时不得"简化"任何校验（安全审计 §一 的 14 条机制清单逐条对应） |
| 重写       | `src/application/{app,compose,respond,emitter}.ts`、`src/context/context.ts`、`src/http/{request,response}.ts`、`src/router/{router,trie}.ts`、`src/adapters/bun.ts`、`src/types.ts`、`src/index.ts` | 重写规格受 DESIGN §7.1 十一条契约约束；compose 的预编译层模型**保留**（D4）                          |
| 放弃语义   | 三件套门面、router-as-middleware、`app.request/response/context` 原型扩展层、40 处 ctx 委托                                                                                                          | `app.decorate()` + 泛型累积替代扩展层                                                                |
| 修复       | `src/adapters/bun.ts:18` 虚构 API `server.update()`                                                                                                                                                  | Bun 实际 API 为 `server.reload()`（已复验）                                                          |

## 2. 测试文件迁移矩阵（逐文件）

| test 文件                               |               例数 | 处置                    | 目标阶段 | 说明                                                                                                                                                                          |
| --------------------------------------- | -----------------: | ----------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| utils.test.ts                           |                 24 | A 存活（改 import）     | P1       | 纯模块测试                                                                                                                                                                    |
| cookies.test.ts                         |                 22 | A 存活                  | P1       | signed/属性白名单/null 原型全保留                                                                                                                                             |
| negotiation.test.ts                     |                 15 | A 存活                  | P1       |                                                                                                                                                                               |
| errors.test.ts                          |                 12 | A 存活                  | P1       | expose 门在 errors.ts（迁移模块）                                                                                                                                             |
| typeis.test.ts                          |                  9 | A 存活                  | P1       |                                                                                                                                                                               |
| status.test.ts                          |                  5 | A 存活                  | P1       |                                                                                                                                                                               |
| security-extended.test.ts               | 78 断言级（17 it） | B 改写（ctx 成员改名）  | P1       | 断言语义 100% 保留；含错误路径清头、O(n²) query、体量模糊                                                                                                                     |
| anomalies.test.ts / anomalies-2.test.ts |           102 / 73 | B 改写 / 半数 C 重写    | P1/P2    | 非法 status/body/header/cookie 矩阵 → B；纯门面形状 → C                                                                                                                       |
| negotiation-cookies.test.ts             |                 91 | B 改写                  | P1       | 语义与门面无关                                                                                                                                                                |
| agent-security-audit.test.ts            |   86 断言（30 it） | B 改写                  | P1       | x-forwarded 信任链整节是契约 #4 的绑定测试                                                                                                                                    |
| matrix.test.ts                          |                 59 | B 改写                  | P1       | respond 序列化语义                                                                                                                                                            |
| agent-bugs.test.ts                      |                 33 | B 改写                  | P1       | %2F 不拆段（契约 #5）、url 缓存失效链（契约 #8）、redirect 状态分类                                                                                                           |
| coverage-gaps*.test.ts                  |                 46 | B 改写                  | P1       |                                                                                                                                                                               |
| request.test.ts / response.test.ts      |            20 / 25 | B 改写                  | P1       | facade 语义 → 平铺字段断言                                                                                                                                                    |
| agent-concurrency.test.ts / -2.test.ts  |            17 / 23 | B 改写                  | P1       | pooled 405 泄漏锁（契约 #6）、流错误通道、lazy 单例                                                                                                                           |
| security.test.ts                        |                 23 | B 改写                  | P1       | cookie jar null 原型（契约 #11）、redirect 双编码                                                                                                                             |
| pooling.test.ts                         |                  6 | B 改写                  | P1       | P3 加 guarded 模式新例                                                                                                                                                        |
| adapter.test.ts                         |                  8 | B 改写                  | P1       | update→reload 一并修                                                                                                                                                          |
| router-edge.test.ts                     |                 48 | C 重写                  | P1       | **v2 路由算法规格**；含共享首段/桶回退新例                                                                                                                                    |
| router.test.ts / trie.test.ts           |            18 / 16 | C 重写                  | P1       | 新 API 形状                                                                                                                                                                   |
| compose.test.ts                         |                 10 | C 重写                  | P1       | 预编译链语义保留 + 双模六规则                                                                                                                                                 |
| app.test.ts                             |                 14 | C 重写                  | P1       | 顶层管线/未命中全局中间件/晚 use 重编                                                                                                                                         |
| agent-redteam.test.ts                   |                 15 | C 重写                  | P1       | 其中 `[T2]` skip 在 v2 **解跳**（v2 修复 param-position pattern 共享）                                                                                                        |
| agent-parity-gaps*.test.ts              |            38 + 18 | C 重写 / D 归档         | P1       | gaps-2 全 18 例为 @koa/router 形状（6 例本就 skip）→ 归档                                                                                                                     |
| agent-perf-evidence.test.ts             |                 12 | C 重写                  | P1       | G12 结构围栏按 v2 隐藏类形状重标定                                                                                                                                            |
| official-parity.test.ts                 |                 33 | D 归档 6 例 + 其余 B    | P1       | 归档：扩展层 2、toJSON 1、search/querystring setter 3；**保留**：GHSA attachment 组、onerror 5 例                                                                             |
| koa-parity.test.ts                      |                 27 | D 归档 8-10 例 + 其余 B | P1       | 归档：toJSON 形状、query setter、router-as-middleware 形状；**必须先移植**：redirect/back 同源（含跨源 Referrer 拒绝）、web-Response 头合并走 set() 校验、etag 引号、404 默认 |

**量化汇总**：存活 A ≈ 87（8.8%）｜改写 B ≈ 590（59%）｜重写 C ≈ 200（20%）｜归档 D ≈ 32-60（上游 562 矩阵口径）。

**阶段出口套件构成**：P1 ≥550 例绿（A 全量 + B 中不依赖新功能者 + C 路由/管线重写完）→ P2 ≥900 绿 + 新功能 ≥150 → P3 全绿 + Bun-only 分支 → P4 全绿 + 红队账本闭环。

## 3. 11 条安全契约 → 绑定测试（重写验收清单）

| #   | 契约（v1 位置）                                                      | 绑定测试                                                                    |
| --- | -------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1   | 错误路径清头 + expose 门 + error.headers 校验（app.ts:286-308）      | security-extended 386-397、official-parity onerror 5 例                     |
| 2   | respond 空状态清头 + HEAD CL 回填 + Latin-1 守卫（respond.ts:50-97） | matrix、agent-concurrency 439                                               |
| 3   | 裸 Response 快路径的 set-cookie/多值前置条件                         | matrix set-cookie 组（v2 新增：快路径与 flatten 等价性）                    |
| 4   | proxy 信任门（request.ts:232-279）                                   | agent-security-audit 300-376 整节                                           |
| 5   | trie decode 防护（trie.ts:51-59,243-246）                            | security 148-158、agent-bugs 334                                            |
| 6   | pooling 重置契约 + 字段守恒（context.ts:334-354）                    | agent-concurrency 283（pooled 405 泄漏锁）、pooling 6 例；v2 新增字段守恒例 |
| 7   | compose double-next 守卫                                             | compose 重写组                                                              |
| 8   | url setter 缓存失效链（request.ts:179-231）                          | agent-bugs url 组                                                           |
| 9   | 错误兜底永不抛出（app.ts:269-278）                                   | anomalies 非 Error 抛出组                                                   |
| 10  | header 名/值校验（text.ts:17-45）                                    | security-extended header 组                                                 |
| 11  | cookie jar null 原型 + 签名 timingSafeEqual                          | security 119-132、cookies 22 例                                             |

## 4. 11 个 it.skip 的归属裁决

- `[T2]` param-position pattern 共享（agent-redteam）：**v2 修复解跳**（新路由 IR 按段编译，天然支持）。
- fetch 运行时行为 N/A 类（agent-perf-evidence 等）：v2 保留 skip，标注原因。
- @koa/router 形状类 6 例（agent-parity-gaps-2）：随 D 归档消失。
- 其余 skip 在 P4 总验收时逐条裁决为"修复解跳 / 显式挂账"，0 静默 skip。

## 5. 总验收清单（P4 出口）

1. 性能：G1-G12 全过（相对比值口径）；BENCH.md 用新方法学重测（机器/Bun 版本/日期），含 v2/hono/raw + 1000 路由 + HTTP + p99 + 内存
2. 测试：≥900 例 + 新功能 ≥150 例；11 skip 全部裁决；170+ 安全语料全程绿
3. 四门禁：oxfmt / oxlint 0-0 / tsc / vitest（Node + Bun 双跑）+ 覆盖率 ≥90%（排除范围显式声明）
4. soak 三层（进程内/全栈 HTTP/pooled）漂移 <0.5%；smoke v2 化通过
5. 文档：README（快速上手+koa→v2 映射表）、docs/v2-DESIGN、v2-MIGRATION 核销、PARITY.md 再生（含 deliberate divergences 更新）
6. 发布面：package.json 2.0.0、exports/dist（bun build --dts）、示例路由冒烟
7. 基准一键复现：`node bench/run.mjs` + `bun bench/verify-baseline.ts`（v2 化）
