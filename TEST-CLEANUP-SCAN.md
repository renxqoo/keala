# 测试清理扫描报告（2026-11-05，只读）

范围：`test/`（167 文件）+ `src/**/__test__/`（15 文件），共 182 个测试文件。五路并行扫描后抽检核实。
清理判定按项目测试规范（恒真断言、复述声明、自建自验、自证期望、锁内部实现、无独立价值重复、退役契约、空转）。

## 一、无效测试（必须删或改写，非重复问题）

| 位置                                                                       | 问题                                                                                                                  | 建议                                |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| test/unit/matcher-fuzz.test.ts:250-263                                     | 名为"second listen() throws"，实际只断言 `app.redirect(...,"301x")` 抛错（他处已锁）；fakeServer 构造后 `void` 死代码 | 删                                  |
| test/unit/matcher-fuzz.test.ts:274-290 "echoes the client abort reason"    | 无 abort 发生，断言测试自己赋的 `reasonName="observed"`                                                               | 删                                  |
| test/unit/utils.test.ts:115-123 "falls back to the numeric status"         | 期望体由测试内 `statusMessage(599)‖String(599)` 现算（自证式）；被测的只是 Response 构造器                            | 删                                  |
| test/unit/router.test.ts:274-279 "an array of routes shares handlers"      | 无数组 API，for 循环注册两条静态路由，被 router.test.ts:21-28 覆盖                                                    | 删                                  |
| test/middleware/body-parser-errors.test.ts:209-215                         | 断言测试内自定义箭头函数 `typeof mw === "function"`（恒真）；类型导入由 typecheck 覆盖                                | 删                                  |
| test/middleware/csrf.test.ts:279-288                                       | `skipIf(REAL_BUN)` + `if (!NATIVE) return` 双闸，任何环境断言都不可达                                                 | 删                                  |
| test/middleware/csrf.test.ts:185-187 (HEAD 分支)                           | `expect(await app.handle(...)).toBeDefined()` 恒真（handle 永远返回 Response）                                        | 改写为 `status).toBe(200)`          |
| test/middleware/auth.test.ts:399-406 "timing-safe"                         | `"s3cr" !== "s3cret"`，`===` 实现同样通过，无鉴别力                                                                   | 改写（参照 api-key 比较器探针）或删 |
| test/integration/ha-regressions.test.ts:232-260                            | 259 行 `expect(true).toBe(true)`；测试名声称的"interval 被清理"无法断言；同规则已由 redteam-components:316 有效锁定   | 删                                  |
| test/integration/node-adapter.test.ts:316-… "client disconnect … 500 path" | 整个用例零 expect，只能探测进程崩溃                                                                                   | 删或补断言                          |
| test/integration/lifecycle-adapters.test.ts:194-212                        | `closedViaSlot = true` 由测试在断言前自赋（自建自验行）；测试其余部分有效                                             | 删该断言+变量，保留测试             |
| test/integration/node-response-engine.test.ts:363-364                      | `expect(c.raw).toBe(c.raw)` 弱化的记忆化探针，同文件 :86-98 Proxy 计数版更强                                          | 删两行                              |
| test/integration/context-lifecycle.test.ts:191                             | `sunk.statusText` 断言测试自建 Response 的属性（恒真；镜像 parity 行在隔壁）                                          | 删该行                              |
| test/perf/hotpath-fences-extra.test.ts:394-418 (PERF-9)                    | 自述 log-only：内存仅 console.log 无 fence，唯一断言 `inFlight===0` 人皆有之                                          | 删，或改写为真 fence                |
| test/perf/error-storm.test.ts:412-429 "c.url computation cost"             | 被测对象是测试自建 `getPath+getSearch` 闭包，不经过生产代码                                                           | 删或改写                            |
| test/security/component-redteam.test.ts:389-398                            | decorate 隔离/self-mount 两条被 router-abuse RT-6a/RT-7a 原样锁定                                                     | 删                                  |
| test/security/router-abuse.test.ts:311-321                                 | 与同 describe 的 RT-5a（:291-301）逐字节相同（含 `return c.text("hi")` —— 已不是"state-mode control"）                | 删                                  |
| test/security/router-abuse-2.test.ts:128-135 [T2c]                         | 唯一结构断言无法探测"重复 variant"；行为已被 T2 覆盖                                                                  | 删                                  |
| test/unit/matcher-fuzz.test.ts:141-148 "single-dynamic … reference"        | "reference" app 的 crowd 路由不同 bucket，探测路径无一命中，两侧走同一 fast-matcher 代码，差分不可能失败              | 删（GA-1b 已正确覆盖）              |

## 二、死代码 / 空 export（零调用方，非断言问题）

- lifecycle-contracts-admission.test.ts：`state`(:35)、`refusedPort`(:44)、`fakeGracefulServe`(:75)、`bridgeChildClose`(:107-169 整段)
- lifecycle-contracts-close.test.ts：`unhandledWatch`(:50-67)、`fakeGracefulServe`(:69-100)、`bridgeChildClose`(:102-164)
- lifecycle-contracts-deadline.test.ts：`state`(:31)、`refusedPort`(:40)、`fakeGracefulServe`(:70)、`bridgeChildClose`(:103-)
- lifecycle-contracts-strategy.test.ts：`refusedPort`(:41)、`unhandledWatch`(:52)
- admission-review-rejection.test.ts:39 `export noiseTracker`、admission-review-drain.test.ts:85 `export headerValues`
- takeover-hardening.test.ts:292-293 尾部孤立注释段头
- upstream-hardening.test.ts:263-276 死变量 `host`
- matcher-fuzz.test.ts:83-86 `if (na !== null) {}` 空语句
- streams.test.ts:174-202 死变量 `app`（测试本身有效）

## 三、永久 skip（规范禁项，需落结论）

- test/integration/error-mapper.test.ts:154、:178 两个 `it.skip("…UNCERTAIN…")` — 永不运行。删除或转为正式用例。

## 四、重复簇（同规则多处锁定；保留最全/最强版，删冗余副本）

### unit 层

- c.redirect 默认 302：response.test.ts:181-195（留）；response-regressions:34-43、surface-regressions:74-82（删）
- sugar HEAD 回填 CL：response.test.ts:132-141（留）；response-regressions:168-176（"héllo" 6 字节 UTF-8 边界迁入后删）、app-pipeline:176-183、app-runtime-locks:303-311（删）
- sugar 204 清头：response.test.ts:117-127（留）；response-regressions:354-363、app-runtime-locks:225-234（删）
- 默认 404 body：response.test.ts:18-26（留）；response-regressions:347-352（删）
- url() 缺参抛错（6 处）：router-url-regressions:66-70 + router.test.ts:207-218（留）；response-coverage:90、input-anomalies:128-132、matcher-fuzz:328-333、router-trie-fuzz:329-333（删）
- 未知方法 501+Allow：router.test.ts:117-130（留）；response-regressions:256-262、router-matching-locks:203-209（删）
- OPTIONS 合成：router.test.ts:97-115（留）；response-regressions:248-254（删）
- %2F 不分段/编码解码：router.test.ts:67-78 + router-trie.test.ts:128-132（留）；response-regressions:229-234（删）、router-matching-locks:51-61（非 BMP 行并入 router.test 后删）
- listen 参数解析：app-surface:132-166（留）；coverage-final.test.ts:20-44、router-trie-fuzz:275-308（删）
- createError 非法 status 归 500：errors.test.ts:27-31（留）；errors.test.ts:116-121（删）
- typeis 基础：typeis.test.ts（留）；app-surface.test.ts:181-185（删）
- 冲突 param 名：router-trie.test.ts:155-176（留）；router-trie-fuzz:319-327（连内部结构断言一起复制，删）
- double-next（6 处家族）：compose.test.ts:51、surface-regressions:181-198、core-regressions:13-47（direct 路径）、input-anomalies:42 各有差异留；response-regressions:387-396、app-runtime-locks:60-70、app-chain-locks 后半 可收敛
- protocol/proxy 头：request.test.ts:347-360（留）；negotiation-coverage:25-41（含名不符实的"protocol-relative"用例，删）
- dogfood:231-239 typeof 检查（被 entry-surface 精确导出锁蕴含，删）；entry-surface:95-99 可并入 :90-93
- cookie 序列化选项双表：negotiation-matrix:127-161 vs cookies.test:37-88 合并为一张

### middleware 层

- cors 拒绝 preflight：cors.test.ts:238-268（留）；coverage-topups:369-380 删、:125-142 删（:144-152 非 preflight 独有留）
- compress 决策树：coverage-topups:94-122 并入 compress.test
- logger 单行：logger-json:137-144 vs secure-headers:409-417 二留一
- password helpers：server-parsers:179-209 三对重复迁入 auth.test（盐随机、unicode 独有留原处）
- body-parser 413 快速路径三处：body-parser-locks:137-154（最强，留）；body-parser.test:385-401 删、:150-159 删
- auth M7 三 it 与 134-144 it.each 逐条重复：删 M7 三 it（372-379 留）
- csrf 同源判定矩阵三处（csrf:297-309 / redteam-components:218-235 / security-semantics:393-431）：合并保留各自独有向量
- csrfToken 会话绑定：csrf:61-70 vs security-semantics:360-371 二留一
- requestId token 校验：security-semantics:433-448（强）留；secure-headers:366-378 删
- cache sugar 修复锁：cache.test:240-252 留；security-semantics:161-177（R5-3）删
- secureHeaders extras：coverage-topups:255-263 拆分（requestId 半段重复删，permittedCrossDomainPolicies 独有留）

### integration 层

- 双信号强制关闭（6 处）：留 CT-40（最全）+ 3 个真实信号版（review-signals:50、strategy:452/458）；删 adapter-contracts:122、lifecycle-bug-locks:113、lifecycle-adapters:161、lifecycle-ha-review-shutdown:151、overload-failure-modes:180-216
- close 幂等同 promise：lifecycle-contracts-close:180（含非法选项，留）；drain:97、adapter-contracts-2:150-155 幂等段删
- listen after close 抛错：close:384 留；drain:105 删
- drain 校验：close:188 留；drain:203 删
- drain: Infinity 计数器完成：close:259（CT-7）留；adapter-contracts-2:162-176、lifecycle-adapters:279 删
- 排队断开 503+槽释放：admission:422（CT-24 最全）留；overload:195、commit-regressions:40 删
- 504 槽释放+僵尸：adapter-contracts:194（含 503 满队）留；deadline:243（CT-31）删
- 504 Context 不回收：adapter-contracts:225 与 deadline:265 二留一；timeout:97、commit-regressions:85（弱锁，名称超出断言能力）删
- stopGraceful 已结算 timer 泄漏：CT-6/6b 与 FINDING-5/6 双锁，每 adapter 留一
- 升级传导：留 review-adapters:422（真实 adapter）+ close CT-4；strategy:429、races:48 删
- 校验类被包含：overload:306+319+72、timeout:134 删（CT-17/20/18 已覆盖）
- native-sink-parity：trustedHosts describe（3 独有断言迁 unit 后删）、rateLimit×2、metrics×2、query targeted read、`+`空格 key、post-next observers 并入各自主题文件
- pipeline-regressions：post-commit header 三 it（unit response-regressions:61-110 已锁）、onerror 静态 500、HEAD committed、circular 500 全部删（error-policy/response-matrix 已覆盖）
- node-adapter-sink:68-74 typo guard ⊂ node-adapter-audit:119-129，删
- takeover-contract MAPPERS "none" vs "decline-void" 逐字相同、两个 circular injection 等价：矩阵瘦身
- reused Response 5+ 处、thenable-mapper 4 变体、headers-mutate 竞态 3 深度：每传输面留 1
- node-adapter HTTP/1.0 no-Host 两条（255-275 / 405-427）：IPv6 并入前者；ftp:// 拒绝弱版删（buffered-fastpath:230 精确版已锁）

### security/perf 层

- baseline.test 7 组 ⊂ baseline-extended 矩阵：并入（baseline 独有：裸 NUL、204 清洗 bug 锁、坏百分号、超长路径）
- admission-review-queue:275-327 ⊂ admission-wire SEC-6a：并入
- review-fences-drain REVIEW-PERF-4 ≈ hotpath-fences-extra PERF-6：合并留一份
- PERF-4 timeout 计数 vs REVIEW-PERF-3b：合并重复半区
- 三份 perf spawn harness（bare-control/hotpath-runner/query-scenario）+ 5 份 patchTimers 复制：抽公共 helper
- parsers-redteam R3-1 vs runtime-redteam RT3-01（symlink index.html）：若 sink 复用 serveStatic 解析则合并（需核实）

## 五、断言过松 / 名实不符（改写或改名，不删）

- utils-anomalies:167-181 `[200,500]).toContain` 接受 200
- negotiation-matrix:200-209 cookie name 纯 not.toThrow
- error-mapper BUG-1 系列：名称说"306→302"，断言全是"被保留"（锁的是修复后行为），改名
- websocket.test:116-137 "no websocket config is emitted"：断言实为"dispatcher 总是安装"，改名或补晚注册用例
- lifecycle-drain:146 "fails loud" 实断言 200 透传，console.error spy 未检查
- lifecycle-adapters:151 close 到达 stopGraceful：fakeServe 无观测，名称未兑现
- native-sink.test:157-164 唯一断言 `stack.length > 0` 恒真
- hotpath-runner/error-storm 标题 "(<10%)" 实为 ×1.45 宽松 fence：改标题
- matcher-fuzz:101-107 "regardless of registration order" 只测了一种顺序
- evidence-budgets:126-148 硬编码私有槽位名前缀：改用已导出的 CONTEXT_SLOT_KEYS

## 六、锁内部实现（改写为行为断言）

- request-url.test.ts:26-27 `Object.keys(c)` 槽位顺序
- router-fastlayer-regressions:167-177 regex.source 布局（留行为半段）
- router-trie.test.ts:163-188 param/paramMore 结构断言（行为断言在 :172-175/184-187 已有）
- app-scoped-use:184 `globalMiddleware` 数组长度
- app-surface:40-72 直测内部 parseListenArgs（公共路径版同文件 :132-166 已有）
- core-contracts:90/104/115 白盒混装；pooling.test:342-347 deadProtoFor 白盒（公共路径 :271-295 已锁）
- commit-regressions:285 fastDynamic 差分两侧同实现（自证式，改独立期望）

## 七、明确不可删（防误删核实）

CONFIRMED-BUG/修复回归锁、安全红队绿锁、wire/传输层契约、CPU/内存 fence（PERF-1..8、error-storm 各内存 fence）、路由/响应性质不变量 fuzz、parity/hono 差分、skipIf(REAL_BUN) Node-lane 用例、status.test 协议值、entry-surface 精确导出锁、acceptsGzip 差分（有独立 parser 参考+锚定裁决）、GA-1b/2/3/4、per-file 500 行预算内大杂烩文件中的独有用例。

## 统计

- 182 文件 / 约 4800 用例；发现 165 项：无效 19、死代码 9 处、永久 skip 2、重复簇 28 组（涉及约 110 个用例副本）、松断言/名实不符 10、内部实现耦合 8。
- 高置信直接可删：约 45-55 个 it + 约 500 行死代码导出；合并后净删量估计 150+ 用例、1500+ 行。
- 覆盖率背景（coverage-summary.json，本次未重跑）：statements 95.25% / branches 91.09% / functions 95.94% / lines 97.08%，门禁 90%。删重复副本不影响门禁；删 coverage 类用例需跑覆盖率确认。

> 本报告为只读扫描结论。执行删除前应按报告逐项复核（尤其第四节合并项），每步删除后跑 `bun run test` + 覆盖率，任何失败即回退该项。
