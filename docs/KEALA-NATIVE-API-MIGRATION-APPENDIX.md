# 附录 M — 受影响面实录（grep 生成 2026-09-06，实施时随单元推进复核刷新）

## M1 test/ 中使用 .params（任意接收者，含 ?. 形态）的文件（U2 机械替换面——c.params 与 matchRoute/matchPattern 产物消费都在内）

> 命令：grep -rlE '\.params(\?\.)?\[' test/

```
test/integration/concurrency.test.ts
test/integration/context-lifecycle.test.ts
test/integration/lifecycle-contracts-strategy.test.ts
test/integration/lifecycle-ha-review-load.test.ts
test/integration/lifecycle-ha-review-shutdown.test.ts
test/integration/lifecycle-overload.test.ts
test/integration/lifecycle-review-signals.test.ts
test/integration/native-sink-parity.test.ts
test/integration/node-adapter.test.ts
test/integration/overload-failure-modes.test.ts
test/integration/pooling-wire.test.ts
test/integration/pooling.test.ts
test/middleware/cache.test.ts
test/middleware/coverage-topups.test.ts
test/middleware/upstream-hardening.test.ts
test/perf/evidence-budgets.test.ts
test/property/invariants-routing.test.ts
test/property/rtc-fuzz-locks.test.ts
test/security/admission.test.ts
test/security/component-redteam.test.ts
test/security/router-abuse-2.test.ts
test/security/router-abuse-locks.test.ts
test/security/router-abuse.test.ts
test/unit/app-pipeline.test.ts
test/unit/app-runtime-locks.test.ts
test/unit/app-scoped-use.test.ts
test/unit/app-surface.test.ts
test/unit/request-ergonomics.test.ts
test/unit/router-matching-locks.test.ts
test/unit/router-registration-locks.test.ts
test/unit/router-trie-differential.test.ts
test/unit/router-trie-fuzz.test.ts
test/unit/router-trie.test.ts
test/unit/router.test.ts
test/unit/surface-regressions.test.ts
```

共 35 文件 / 123 处

## M2 test/ 中使用 Koa 式响应 setter 赋值的文件（U3 改写/删除面）

> 命令：grep -rlE 'c\.(body|status|type|length|etag|lastModified) *= ' test/

```
test/integration/adapter-contracts-2.test.ts
test/integration/adapter-contracts.test.ts
test/integration/agent-r46-review-signal-child.ts
test/integration/bun-adapter.test.ts
test/integration/commit-audit.test.ts
test/integration/commit-contract.test.ts
test/integration/commit-fixes.test.ts
test/integration/commit-regressions.test.ts
test/integration/committed-headers.test.ts
test/integration/concurrency.test.ts
test/integration/context-lifecycle.test.ts
test/integration/error-mapper.test.ts
test/integration/ha-fixes.test.ts
test/integration/lifecycle-adapters.test.ts
test/integration/lifecycle-bug-locks.test.ts
test/integration/lifecycle-contracts-admission.test.ts
test/integration/lifecycle-contracts-close.test.ts
test/integration/lifecycle-contracts-deadline.test.ts
test/integration/lifecycle-contracts-strategy.test.ts
test/integration/lifecycle-drain.test.ts
test/integration/lifecycle-ha-review-load.test.ts
test/integration/lifecycle-ha-review-shutdown.test.ts
test/integration/lifecycle-overload.test.ts
test/integration/lifecycle-races.test.ts
test/integration/lifecycle-review-adapters.test.ts
test/integration/lifecycle-review-signals.test.ts
test/integration/lifecycle-timeout.test.ts
test/integration/lifecycle-wire-locks.test.ts
test/integration/mw-regressions.test.ts
test/integration/node-adapter.test.ts
test/integration/node-response-engine.test.ts
test/integration/overload-failure-modes.test.ts
test/integration/pipeline-regressions.test.ts
test/integration/pooling-guards.test.ts
test/integration/pooling-regressions.test.ts
test/integration/pooling-wire.test.ts
test/integration/pooling.test.ts
test/integration/regression-sweep.test.ts
test/integration/response-matrix.test.ts
test/integration/response-plan-hotpath.test.ts
test/integration/shutdown-ha.test.ts
test/integration/stream-cancellation.test.ts
test/integration/takeover-boundaries.test.ts
test/integration/takeover-contract.test.ts
test/middleware/body-parser-errors.test.ts
test/middleware/body-parser.test.ts
test/middleware/cache.test.ts
test/middleware/compress.test.ts
test/middleware/coverage-topups.test.ts
test/middleware/etag-compress.test.ts
test/middleware/redteam-components.test.ts
test/middleware/review-fixes.test.ts
test/middleware/secure-headers.test.ts
test/middleware/security-semantics.test.ts
test/middleware/server-parsers.test.ts
test/middleware/upstream-hardening.test.ts
test/parity/hono.test.ts
test/perf/hotpath-fences-extra.test.ts
test/perf/hotpath-fences.test.ts
test/perf/review-fences-drain.test.ts
test/perf/review-fences-timers.test.ts
test/perf/review-fences-waiters.test.ts
test/property/agent-r6-prop-inv7.mts
test/property/agent-r6-prop-ops.mts
test/property/invariants.test.ts
test/property/rtc-fuzz-locks.test.ts
test/security/admission-review-drain.test.ts
test/security/admission-review-queue.test.ts
test/security/admission-review-rejection.test.ts
test/security/admission-wire.test.ts
test/security/admission.test.ts
test/security/audit-locks.test.ts
test/security/baseline-extended.test.ts
test/security/baseline.test.ts
test/security/component-redteam.test.ts
test/security/error-disclosure.test.ts
test/security/middleware-redteam.test.ts
test/security/parity-locks.test.ts
test/security/pipeline-redteam.test.ts
test/security/post-fix-locks.test.ts
test/security/router-abuse-2.test.ts
test/security/router-abuse.test.ts
test/security/runtime-redteam.test.ts
test/unit/app-pipeline.test.ts
test/unit/app-regressions.test.ts
test/unit/app-runtime-locks.test.ts
test/unit/context-regressions.test.ts
test/unit/coverage-final.test.ts
test/unit/input-anomalies.test.ts
test/unit/matcher-fuzz.test.ts
test/unit/negotiation-coverage.test.ts
test/unit/negotiation-matrix.test.ts
test/unit/request-ergonomics.test.ts
test/unit/request.test.ts
test/unit/response-coverage.test.ts
test/unit/response-regressions.test.ts
test/unit/response-sugar-regressions.test.ts
test/unit/response.test.ts
test/unit/router-mount-regressions.test.ts
test/unit/router-trie-fuzz.test.ts
test/unit/router.test.ts
test/unit/streams.test.ts
test/unit/surface-regressions.test.ts
test/unit/utils-anomalies.test.ts
test/unit/utils.test.ts
```

共 105 文件 / 640 处（U1 删除 parity/koa\* 后 2026-09-06 重生成；U3c 核销矩阵）

## M3 test/ 中读侧 getter/属性使用（c.body/.status/.type/.etag/.lastModified/.res 任意用法，含写路径行）

> 命令：grep -rlE 'c\.(body|status|type|etag|lastModified|res)' test/ --include='*.test.ts'
> 共 104 文件 / 669 处（U1 删除 parity/koa\* 后 2026-09-06 重生成；U3c 实施时按文件逐条核销）

```
test/integration/adapter-contracts-2.test.ts
test/integration/adapter-contracts.test.ts
test/integration/bun-adapter.test.ts
test/integration/commit-audit.test.ts
test/integration/commit-contract.test.ts
test/integration/commit-fixes.test.ts
test/integration/commit-regressions.test.ts
test/integration/committed-headers.test.ts
test/integration/concurrency.test.ts
test/integration/context-lifecycle.test.ts
test/integration/error-mapper.test.ts
test/integration/error-policy.test.ts
test/integration/ha-fixes.test.ts
test/integration/lifecycle-adapters.test.ts
test/integration/lifecycle-bug-locks.test.ts
test/integration/lifecycle-contracts-admission.test.ts
test/integration/lifecycle-contracts-close.test.ts
test/integration/lifecycle-contracts-deadline.test.ts
test/integration/lifecycle-contracts-strategy.test.ts
test/integration/lifecycle-drain.test.ts
test/integration/lifecycle-ha-review-load.test.ts
test/integration/lifecycle-ha-review-shutdown.test.ts
test/integration/lifecycle-overload.test.ts
test/integration/lifecycle-races.test.ts
test/integration/lifecycle-review-adapters.test.ts
test/integration/lifecycle-review-signals.test.ts
test/integration/lifecycle-timeout.test.ts
test/integration/lifecycle-wire-locks.test.ts
test/integration/mw-regressions.test.ts
test/integration/native-sink-parity.test.ts
test/integration/node-adapter.test.ts
test/integration/node-response-engine.test.ts
test/integration/overload-failure-modes.test.ts
test/integration/pipeline-regressions.test.ts
test/integration/pooling-guards.test.ts
test/integration/pooling-regressions.test.ts
test/integration/pooling-wire.test.ts
test/integration/pooling.test.ts
test/integration/regression-sweep.test.ts
test/integration/response-matrix.test.ts
test/integration/response-plan-hotpath.test.ts
test/integration/shutdown-ha.test.ts
test/integration/stream-cancellation.test.ts
test/integration/takeover-boundaries.test.ts
test/integration/takeover-contract.test.ts
test/middleware/body-parser-errors.test.ts
test/middleware/body-parser.test.ts
test/middleware/cache.test.ts
test/middleware/compress.test.ts
test/middleware/coverage-topups.test.ts
test/middleware/etag-compress.test.ts
test/middleware/redteam-components.test.ts
test/middleware/review-fixes.test.ts
test/middleware/secure-headers.test.ts
test/middleware/security-semantics.test.ts
test/middleware/server-parsers.test.ts
test/middleware/upstream-hardening.test.ts
test/parity/hono.test.ts
test/perf/hotpath-fences-extra.test.ts
test/perf/hotpath-fences.test.ts
test/perf/review-fences-drain.test.ts
test/perf/review-fences-timers.test.ts
test/perf/review-fences-waiters.test.ts
test/property/invariants.test.ts
test/property/rtc-fuzz-locks.test.ts
test/security/admission-review-drain.test.ts
test/security/admission-review-queue.test.ts
test/security/admission-review-rejection.test.ts
test/security/admission-wire.test.ts
test/security/admission.test.ts
test/security/audit-locks.test.ts
test/security/baseline-extended.test.ts
test/security/baseline.test.ts
test/security/component-redteam.test.ts
test/security/error-disclosure.test.ts
test/security/middleware-redteam.test.ts
test/security/parity-locks.test.ts
test/security/pipeline-redteam.test.ts
test/security/post-fix-locks.test.ts
test/security/router-abuse-2.test.ts
test/security/router-abuse.test.ts
test/security/runtime-redteam.test.ts
test/unit/app-pipeline.test.ts
test/unit/app-regressions.test.ts
test/unit/app-runtime-locks.test.ts
test/unit/context-regressions.test.ts
test/unit/coverage-final.test.ts
test/unit/input-anomalies.test.ts
test/unit/matcher-fuzz.test.ts
test/unit/negotiation-coverage.test.ts
test/unit/negotiation-matrix.test.ts
test/unit/request-ergonomics.test.ts
test/unit/request.test.ts
test/unit/response-coverage.test.ts
test/unit/response-regressions.test.ts
test/unit/response-sugar-regressions.test.ts
test/unit/response.test.ts
test/unit/router-mount-regressions.test.ts
test/unit/router-trie-fuzz.test.ts
test/unit/router.test.ts
test/unit/streams.test.ts
test/unit/surface-regressions.test.ts
test/unit/utils-anomalies.test.ts
test/unit/utils.test.ts
```

## M4 c.redirect( / c.attachment( 调用文件（U3a）

```
test/integration/concurrency.test.ts
test/integration/error-mapper.test.ts
test/integration/regression-sweep.test.ts
test/integration/response-matrix.test.ts
test/middleware/security-semantics.test.ts
test/parity/hono.test.ts
test/property/agent-r6-prop-inv7.mts
test/property/agent-r6-prop-ops.mts
test/property/rtc-fuzz-locks.test.ts
test/security/baseline-extended.test.ts
test/security/baseline.test.ts
test/security/pipeline-redteam.test.ts
test/security/post-fix-locks.test.ts
test/unit/app-regressions.test.ts
test/unit/response-regressions.test.ts
test/unit/response.test.ts
test/unit/router-mount-regressions.test.ts
test/unit/router-trie-differential.test.ts
test/unit/surface-regressions.test.ts
```

redirect 共 19 文件 / 62 处；attachment 7 文件（U1 后 2026-09-06 重生成——parity/koa\* 已删、parity-locks 的 redirect 已迁出）

## M5 src/ 内部使用者（U2/U3 模块改写清单的权威来源）

```
-- c.params[ ：
（src/ 无；见 M6 的 bench/scripts 形态）
-- 响应 setter：
src/middleware/etag.ts:136:      c.status = 304;
src/middleware/etag.ts:137:      c.body = null;
src/middleware/cors.ts:84:        c.status = 403;
src/middleware/cors.ts:95:      c.status = 204;
src/middleware/cors.ts:105:      c.status = 403;
src/middleware/metrics.ts:157:    c.body = registry.text();
src/middleware/auth.ts:84:      c.status = 401;
src/middleware/auth.ts:134:      c.status = 401;
src/middleware/auth.ts:139:      c.status = 401;
src/core/error-response.ts:389:  c.status = error.status;
src/core/error-response.ts:393:  c.body = message;
src/index.ts:20: * app.get("/page", (c) => { c.body = "hi"; c.type = "text/html" }) // state style
-- c.redirect() void 调用：
src/core/context/context.ts:106:        `c.throw() expects a 4xx/5xx error status, got ${status} — redirect with c.redirect(url[, code]) or return a Response; informational and success statuses are not errors`,
src/core/registration.ts:82:        c.redirect(target, code);
src/types.ts:154:   * `c.origin`/`c.href`/`c.redirect(back)` and password-reset style flows.
src/router/group.ts:184:        c.redirect(target, code);
-- 读侧 getter（metrics/logger/观察者）：
src/middleware/headers.ts:107:        `${c.method} ${c.path} -> ${c.status} ${Math.round(performance.now() - start)}ms ${id}`,
src/middleware/metrics.ts:125:      registry.observe(c.status, Date.now() - startedAt);
src/core/context/sugar.ts:181:  // An explicitly staged c.status wins over the default (hono parity).
src/core/context/response.ts:4: * State mode: handlers write `c.status / c.body / c.setHeader(...)`; the
src/core/context/response.ts:11: * handler-returned Response), `c.body`/`c.status`/`c.redirect` throw —
src/core/respond.ts:88:  // Post-next observers (logging, metrics by exact code) read c.status —
src/core/registration.ts:66:    // EVERY request (the c.status setter throws).
```

## M6 bench/examples/scripts 消费方（随所属单元机械同步）

```
-- c.params[ ：
bench/compare-hono-hotpaths.ts
bench/route-shootout/diag/count-split-calls.ts
bench/route-shootout/diag/keala-bun-prof.ts
bench/route-shootout/diag/profile-loop.ts
bench/route-shootout/servers/keala-bun.ts
bench/route-shootout/servers/keala-node.ts
bench/server-keala-node.ts
bench/server-keala.ts
bench/verify-hotpaths.ts
examples/app-node.ts
examples/app.ts
-- 响应 setter：
bench/lifecycle-overhead.ts
bench/server-keala-node.ts
bench/server-keala.ts
bench/verify-baseline.ts
examples/app-node.ts
examples/app.ts
scripts/drain-server-node.mjs
scripts/drain-server.ts
scripts/smoke.ts
scripts/soak-node.ts
scripts/soak.ts
```

## M7 双命中文件（同时命中 M1 与 M2，两个单元都要过，防漏改标记）

```
test/integration/concurrency.test.ts
test/integration/context-lifecycle.test.ts
test/integration/lifecycle-contracts-strategy.test.ts
test/integration/lifecycle-ha-review-load.test.ts
test/integration/lifecycle-ha-review-shutdown.test.ts
test/integration/lifecycle-overload.test.ts
test/integration/lifecycle-review-signals.test.ts
test/integration/node-adapter.test.ts
test/integration/overload-failure-modes.test.ts
test/integration/pooling-wire.test.ts
test/integration/pooling.test.ts
test/middleware/cache.test.ts
test/middleware/coverage-topups.test.ts
test/middleware/upstream-hardening.test.ts
test/property/rtc-fuzz-locks.test.ts
test/security/admission.test.ts
test/security/router-abuse-2.test.ts
test/security/router-abuse.test.ts
test/unit/app-pipeline.test.ts
test/unit/app-runtime-locks.test.ts
test/unit/router-trie-fuzz.test.ts
test/unit/router.test.ts
test/unit/surface-regressions.test.ts
```

共 23 文件

## M8 test/ 中散落的 koa-parity 断言（U1 甄别清单 — **已处置 2026-09-06**）

> 甄别结论：12+1 个点位**无一为"仅为对齐 koa 而存在"的独立用例**——全部是 keala
> 行为锁，仅注释/标题带 koa 出处。处置：测试本体全保，措辞从"契约主张"降级为
> 历史出处或删除；唯一例外 auth.test.ts:44 标注为 U3b 锚点。

处置明细（U1 实施记录）：

| 点位                                                                                                                                                              | 处置                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| parity/koa.test.ts（386 行 / 17 用例，驱动真 koa 的差分审计）                                                                                                     | **删除**；其中 9 项唯一行为锁已回迁 keala 原生断言（见下）                                                                                                               |
| parity/koa-fuzz-locks.test.ts（327 行 / 16 用例）                                                                                                                 | **删除**；种子模糊 vs 参照包行随包退役（escapeHtml/encodeUrl/accepts 核心行为在存活文件有值级锁，扩展字符集/透传已回迁）                                                 |
| parity/agent-r6-diff-koa.deps.d.ts                                                                                                                                | **删除**；negotiator 声明（regression-sweep 唯一消费者）移至 test/integration/regression-sweep.deps.d.ts                                                                 |
| security/parity-locks.test.ts                                                                                                                                     | 三类拆分：错误类 4 条→error-disclosure；redirect 1 条→baseline-extended；c.URL 1 条→request-ergonomics；**setter 语义 4 条留存原文件（U3c 随 setter 删除，文件头注明）** |
| auth.test.ts:44（401 body 回退）                                                                                                                                  | **保留**，标注 U3b 行为等价锚点（basicAuth return 化必须字节等价）                                                                                                       |
| surface-regressions / router-abuse-locks / audit-locks / baseline-extended ×2 / rtc-fuzz / invariants-response / concurrency ×3 / error-mapper / regression-sweep | 测试保留，"(koa parity)" 措辞删除或降级为历史出处                                                                                                                        |
| errors-surface.test.ts:102（M8 grep 漏网点，甄别时补获）                                                                                                          | 测试保留（R7-QUERY-1 查询恢复 bug 锁），标题/注释去 Koa 框架                                                                                                             |

唯一锁回迁清单（验证子代理逐条 grep 核实 22 项行为后确认的 9 项，其余 13 项在存活文件已有等价锁）：

| 原差分行为                                                   | 回迁落点                                          |
| ------------------------------------------------------------ | ------------------------------------------------- |
| `typeIs(ct, ["*/*"])` 返回原始类型（函数级+ctx 级）          | unit/typeis + unit/request                        |
| redirect 转义四子句（裸 `%`/`%zz`/`'`/`{}`）+ 安全字符集透传 | security/post-fix-locks（RT-F10 节）              |
| contentDisposition ASCII 名 + 显式字符串 fallback            | unit/response-sugar-regressions                   |
| `.bin` → application/octet-stream                            | unit/utils（expandContentType 层，越过 U3c 存活） |
| escapeHtml 非 ASCII/控制字节透传                             | unit/utils                                        |
| 外域中和精确形态 `/%2Fevil.com`、`https%3A%2Fevil.com`       | property/rtc-fuzz-locks                           |
| parseCookies 裸 token → `{name:""}`                          | middleware/review-fixes（表格行）                 |
| Allow 顺序与注册顺序无关                                     | unit/router                                       |

grep 复核（U1 后 `grep -rn "koa parity\|Koa's\|matches Koa" test/`）：仅剩
4 处均为新写的"迁自退役套件（U1）"出处注记 + U3b 锚点注记，无契约主张残留。
