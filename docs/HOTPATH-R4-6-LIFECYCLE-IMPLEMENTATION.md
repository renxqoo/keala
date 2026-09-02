# R4.6 — 生命周期与过载控制施工图（IMPLEMENTATION）

> 状态：草稿（依赖审计证据，随实施推进收口）
> 设计基线：[HOTPATH-R4-6-LIFECYCLE-DESIGN.md](./HOTPATH-R4-6-LIFECYCLE-DESIGN.md)
> 迁移规格：[HOTPATH-R4-6-MIGRATION-LIFECYCLE.md](./HOTPATH-R4-6-MIGRATION-LIFECYCLE.md)

## 1. 审计结论

### 1.1 旧实现审计（`codex/hotpath-r4-4-lifecycle`，四条标准）

旧实现自身已经过 5 子 agent 多角度评审（bugs/contract/security/perf/HA，红测纪律，69 假设 → 8 确认缺陷全修），审计结论：**逻辑正确性可信，契约符合度高，热路径纪律达标**。引用其迁移文档 §8.3，本轮不重复抄写。8 个缺陷（holdBody 双释放、二次 SIGTERM 死代码、定时器武装顺序、Infinity 钳位、drain:0 空载不死、pooling 504 僵尸回收、Node keep-alive 违背 503 声明、嵌入式定时器 unref 不清除）**全部携带回归锁迁移**——它们几乎必然在重接线时复发。

旧实现遗留问题（本轮修复项）：

| # | 问题 | 级别 | 本轮处置 |
| --- | --- | --- | --- |
| A1 | deadline 每请求 2 闭包（settleOnce + releaseOnce） | 性能 | U2：单一 once 状态对象 |
| A2 | 排队 waiter 每请求新建三件套（waiter+Promise+closure） | 性能 | U3：waiter 槽池化 |
| A3 | lifecycle.ts 475 行 + 本轮策略层 → 超行数预算 | 结构 | §3 拆分 |
| A4 | 准入策略硬编码在 admitRequest 内（fail fast/队列由 maxQueue 隐式分叉） | 契约 | U1：AdmissionStrategy 抽取 |

### 1.2 R4.5 引擎差异审计（本轮核心新证据）

R4.5 相对 r4-4 的 fork 基点（`68ab4b6`）重写了 lifecycle 的全部接线面：

| # | 差异 | 证据 | 影响 |
| --- | --- | --- | --- |
| S1 | settle 形状：R4.5 `settleNativeHandle(pool, pooling, c, settled)` 4 参（dispatch.ts:185）vs r4-4 `settleHandle` 5 参（含 release 回调） | 已核实 | C2 槽位要重开 |
| S2 | node.ts 重写 431 行：native request source、`bytes(limit)` 限界读取、`cleanupUnread`；无 wire 计数、无 abort 桥、无 stopGraceful | 已核实 | 适配器侧整体重做；drain×bytes、drain×cleanupUnread 是全新接缝 |
| S3 | 新增 response-plan.ts（committed headers 能力位打包进 flags） | 已核实 | holdBody 重包装 Response 的顺序需要显式契约（DESIGN §8 S3） |
| S4 | `NativeRequestSource` 无 signal 通道（request-source.ts:11-23） | 已核实 | 队列 abort 需要 source 级 abort 通道（DESIGN §6 裁决） |
| S5 | R4.5 shape-lazy `declare` 字段纪律（body-parser 为范例） | 已核实 | C3 三槽必须同纪律 |
| S6 | bun.ts 结构基本未动（stop/reload 仍在原位），sink.ts 有小幅重构 | 已核实 | openSockets + stopGraceful 可低成本复制 |

已核实兼容项（review 轮补录，无需动作）：`FLAG_DEADLINE_FIRED = 16384` 全仓空闲（现有 flag 最高 8192）；`errorResponse(app, c, err)` 签名与 r4-4 raceDeadline 的调用形状一致（error-response.ts:351）。

## 2. 逐模块裁决表

| 旧文件（r4-4 分支） | 规模 | 裁决 | 审计状态 | 动作 |
| --- | --- | --- | --- | --- |
| `src/core/lifecycle.ts` | 475 行 | **重构** | 已审计（A1–A4） | 按拆分决策 §3 重组 + U1/U2/U3 升级；状态机/闸/close/桥/race 的逻辑主体保留 |
| `src/core/server-slot.ts` | 15 行 | **复制** | 已审计无可挑剔 | 原样 |
| `src/core/context/state.ts` 三槽 | +20 行 | **复制** | 已审计 | FLAG_DEADLINE_FIRED=16384 已核实空闲；shape-lazy 化（S5） |
| `src/core/app.ts` 接线（准入/#serve/settle/close/isDraining/inFlight/listen signals） | +90 行 | **重写** | — | 打在 R4.5 新入口 `[HANDLE_REQUEST_SOURCE]` 与 `settleNativeHandle` 上（S1） |
| `src/core/dispatch.ts` settleHandle 5 参 | +30 行 | **重写** | — | 改造 `settleNativeHandle`：加可选 release 槽，非 lifecycle 应用零成本 |
| `src/adapters/node.ts` stopGraceful + wire 计数 + abort 桥 | +129 行 | **重写** | — | 在 R4.5 重写后的 node.ts 上重做（S2）；新增 drain×bytes、drain×cleanupUnread 红测；重加 `listen()` options 形态与 signals 解析（R4.5 仅位置参数形态，node.ts:490；r4-4 测试断言 options 形态注册信号桥） |
| `src/adapters/bun.ts` openSockets + stopGraceful | +61 行 | **复制+微修** | 已审计（S6） | R4.5 bun.ts 变化小 |
| `src/core/request-source.ts` | — | **复制+微修** | — | NativeRequestSource 增 lazy abort 通道（S4，DESIGN §6 裁决） |
| `src/types.ts`（OverloadOptions/CloseOptions/CloseStatus/signals） | +54 行 | **复制+微修** | — | + `AdmissionStrategy` 类型（U1） |
| `src/core/listen.ts` signals 解析 | +2 行 | **复制** | — | parseListenArgs 加一行 |
| `scripts/drain-server-{node,bun}.*`、`scripts/drain-verify.ts` | ~280 行 | **复制** | 已审计 | 验收装置原样复用 |
| `bench/lifecycle-overhead.ts` | — | **复制+微修** | — | 基准口径不变，加配置路径三条预算断言（DESIGN §7.2） |
| 14 个测试文件（117 用例） | ~3800 行 | 矩阵见 MIGRATION §5 | — | 移植/改写/删除逐条登记 |

**不移植清单**：无（r4-4 全部能力入迁）。r4-4 附带的 app.ts 行数预算重构（mount/ws/param 外提）**不迁移**——R4.5 已用自己的方式重构过 app.ts，属重复工作，后果为零。

## 3. 拆分决策

```
src/core/lifecycle.ts          # 状态机：LifecycleState、计数、admit 闸、settle/release、
                               # closeApp、信号桥（≈300 行，r4-4 主体保留）
src/core/lifecycle-admission.ts # U1/U3：AdmissionStrategy 协议 + failFast/queue 内置策略
                               # + waiter 池 + normalizeOverload（≈200 行）
src/core/lifecycle-deadline.ts  # U2：raceDeadline + once 状态对象（≈90 行，从 lifecycle.ts 拆出）
src/core/server-slot.ts         # 15 行原样
```

理由：A3 行数预算（一动词一文件：admission 与 deadline 是两个动词）；waiter 池（U3）与策略协议（U1）内聚在 admission；raceDeadline 依赖 context 三槽与错误漏斗，独立成文件便于红测定位。`rejectResponse`（拒绝样式）随 admission；`holdBody` 留在 lifecycle.ts（drain 语义的一部分）。

## 4. 测试计划

1. **行为规格 = 旧测试**：117 用例按 MIGRATION §5 矩阵迁移，任何改写登记理由；
2. **8 个 r4-4 缺陷的回归锁全部携带**（agent-r44-bugs*.test.ts，用例名含 FINDING-N/CT-N 编号）；
3. **每条接缝风险一个红测**：S1 release 恰一次；S2 drain×bytes 中止、drain×cleanupUnread、stopGraceful 后 wire 清零；S3 holdBody×committed-headers；S4 native 排队断开出队；S5 既有 perf fence 全量回归；
4. **U1–U3 各一组新用例**：策略注入行为、once 状态对象、waiter 池稳态零分配（allocation 计数锁）；
5. **契约级**：CloseStatus 判别联合穷举、OverloadReason 三值封闭、事件恰好一次（§2.3 时序表逐行）；
6. **覆盖率**：维持仓库基线 `97.15/91.89/96.03/98.53`（statements/branches/functions/lines）只升不降；
7. **e2e**：drain-verify（真实进程 SIGTERM，Node/Bun 双运行时）进默认门；双形态（源码/构建产物）进程冒烟。

## 5. 实施顺序（每阶段独立提交、四门全绿才算完成）

| 阶段 | 交付 | 验收点 |
| --- | --- | --- |
| 0 | 三件套文档定稿 | 本文 + DESIGN + MIGRATION 定稿 |
| 1 | 核心基座：C1–C6 槽位（context 三槽、准入槽、settle 槽、server-slot、types、listen signals） | 未配置 <5ns 基准绿；**既有全量测试零回归**（槽位对未配置应用零行为变化） |
| 2 | close/drain：closeApp + Node stopGraceful（wire 计数 + abort 桥）+ Bun stopGraceful（openSockets/1001） + holdBody | r4-lifecycle-drain/adapters 矩阵绿 + S2/S3 红测绿 + drain-verify 单运行时过 |
| 3 | overload：admission 拆分文件 + U1 策略协议 + U3 waiter 池 | r4-lifecycle-overload 矩阵绿 + agent-r44 contract/security 矩阵绿 + U1/U3 新用例绿 |
| 4 | deadline：C3 生效 + U2 once 对象 + raceDeadline + c.signal 物化（含 S4 native abort 通道） | r4-lifecycle-timeout 矩阵绿 + agent-r44 bugs 矩阵绿（8 缺陷锁全过）+ S4 红测绿 |
| 5 | 信号桥 + 验收装置 + 基准收口 | drain-verify 双运行时 + 双形态冒烟 + lifecycle-overhead 全预算断言 + 覆盖率数字如实报告 |

阶段 1 是风险隔离设计：**只开槽、不装机制**，若全量回归在此失败说明槽位设计破坏了 R4.5 不变式，立即回滚成本最低。

## 6. 实施纪律

- 每提交引用本文与 DESIGN 的节号；发现文档有误：同提交先改文档；
- 零兼容层：不留 r4-4 旧路径别名；`settleHandle`（r4-4 名）不复活，统一 `settleNativeHandle`；
- 并行开发：只提交本单元点名的文件；四门数字如实报告；
- 热路径插桩（打点计时）必须逐行撤干净，grep 验证。
