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
test/parity/koa-fuzz-locks.test.ts
test/parity/koa.test.ts
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

共 106 文件 / 650 处

## M3 test/ 中读侧 getter/属性使用（c.body/.status/.type/.etag/.lastModified/.res 任意用法，含写路径行）

> 命令：grep -rlE 'c\.(body|status|type|etag|lastModified|res)' test/ --include='*.test.ts'
> 共 105 文件 / 686 处（U3c 实施时按文件逐条核销）

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
test/parity/koa-fuzz-locks.test.ts
test/parity/koa.test.ts
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
test/parity/koa-fuzz-locks.test.ts
test/parity/koa.test.ts
test/property/agent-r6-prop-inv7.mts
test/property/agent-r6-prop-ops.mts
test/property/rtc-fuzz-locks.test.ts
test/security/baseline-extended.test.ts
test/security/baseline.test.ts
test/security/parity-locks.test.ts
test/security/pipeline-redteam.test.ts
test/security/post-fix-locks.test.ts
test/unit/app-regressions.test.ts
test/unit/response-regressions.test.ts
test/unit/response.test.ts
test/unit/router-mount-regressions.test.ts
test/unit/router-trie-differential.test.ts
test/unit/surface-regressions.test.ts
```

redirect 共 22 文件 / 60 处；attachment 8 文件

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

## M8 test/ 中散落的 koa-parity 断言（U1 甄别清单）

```
test/middleware/auth.test.ts:44:    // koa parity: a null body on an error status falls back to the message.
test/unit/surface-regressions.test.ts:66:  it("matches Koa's redirect class exactly", () => {
test/security/parity-locks.test.ts:30:    // koa parity: the inference goes through the same expansion c.type
test/security/parity-locks.test.ts:57:  it("error responses hide 5xx messages; staged headers ride along (koa parity)", async () => {
test/security/router-abuse-locks.test.ts:143:  it("a group's use() middleware is prepended to every route — it must run before its param() middleware (koa parity)", async () => {
test/security/baseline-extended.test.ts:251:  it("open redirect scope: absolute external URLs are allowed (koa parity) but CRLF is not", async () => {
test/security/baseline-extended.test.ts:293:    // Decoding is intentional (koa parity); the capture stays a value, never
test/security/audit-locks.test.ts:235:  it("default unsigned read without keys keeps returning raw (koa parity)", () => {
test/property/rtc-fuzz-locks.test.ts:69:  it("locks: an explicit scheme:// target is the developer's absolute redirect (koa parity)", async () => {
test/property/invariants-response.test.ts:45:      // (koa parity) — emptiness is judged on the ACTUAL shipped status.
test/integration/concurrency.test.ts:10: * (file:line). "语义锁定" tests encode behavior that matches Koa (or a
test/integration/concurrency.test.ts:191:  it("语义锁定: a failed response keeps staged headers and set-cookie, drops the failed body (koa parity)", async () => {
test/integration/concurrency.test.ts:289: * (file:line). "语义锁定" tests encode behavior that matches Koa (or a
test/integration/error-mapper.test.ts:95:    // Decline ships both staged cookies (koa parity — staged headers ride).
test/integration/regression-sweep.test.ts:361:  it("locks: an explicit scheme:// target is the developer's absolute redirect (koa parity)", async () => {
test/parity/koa.test.ts:322:    // body (docs/KEALA-NATIVE-API.md §2.2 — the koa parity body is gone).
```
