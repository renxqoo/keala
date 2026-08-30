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

## 4.5 P4 过程审计记录（v2.0.0 发布前）

1. **`bun x vitest run` 的真相**：vitest 的 worker 是 fork 出的 Node 子进程——该命令并未在真实 Bun 运行时里跑用例（两侧 skip 计数同为 3 是证据）。真实 Bun 覆盖由三条通道补齐：`scripts/smoke.ts`（真实 Bun.serve + live HTTP，含 pbkdf2/CSRF 原生路径、routes 表方法作用域实测）、`scripts/example-check.ts`（示例全表面 live HTTP）、`test/native-bridge.test.ts`（桩掉 Bun 全局后动态 import，双运行时覆盖原生分支）。
2. **Bun 1.4.0 平台缺陷（实测确认）**：`Bun.password.verify` 对自家 argon2id/bcrypt 哈希抛 `UnsupportedAlgorithm`；`node:crypto.scrypt` 回调 reject `undefined`。两者都不能作为默认。v2 默认口令哈希为 WebCrypto PBKDF2-SHA-256（600k 迭代、常数时间比较、迭代数限界 1k–5M 防验证炸弹），`bunPasswordHasher()` 显式选择 argon2id。
3. **routes 表裸键语义（实测确认）**：裸键 Response 条目对 POST/DELETE/… 全部返回沉没响应；`{ GET: value }` 作用域化后非 GET 落回 fetch → JS 路由 405，与镜像一致。`{dir}` 裸前缀 404 落回 fetch（镜像 twin 路由补齐后两运行时一致），子目录 301 与 Range 为原生独有（PARITY 记账）。
4. **skip 裁决终态**：T2（同位置 param 正则合并）为唯一永久 skip；另 2 例为 `skipIf(!isBun)` GC 围栏（真实 Bun 下执行）。0 静默 skip。
5. **parseListenArgs 白名单缺陷**：选项对象形态曾静默丢弃 `nativeRoutes`/`websocket`/`onServeError`——已修复并入测试。
6. **compress 默认实现改 Web 标准（2026-08-31，perf/compression-stream 分支验证后合并）**：当初选 node:zlib 的依据是“Bun.gzip 异步版不存在 + node:zlib 异步路径高效”——后半句是未经实测的假设。A/B 实测（端到端走完整框架）：Bun 上 CompressionStream 顺序快 2.7–3.6x（8.7–11.8 vs 31.5µs/10KB 体）、并发平局、idle 省 ~2MB（zlib 桥不再加载）；Node 顺序 +11µs（可选组件，无感）、并发反快 44%。验证：gunzipSync 独立实现交叉解压、1MiB 多 chunk 重组、500 路并发 unhandledRejection 围栏、100k 请求 0.0 B/req 泄漏、双运行时 1223/1206 全绿。
7. **目录三分 + Component→Plugin + 通配子路径 exports（2026-08-31，refactor/middleware-plugins-helpers 分支）**：`components/` 按生命周期拆为 `middleware/`（每请求管道件，16 个工厂）、`plugins/`（装配期 install 协议，body-parser）、`helpers/`（handler 内工具：streams/html/password）；`auth.ts` 拆分为 guards（middleware）+ 密码工具（helpers，两半零代码依赖）；`csrf-token.ts` 整文件留于 middleware（guard 与 service 共享类型、成对配置）。`interface Component` → `Plugin`（vite/eslint/Fastify decorate 同形术语）。package.json 增加通配子路径 exports（`./middleware/*` 等）——未来新文件自动获得子路径，零维护。决策依据：hono 按调用位置分层（76 子路径第一手核验）、koa 生态装配层猴补反面证据（koa-session/koa-views 改 app.context）、Fastify 类型化 plugin 先例；零行为变更约束（双运行时测试数与重构前逐字一致为合并条件）。
8. **基准方法学修正（2026-08-31）**：逐服务器顺序执行的基准存在高达 ±25% 的顺序偏差——ABAB 交叉复测证明早前 "vs hono 1.06x~1.29x" 的头条数字落在噪声带内（真实结论：HTTP 统计平局；进程内 379ns vs 379ns 精确打平）。`bench/run.mjs` 已改为全服务器驻留、场景内轮转交错（4 轮），ratio 行附带双方波动带；`verify-baseline.ts` 改为批次级交错。vs koa 3.0–3.5x / 1000 路由 15x 的差距远超噪声带，结论不变。
9. **Bun.CSRF 尾字符无效位实测（2026-08-31）**：Bun 1.4.0 的 `Bun.CSRF` token 末位 base64 字符有 31% 概率是 padding 无效位——翻转后解码字节与 MAC 输入完全不变，verify 依然通过（200 次实测 61 次）。这曾使 csrf 篡改测试在真 Bun 门禁上 ~1/3 概率闪失败；修复为测试改翻中间字符（必为有效位）。框架篡改防御无缺陷（有效位篡改全部被拒）。

## 5. 总验收清单（P4 出口）

1. 性能：G1-G12 全过（相对比值口径）；BENCH.md 用新方法学重测（机器/Bun 版本/日期），含 v2/hono/raw + 1000 路由 + HTTP + p99 + 内存
2. 测试：≥900 例 + 新功能 ≥150 例；11 skip 全部裁决；170+ 安全语料全程绿
3. 四门禁：oxfmt / oxlint 0-0 / tsc / vitest（Node + Bun 双跑）+ 覆盖率 ≥90%（排除范围显式声明）
4. soak 三层（进程内/全栈 HTTP/pooled）漂移 <0.5%；smoke v2 化通过
5. 文档：README（快速上手+koa→v2 映射表）、docs/v2-DESIGN、v2-MIGRATION 核销、PARITY.md 再生（含 deliberate divergences 更新）
6. 发布面：package.json 2.0.0、exports/dist（bun build --dts）、示例路由冒烟
7. 基准一键复现：`node bench/run.mjs` + `bun bench/verify-baseline.ts`（v2 化）
