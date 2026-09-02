# R4.6 — 生命周期与过载控制迁移文档（MIGRATION）

> 状态：草稿（矩阵待阶段收口逐条核销）
> 迁移单元：服务器生命周期与过载控制（三个垂直旅程：SIGTERM 优雅停机 / 过载拒流与排队 / 期限 504 与协作取消）
> 旧实现：分支 `codex/hotpath-r4-4-lifecycle`（4 提交，~6400 行插入；src 13 文件 + 测试 14 文件 117 用例 + drain-verify 装置）
> 目标位置：`codex/r4-6-lifecycle-overload`（基于 R4.5 运行时引擎）
> 关联：[DESIGN](./HOTPATH-R4-6-LIFECYCLE-DESIGN.md)（契约与升级点 U1–U3）· [IMPLEMENTATION](./HOTPATH-R4-6-LIFECYCLE-IMPLEMENTATION.md)（审计 S1–S6、阶段划分）

## 1. 行为规格基线（旧测试清单 = 行为等价判定标准）

| 旧文件 | 用例数 | 测什么 |
| --- | ---: | --- |
| r4-lifecycle-drain.test.ts | 16 | drain 全语义：嵌入式/handle 模式清空、drain:0 强停、超时上报、幂等、listen 后置拒绝、body-hold（正常/锁体/错误/取消）、Node 线上真值（真实 HTTP） |
| r4-lifecycle-overload.test.ts | 14 | fail fast 503 形状、Retry-After 开关、pre-context、handler 定制与抛错回退、FIFO、满队、排队超时、排队断开出队、drain 清队、槽位移交不过量准入、预中止/畸形排队项 |
| r4-lifecycle-timeout.test.ts | 12 | 504 经漏斗、mapper 改形状、快请求胜出无泄漏、流式被截断答 504、pooling 僵尸不回收、无 unhandledRejection、参数校验、c.signal 组合（期限/断开/迟到物化/lazy/Node 桥接） |
| r4-lifecycle-adapters.test.ts | 13 | Bun stopGraceful（1001 送客/强停/已结算）、信号桥（双信号语义、options 形态注册、未开不注册）、closeApp 容错（stopGraceful 拒绝/stop 抛错/Infinity 等计数/raceDeadline 收容） |
| agent-r44-bugs(+-2).test.ts | 14 | **8 缺陷回归锁**：FINDING-1 真实线上双释放、定时器武装顺序、Infinity 钳位、二次信号死代码、pooling×期限、waiter 边界、期限×drain、abort 状态回收（VERIFIED-OK 锁锁定既有正确行为） |
| agent-r44-contract(+-2).test.ts | 13 | CT-1..12：契约逐条 vs 规则表（升级语义、结算/流送不对称口径、504 释放与僵尸不双释、null 体僵尸不回收、回退定时器持循环、Bun/Node 已结算定时器泄漏、K8s 与网关示例可运行、handle 永不 reject） |
| agent-r44-ha(+-2).test.ts | 11 | HA-1..12：取消 mid-pull 计数恰 0、线上断开快停、敌意线上有界、完成 close 后惰性、过载洪峰零槽泄漏、期限风暴恰一次 504、abort 桥 finish 后不误触、双 SIGTERM、信号桥与用户 handler 共存、ws 全送 1001 |
| agent-r44-perf(+-2).test.ts | 8 | PERF-1..9：未配置 ~460ns 地板、过载增量噪声级、期限增量 timer 级、定时器纪律（未配置 0/req）、c.signal 零分配 lazy、waiter 一定时器一听讲器且准入即释放、shift 摊平、内存平台 |
| agent-r44-security(+-2).test.ts | 16 | SEC-1..9：拒绝完整性（固定头集/无请求数据/handler 回退）、pre-context 旁路、排队 abort 自限、洪水后队列卫生、恶意慢读者不能楔死停机、Connection: close 注入 vs handler 头、流水线、信号不可被请求合成、504 无泄漏 |

**删除的用例：无。**（r4-4 的全部行为入迁；`it.skipIf(Bun)` 的 Node-only 用例保留原条件跳过。）

## 2. 审计结论引用

旧实现四条标准审计与 8 缺陷修复史：IMPLEMENTATION §1.1（A1–A4 为本轮修复项）。R4.5 引擎差异 S1–S6：IMPLEMENTATION §1.2。不重复抄写。

## 3. 逐模块裁决表

见 IMPLEMENTATION §2（复制/重构/重写/复制+微修逐文件），此处不重复定义。

## 4. API 对照表

| 旧签名（r4-4） | 新签名（R4.6） | 变化理由 |
| --- | --- | --- |
| `app.close(options?) / isDraining() / inFlight` | 不变 | 行为等价 |
| `new Keala({ overload: {...}, requestTimeout })` | 不变，`overload` 增加可选 `strategy?: AdmissionStrategy` | 升级点 U1（用户裁决 D2）；未注入行为逐字节等于旧实现 |
| `listen({ signals: true })`（Bun 与 Node options 形态） | 不变 | 行为等价 |
| `c.signal`（lazy AbortSignal，组合断开 ∨ 期限） | 不变 | 行为等价；native source 侧经 S4 新增 abort 通道实现（内部） |
| `overload.handler(request, reason)` | 不变 | 拒绝样式定制点保留 |
| 内部 `settleHandle(pool, pooling, c, dispatch, release)` | `settleNativeHandle` 增可选 `release` 槽 | S1；非公开 API，零兼容层（r4-4 名不复活） |
| 内部 `NativeRequestSource` | 增 lazy `abort()` 通道 | S4（DESIGN §6 裁决）；公开 `RequestSource` 语义不变 |

## 5. 测试迁移矩阵

| 旧测试 | 新去处 | 动作 |
| --- | --- | --- |
| r4-lifecycle-drain（handle 模式 11 例） | `test/r4-lifecycle-drain.test.ts` | **移植**（零改写预期） |
| r4-lifecycle-drain（Node wire truth 4 例 + c.signal 1 例） | 同上 | **改写**：Node 启动/断开桥适配 R4.5 node.ts 新 API；断言语义零漂移 |
| r4-lifecycle-overload（14 例） | `test/r4-lifecycle-overload.test.ts` | **移植**；排队断开组新增 native-source 变体（S4 红测，矩阵外新增） |
| r4-lifecycle-timeout（12 例） | `test/r4-lifecycle-timeout.test.ts` | **移植**；Node 桥接 1 例改写同上 |
| r4-lifecycle-adapters（13 例） | `test/r4-lifecycle-adapters.test.ts` | **移植**；Node listen options 注册 1 例改写适配 |
| agent-r44-bugs / bugs-2（14 例） | `test/agent-r46-bugs*.test.ts` | **移植**；FINDING-1 真实线上组改写适配新 Node 装置；编号与症状名保留 |
| agent-r44-contract / -2（13 例） | `test/agent-r46-contract*.test.ts` | **移植**；用例名中 §节号引用改为本文 §1 对应行（装置适配，非断言变更） |
| agent-r44-ha / -2（11 例） | `test/agent-r46-ha*.test.ts` | **移植**；wire 相关（HA-2/6/10）改写适配 |
| agent-r44-perf / -2（8 例） | `test/agent-r46-perf*.test.ts` | **改写**：PERF-1 绝对地板在 R4.6 分支**重新定标**（R4.5 引擎已改变 floor，登记装置适配，非放水）；PERF-2/3 增量阈值维持；PERF-7/8 按 U3 池化语义更新断言（池化后 waiter 复用，语义收紧）；新增 waiter 池稳态零分配锁 |
| agent-r44-security / -2（16 例） | `test/agent-r46-security*.test.ts` | **移植**；SEC-6/7 Node wire 组改写适配 |
| **新增（矩阵外）** | S1 release 恰一次；S2 drain×bytes 中止、drain×cleanupUnread、stopGraceful 后 wire 清零；S3 holdBody×committed-headers；S4 native 排队断开；U1 策略注入行为组 | IMPLEMENTATION §4 第 3/4 条 |

## 6. 回滚方案

每阶段（IMPLEMENTATION §5 的 1–5）独立提交、独立可 revert；纯库代码与测试，**无 schema 变更，回滚无数据动作**。阶段 1 特意设计为"只开槽不装机制"——若全量回归在此失败，revert 单提交即回到干净的 R4.5。

## 7. 验收清单（全部满足才算完成）

- [x] 四门全绿：typecheck / lint 0-0 / build / test（Node 与 Bun 双运行时；2150+ 通过，Bun 门由 test:bun 承接）
- [x] 覆盖率 ≥ 仓库基线 `97.15/91.89/96.03/98.53`（statements/branches/functions/lines），如实报告：实测 97.15/92.05/96.16/98.71
- [x] §1 基线 117 用例矩阵逐条核销（16+14+12+13+14+13+11+8+16 = 117，改写理由见 §5 与 §8 装置适配清单）
- [x] 8 缺陷回归锁全过（agent-r46-bugs/-2 移植即绿）
- [x] 接缝红测全绿：S1（release 恰一次，bugs 矩阵）、S2（drain×bytes / drain×cleanupUnread / 强停后新连接拒绝）、S3（holdBody×committed-headers）、S4（native 排队断开出队 + c.signal 断开桥）、S5（既有 perf fence 全量回归）
- [x] U1–U3 新用例全绿（策略注入行为组 / once 守卫 / waiter 池零构造锁）
- [x] `drain-verify` 真实 SIGTERM 验收：Node 与 Bun 双运行时过（已入默认 verify 门）
- [x] 双形态进程冒烟：drain-verify 的 Bun 子进程跑源码形态、Node 子进程跑 dist 构建产物形态，探针 + 全链请求 + 优雅停机退出码 0
- [x] `lifecycle-overhead` 基准：未配置增量 +1ns（A/B 实测，预算 <5ns）；§7.2 三条预算（稳态噪声级 / waiter 池零构造 / 期限 timer 级）全过
- [x] 挂账项显式：per-route 差异化预算、熔断/重试、压力式准入、AIMD（DESIGN §3.2）

## 8. 实施记录

### 第一波（全部 5 阶段，2026-09-03 收口）

**交付物**（每阶段独立提交、四门全绿）：P1 槽位（`82045aa`）→ P2 close/drain（`f4e846f`）→ P3 overload/U1/U3（`4cde5af`）→ P4 deadline/U2/c.signal（`e8af65d`）→ P5 矩阵+验收（`58c275e` 等）。新增文件：`lifecycle.ts`（状态机）/`lifecycle-admission.ts`（闸+策略+waiter 池）/`lifecycle-deadline.ts`（期限竞速）/`server-slot.ts`/`node-source.ts`（NodeRequestSource 拆分 + S4 abort 通道）/`registration.ts`（ws/mount 注册体提取，500 行 lint 预算）。

**门禁数字**：typecheck 0 错误 / lint 43 警告 0 错误（与基线持平，新增 0）/ build 通过 / vitest 2150+ 通过 8 跳过 / 覆盖率 **97.15 / 92.05 / 96.16 / 98.71**（基线 97.15/91.89/96.03/98.53，四项全达标）/ `drain-verify` 双运行时 PASS（0 丢请求，drain {timedOut:false}，退出码 0）。

**基准（A/B vs R4.5 @ 3c4347f，同 bench 双跑）**：未配置 plain p50 **416→417ns（+1ns，预算 <5ns 达标）**；快速路径探针 1.96ns/op；overload 稳态 417ns（噪声级）；timeout 配置 583ns（+167ns = 1 unref timer + 竞速，opt-in）；排队全周期 1542ns（waiter 池化，稳态零构造——U3 结构锁独立锁定）。

**实施期裁决补录**：
- U1 协议实施形态演进（DESIGN §4 已同步）：策略收物化 Request + `admit()` 回调（同步占槽）；核心对未占槽 null 在同步点/决议微任务点补占；drain 翻转后未占槽 null 拒绝、已占槽照常服务；策略 rejection 容器化为内建 503。
- C2 僵尸守卫从构造期改为 settle 期判定（P4 红测发现构造期检查是死逻辑——flag 只能在 dispatch 挂起后翻转）。
- node.ts 超 500 行预算 → `node-source.ts` 拆分；app.ts 同因 → `registration.ts`。

**实施期发现并修复的真实缺陷**（全部先红测后修）：
1. 异步策略 null 未占槽即服务，settle 反释放他人槽位（计数器塌方）——admit() 协议修复（P3）。
2. 僵尸 settle 双重释放（inFlight → -1）——守卫移入释放链（P4）。

**装置适配清单**（断言语义零漂移）：abortValue 哨兵 null→undefined（shape-lazy 槽位纪律）；SEC-7a 顺序断言改分帧无关（R4.5 已知长度体不再 chunked 收尾）；PERF-1 绝对地板以 A/B 基准重定标；ws/mount 测试导入路径改 registration.ts。

**显式挂账**：per-route 差异化预算、熔断/重试、压力式准入（Envoy 型）、AIMD 自适应（tower 型）——见 DESIGN §3.2（U1 策略生态为承载缝）。

**多 agent 红测 review**（5 个独立 agent，只写红测不改业务代码；产出 91 个新测试）：
- perf 6/6 预算达标（结构性围栏：未配置零 AbortController/零定时器/Response 恒等、waiter 五离队路径定时器 1:1:1、期限 1 timer 恰一次 504、holdBody 恰一次包装、全局定时器收支平衡、拒绝路径零池交互）。
- HA 8/8 场景守住（含 wire 断开风暴×drain×pooling 组合、双信号强停、升级风暴）。
- **确认缺陷 7 项（终审全部按最优方案修复，红测转绿）**：
  1. REVIEW-BUG-1/CT-43（双 agent 独立确认，r4-4 继承）：信号桥 `process.once` 二次同名信号落到 OS 默认处置——改永久监听器，`fired` 承担 once 语义。
  2. REVIEW-SEC-15（P1 DoS）：P3 策略物化使内置队列订阅惰性 signal——协议 v3 追加 `source` 参数，队列经原生通道驱逐失联排队者。
  3. REVIEW-CT-34：策略同步 throw 逃出 `app.handle`——onSaturated 全包裹容器化。
  4. REVIEW-SEC-3/4：策略垃圾返回值 throw、undefined 决议穿透——decision/wake 全形状校验回落 503。
  5. REVIEW-SEC-17：未启写的流水线响应在 socket 死亡时不发 res close（wire 幻影计数拖满 drain 窗）——socket 级 close 结算，keep-alive 复用零监听器堆积。
  6. REVIEW-BUG-9：drain 期迟到 keep-alive 请求的零交叉不再唤醒 waiter（bogus timedOut:true）——waiter 常驻至 close 完成，每次零交叉重跑 trySettle（done 守卫幂等）。
  7. REVIEW-BUG-11：close 完成后 escalate 仍可重触发第三方 force——finish 清空 escalate + running 判空。
- 附带收紧：预中止排队者免创建定时器（arm 先查 aborted 再武装）；测试装置适配（信号桥 spy once→on、CloseStatus 形状断言）。
