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
10. **挂账清偿轮（2026-08-31，B 类 7 项 + C 类 2 项，零挂账收口）**：
    - **T2 解跳（唯一永久 skip 消失，0 静默 skip 达成）**：trie 同位置 param 改为多变体——head 槽保留首注册变体（热路径仅加一次 null 检查），`paramMore` 按注册序存同名异 pattern 变体；变体按 `(name, pattern.source)` 识别，完全相同者共享节点且 optional 粘滞；同位置异名仍抛错。`/users/:id(\d+)/a` 不再吞掉后注册的 `/users/:id/b`。
    - **decorate/ws 防遮蔽**：`decorate()` 对重复 key 与核心 context key 抛 TypeError（Fastify 同形，`__proto__`/`constructor` 一并拒绝）；重复 `app.ws()` 同路径抛错（原为 map 静默覆盖 + 双 upgrade 路由叠加）。
    - **serve-static Windows 分隔符**：旧包含检查用 `${root}/`——Windows 上 `resolve` 返回反斜杠路径，合法多级路径全数误判 403；且 `%5C` 编码的反斜杠在 Windows 是文件系统分隔符（遍历向量）。改为平台 `sep` 比较 + Windows 下 `[\\/]` 双分隔符折叠；POSIX 上反斜杠仍是合法文件名字符（行为不变）。纯函数 `cleanSegments`/`isWithinRoot` 导出供跨平台直接测试。
    - **bodyParser `formPartLimit`（默认 1000）**：字节上限挡不住微型 part 洪水（10MB 体 ≈ 数十万 FormData 条目的内存放大）。multipart 按 `--boundary` 出现数、urlencoded 按 `&` 配对数做预检预算；扫描只可能多计不可能漏计（内容里长得像 boundary 的串也会计入）——fail-closed。
    - **observedStream 背压**：`start` 急切泵（源被全速抽干入队，下游慢时内存无界）改为 `pull` 驱动——仅在下游要数据时读源，背压透传；cancel 透传 `reader.cancel`。测试锁：停滞消费者下源读取数有界 + 错误仍达 app 钩子。
    - **cors Vary 精确化**：白名单回显 Origin（响应随 Origin 变）→ `Vary: Origin` 恒在（含无 Origin 请求，防共享缓存投毒）；`origin:"*"` 时 ACAO 是常量、响应与 Origin 无关 → 不再发 Vary（旧实现无条件追加，白白禁用共享缓存）。
    - **node 内置模块懒加载（`utils/node-lazy.ts`）**：`createRequire` 同步懒访问器（动态 `import()` 服务不了 cookie 签名/CSRF issue 这类同步调用点）。cookies/csrf-token/password/serve-static 四个消费者全部改懒。实测（Bun，5 样本中位数）：idle 23.0MB vs 改前 25.8MB——**省 ~2.8MB**；crypto 桥推迟到首个签名 cookie / CSRF fallback / 密码验证（首次触发 ≈ +5MB），fs/path 推迟到首个 serveStatic 请求（实测 ≈ 0 增量）。台账原 "~5MB" 估计来自新进程桥探针，偏高，按实测修正。
    - **官方 Node 适配器 `adapters/node.ts`**（子路径 `bun-koa/adapters/node`；不进 index barrel，Bun 导入框架不加载 node:http 桥）：IncomingMessage → web Request（体经 `Readable.toWeb` 流式透传不缓冲、Host 身份保留进 URL、GET/HEAD 无体、无长度声明也走流）；web Response → ServerResponse（`pipeline` 真背压、set-cookie 扇出、HEAD 零体 + Content-Length 回填）；`c.ip` 走 `runtime.remote`；malformed HTTP → 400、Upgrade 请求 → 501（ws 为 Bun 独占）；句柄 `port/hostname/stop/fetch/ready()` 与 Bun 句柄同形（`ready()` 因 Node 异步绑定而存在）。真 socket 测试双运行时执行（Bun 实现 node:http）。
    - **Node param ~7.5% 进程内缺口：定性后不修（决策入账）**：分段隔离——matcher 层 66ns vs hono 23.5ns（V8 原生单 regex 优势）；params 记录 `Object.create(null)` 在 V8 创建+读取 19ns vs 字面量 4ns（null-proto 走字典慢路径）。但 JSC 完全反向：null-proto 2.96ns 最快、字面量 8.5ns。为 V8 翻转对象形状会回归 Bun（主运行时）上的精确平局；text 路由在 Node 上仍精确平局（3203 vs 3221ns）。余量分散于共享 dispatch 管线，不值得为副运行时动主运行时已打平的代码。
11. **红队子代理审查轮（2026-08-31，交付前独立复核）**：10 项确认发现全部修复并加回归锁——① trie 变体优先级反了（head 先 push 后 pop → 后注册者赢；两处 push 序修正 + "谁赢"目标锁定测试）；② formPartLimit 完全绕过：boundary 从小写化后的 content-type 提取，而 RFC 2046 boundary 大小写敏感 → 混合大小写 boundary 计数为 0（实测 1200 part 无 413；改为原始头取值）；③ >70 字符 boundary 跳过预算（undici 接受 80 字符；上限放宽到 1024 全扫描，>1024 时每 part 自带 ≥1KB 成本、字节预算已封顶放大）；④ Node 适配器无 server.on("error")：EADDRINUSE 变 uncaughtException、ready() 永挂（failedBind promise + race）；⑤ decorate 守卫漏实例槽位（params/bodyValue/_res 可被装饰 → 每请求 500；改 createContext 探针 Set，永不漂移）；⑥⑦⑧ absolute-form 请求 500（正则识别后原样用）、IPv6 回退主机未括号（[::1]:port）、clientError write+destroy 丢 400（改 socket.end 先flush）；⑨⑩ 文档措辞。审查同时验证了 fast matcher 等价性、懒桥缓存正确性、serve-static 无绕过、observedStream 无丢块——这些确认无发现。
12. **基准方法学对照 hono 官方套件校准（2026-08-31，新增 Go 参照）**：第一手分析 hono-main/benchmarks——其 HTTP 压测仅做 hono-vs-hono PR 回归且统计最弱（无预热、runs=1、取均值、baseline 恒先跑、无噪声报告）；精华在进程内微基准（每变体每轮全新进程、奇偶轮 ABAB、median-of-p50、懒建预热、DCE 防护）。我们的 ABAB 轮换交错 + ±噪声带 + p50/p99 + RSS 三态 + raw/Go 双基线已超其 HTTP 口径。借鉴落地：压测前逐服务器×场景响应正确性断言（body+中间件头逐字节，--skip-tests 可跳）、生成报告加诚实性脚注；未采纳 bombardier/--fasthttp（客户端行为失真）、共享 CI runner（噪声）；已知局限入档：verify-baseline 为同进程批次交错（非每变体新进程），由 HTTP 横评平局交叉佐证。新增 bench/server-go（stdlib net/http，Go 1.22+ 方法路由，1000 路由 scale 变体，/debug/memory 映射 ReadMemStats+ps RSS）与 run.mjs 自动构建接入（无工具链则跳过）。
    - **验证**：Node 1274 / 真 Bun 1237 全绿；覆盖率 96.72/90.85/95.76/98.40 四项全面高于改前基线（96.3/90.83/95.51/97.95）；Bun 进程内 text 400/385ns、param 501/495ns 维持与 hono 平局；smoke/example/soak 全过（in-process 0.0 B/req）。真 Bun 全量并发下 perf-evidence 两个宽预算用例偶发抖动，隔离 7/7 绿——机器负载敏感，非回归。

13. **入口面重塑（2026-08-31）**：根入口 `bun-koa` 收窄为核心（createApp/router/compose/Context/errors/cookie 签名/startBunServer——hono/fastify 同构：根=核心）；新增 `bun-koa/middleware` 聚合入口（16 个工厂一次导入，匹配"装配期一口气拿多个"的真实用法）；plugins/helpers/adapters 刻意不聚合（单成员/按需单点/互斥选择——聚合与省内存目标自相矛盾或诱导误用），通配子路径照旧。实测（Bun/AS，3 样本中位）：根导入 idle 20.4MB（原全家桶 23.1，**省 2.7MB**）；根+聚合 21.4MB；同协议 hono 根导入 29.2MB（轻 ~30%）。表面锁测试（entry-surface.test.ts）防中间件回流根 barrel。dist 打包压缩 PoC 结论：体积 −43%（324→184KB）但 idle RSS 无可测收益（JIT/arena 占大头），行业惯例库层不 minify——不做，留待应用端打包边界。此前 #7 决策的"三分层目录"升级为"三分层入口"。

## 5. 总验收清单（P4 出口）

1. 性能：G1-G12 全过（相对比值口径）；BENCH.md 用新方法学重测（机器/Bun 版本/日期），含 v2/hono/raw + 1000 路由 + HTTP + p99 + 内存
2. 测试：≥900 例 + 新功能 ≥150 例；11 skip 全部裁决；170+ 安全语料全程绿
3. 四门禁：oxfmt / oxlint 0-0 / tsc / vitest（Node + Bun 双跑）+ 覆盖率 ≥90%（排除范围显式声明）
4. soak 三层（进程内/全栈 HTTP/pooled）漂移 <0.5%；smoke v2 化通过
5. 文档：README（快速上手+koa→v2 映射表）、docs/v2-DESIGN、v2-MIGRATION 核销、PARITY.md 再生（含 deliberate divergences 更新）
6. 发布面：package.json 2.0.0、exports/dist（bun build --dts）、示例路由冒烟
7. 基准一键复现：`node bench/run.mjs` + `bun bench/verify-baseline.ts`（v2 化）
