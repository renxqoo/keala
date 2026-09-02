# R4.6 — 生命周期与过载控制设计基线（DESIGN）

> 状态：草稿（三件套之一；实施前必须定稿）
> 工作分支：`codex/r4-6-lifecycle-overload`（基于 `codex/r4-5-runtime-engine-rewrite`）
> 规格来源：`codex/hotpath-r4-4-lifecycle` 分支的契约与其 117 个测试用例
> 关联文档：[IMPLEMENTATION](./HOTPATH-R4-6-LIFECYCLE-IMPLEMENTATION.md) · [MIGRATION](./HOTPATH-R4-6-MIGRATION-LIFECYCLE.md) · 总纲 [HOTPATH-R4-DESIGN.md](./HOTPATH-R4-DESIGN.md) §6.6

## 1. 定位与范围

R4.6 在 R4.5 运行时引擎上重建 R4.4-lifecycle 定义的服务器生命周期与过载控制能力组：
**优雅停机（drain）、过载准入（admission/queue）、请求截止时间（deadline）、协作式取消（`c.signal`）、SIGTERM/SIGINT 信号桥**。全部 opt-in；未配置应用热路径近零成本。

本轮不是从零设计：r4-4-lifecycle 分支已交付完整行为契约（迁移文档 §2 的规则表）、8 个已修缺陷的回归锁与 SIGTERM 真实进程验收装置。R4.6 的工作 = **行为等价迁移到新引擎 + 三个显式登记的契约升级点**。

### 用户裁决（2026-09-03）

| # | 裁决 | 内容 |
| --- | --- | --- |
| D1 | 规格基准 | **行为等价 + 显式升级点**：r4-4 契约为基线，测试矩阵逐条对照；少数演进点在本文 §4 显式登记，逐条落档理由与行为差异 |
| D2 | 可插拔架构 | **机制烤进核心、策略可插拔**：计数器/准入槽/结算槽/适配器契约为不可拔基座（零配置零成本）；准入策略、拒绝样式、期限值为可替换对象。API 兼容 r4-4 形态，多一层策略注入点 |
| D3 | 性能预算 | **对齐 r4-4 并对配置路径加严**：未配置 <5ns 维持；配置 overload/deadline 的路径提出新预算（§7） |

## 2. 外部契约（API 形态）

### 2.1 公开 API（与 r4-4 逐字兼容，`c.signal` 语义见 §3.4）

```ts
// 优雅停机 —— App 级
app.close(options?: { drain?: number }): Promise<CloseStatus>;
type CloseStatus = { timedOut: boolean; inFlight: number };

app.isDraining(): boolean;      // readiness 翻转用，一旦 true 永不回退
app.inFlight: number;           // readonly：已准入未结算

app.listen(3000, { signals: true });  // SIGTERM/SIGINT → close()；二次信号强停

// 过载保护 —— 构造级
new Keala({
  overload: {
    maxConcurrency?: number,     // 默认 Infinity
    maxQueue?: number,           // 默认 0 = fail fast
    queueTimeoutMs?: number,     // 默认 10_000
    retryAfterSeconds?: number,  // 默认 1；0 = 不发 Retry-After
    handler?: (request, reason: "concurrency" | "queue" | "draining") => Response,
    strategy?: AdmissionStrategy,   // ← 升级点 U1（r4-4 无此字段）
  },
  requestTimeout: 30_000,        // 0/undefined = 关闭
});

// 协作式取消 —— Context 级，lazy
c.signal: AbortSignal;           // 客户端断开 ∨ 期限到点；首次访问才物化
```

### 2.2 行为规则（继承，不改一字）

r4-4 迁移文档 §2 的规则表整体继承为本轮规格：

- **停机规则 r1–r9**：拒绝先于 Context；drain 默认 30_000 / 0 = 立即强停（listener 必死）/ Infinity 永不武装定时器；停机序列 draining → 停接 → 等清空或超时 → 强停；drain 期间带 body 响应 body 读完才算完；幂等 + `{drain:0}` 升级语义；Node 线上真相双计数；WebSocket 1001 送客；信号桥不 `process.exit()`。
- **过载规则 r1–r6**：闸在 `handle()` 入口、建 Context 之前；默认 fail fast；队列 FIFO 槽位移交不抖动；排队断开/超时出队 503；draining 整队拒绝；并发口径 = 已准入未结算（body 流送不占并发槽——与 drain 口径的差异是文档化决策）。**WS 升级请求过闸后在 101 处立即结算（`wsUpgradeHandler` 返回即 release），升级后的 socket 不占并发槽**——由适配器 `openSockets` 单独追踪、drain 时 1001 送客；即 overload 保护的是 HTTP 请求容量，不是 WS 连接数（r4-4 已核实语义，显式入档防"顺手修复"）。
- **期限规则 r1–r5**：到点 `c.signal` 以 `TimeoutError` abort；504 经错误漏斗（mapper 可接管）；僵尸迟到结算静默收容、Context 不回收进池；未配置零成本；`c.signal` lazy 物化。
- **不变式**：`app.handle` 永不 reject；拒绝路径无 Context/无池交互/无错误漏斗；期限 504 路径的 Context 宁可 GC 不复用。

### 2.3 事件时序契约（封闭词表）

| 事件 | 恰好一次 | 终态最后 |
| --- | --- | --- |
| `close()` 的 `CloseStatus` resolve | ✅（幂等重复调用返回同一 promise） | drain 完成或强停之后 |
| 准入拒绝 Response | ✅（排队者由 移交/超时/断开/draining 四选一离队） | 任何 Context 创建之前 |
| 期限 504 Response | ✅ | 僵尸迟到结算不得再写响应 |
| `c.signal` abort | ✅（断开 ∨ 期限，先到者胜，reason 区分） | — |

## 3. 内部问题域

### 3.1 处理什么（逐动词）

准入（admit/queue/refuse）、计数（in-flight 一计三用：容量/drain 完成/指标）、排空（drain：停接、清队、等清空、强停、升级）、保持（drain 期 body-hold：pull-based 零缓冲包装）、竞速（deadline race + 僵尸收容）、桥接（SIGTERM/SIGINT、Node `res` close 断开桥、WebSocket 1001）。

### 3.2 明确不处理什么（每项写清归属）

| 不处理 | 归属 |
| --- | --- |
| 健康检查路由（/healthz、readiness 探针实现） | 应用自己（`isDraining()` 是给它的原料） |
| 熔断、重试、下游负载保护 | 独立单元（总纲 §6 未排期，登记挂账） |
| 指标聚合 / Prometheus 导出 | R4.7 可观测性（`app.inFlight` 是原料） |
| WebSocket 消息级 drain 语义（等消息发完） | 只做 close(1001) 送客，长连接不阻塞停机 |
| `process.exit()` 决策 | 桥不退出进程；drain 定时器持有事件循环，清空后自然退出 |
| 多进程/cluster 级编排 | 进程 supervisors（k8s/systemd） |
| per-route 差异化 deadline/并发预算 | 挂账 R4.7+（本轮仅应用级；`overload.strategy` 是未来 per-route 的注入缝） |
| 压力式准入（Envoy overload manager 型：按堆内存/事件循环延迟拒流） | U1 策略生态（R4.7 可观测性提供压力原料后可实现，不动核心） |
| AIMD 自适应并发（tower concurrency-limit / linkerd 型） | U1 策略生态（`AdmissionStrategy` 插件即可承载，不动核心） |

## 4. 契约升级点（显式登记——唯一的规格漂移）

| # | r4-4 行为 | R4.6 行为 | 理由 | 测试影响 |
| --- | --- | --- | --- | --- |
| U1 | 准入策略固定（fail fast 或内置 FIFO 队列，由 `maxQueue` 隐式选择） | `overload.strategy?: AdmissionStrategy` 显式注入；未注入时行为逐字节等于 r4-4（`maxQueue` 隐式选择保留） | 用户裁决 D2；未来 per-route/优先级准入的注入缝 | 新增策略注入用例；既有用例零改动 |
| U2 | deadline 每请求 2 个闭包（settleOnce + releaseOnce）+ race promise + timer | 单一 once 状态对象 + timer（≤1 闭包） | 用户裁决 D3 配置路径加严；行为不变 | perf 断言更新，行为用例零改动 |
| U3 | 排队 waiter 每请求新建（waiter 对象 + Promise + settle 三件套） | waiter 槽池化，稳态突发零分配 | 用户裁决 D3；行为不变（FIFO/移交/超时/断开语义不变） | perf 断言更新，行为用例零改动 |

**AdmissionStrategy 协议（U1 的形态）**：

```ts
interface AdmissionStrategy {
  /** 满载时被调用：返回 Response=拒绝；null（同步或经 Promise）=准许。
   *  `admit()` 在获得容量的那一刻同步占槽（内置 queue 的槽位移交依赖它——
   *  drain 记账不能观察到计数器下探）；未调用 admit 的 null 由核心在
   *  同步点/决议微任务点补占（此时不得有新请求插入，微任务先于宏任务保证）。 */
  onSaturated(state: LifecycleState, request: Request, admit: () => void): Response | Promise<Response | null> | null;
}
```

机制（计数、draining 拒绝、释放移交循环 `refillFromQueue`）留在核心；策略只决定"满载之后怎么办"。内置 `failFast`（默认）与 `queue`（maxQueue>0 时）两个实现。**实施修正（P3）**：策略收到的 request 由核心物化为 fetch Request（与 `overload.handler` 同契约——策略作者不应面对 RequestSource 双形状）；策略 Promise 决议 null 时若已 drain 则拒绝（draining），已占槽者（槽位移交）除外——服务照常。

## 5. 核心机制 × 策略边界（可插拔架构，裁决 D2）

```
┌─ 不可拔基座（核心，零配置零成本）──────────────────────────┐
│ in-flight 计数器 · draining 标志 · HANDLE_REQUEST_SOURCE     │
│ 准入槽 · settle 槽 · server 注册表 · stopGraceful 适配器契约 │
└──────────────────────────────────────────────────────────────┘
┌─ 可插拔策略 ────────────────────────────────────────────────┐
│ AdmissionStrategy（U1）· overload.handler 拒绝样式 ·         │
│ requestTimeout 数值 · close({drain}) 参数                    │
└──────────────────────────────────────────────────────────────┘
```

插件协议（`{ name, install(app) }`）**不用于** lifecycle 基座：准入发生在建 Context 之前，插件面（middleware ∈ 洋葱内 / decorate）架构上够不到（R4.4 审计结论，维持）。

## 6. R4.5 接线契约（核心新增槽位，全部 shape-lazy）

| # | 槽位 | 位置 | 未配置成本 |
| --- | --- | --- | --- |
| C1 | 准入槽 | `app.ts [HANDLE_REQUEST_SOURCE]` 头部：`!lc.draining && lc.overload === null` 快速路径内联（2 字段加载 + 1 分支 + 自增） | <5ns |
| C2 | settle 槽 | `settleNativeHandle` 增加可选 `release` 参数（r4-4 settleHandle 的 5 参形状）；未配置时稳定直通回调，零每请求闭包 | 1 次稳定调用 |
| C3 | context 三槽 | `state.ts`：`abortValue`（lazy AbortController）、`deadlineAnswered`（布尔槽，非 flag——漏斗重置 flags 不得抹除）、`FLAG_DEADLINE_FIRED = 16384`（已核实空闲：现有 flag 用到 8192） | declare shape-lazy，不占冷路径字段 |
| C4 | server 注册表 | `server-slot.ts` WeakMap（15 行，原样复制） | 零 |
| C5 | 适配器契约 | `GracefulStopOptions { drain, onSettled, registerForce }` + `StoppableHandle`；Node 侧新增 wire 计数（`res` finish/close 事件）与断开 abort 桥；Bun 侧 `openSockets` 追踪 + 1001 送客 | 零 |
| C6 | listen 选项 | `parseListenArgs` 增加 `signals`；`ListenOptions.signals?: boolean` | 零 |

**C1 槽位位置的承重理由（已核实）**：R4.5 的 Node 适配器直接进入 `[HANDLE_REQUEST_SOURCE](source)`（node.ts:455），完全绕过公开的 `handle()`；Bun 适配器走 `app.handle(request, { server })`（bun.ts:70），而 `handle()` 本身委托 `[HANDLE_REQUEST_SOURCE]`（app.ts:421-422）。r4-4 把准入闸放在 `handle()` 里——照搬会让**每个 Node 原生请求漏过准入**。单一槽位放 `[HANDLE_REQUEST_SOURCE]` 同时覆盖两个运行时与嵌入式调用。

**S4 设计裁决（本轮新增，r4-4 未面对）**：R4.5 的 `NativeRequestSource` 无 `signal` 通道，而队列 abort（排队期间客户端断开 → 出队 503）需要它。裁决：给 `NativeRequestSource` 增加 lazy `abort()` 通道（由适配器的断开检测驱动），Fetch Request 路径沿用 `request.signal`。**不**通过 `source.request()` 物化 Request 来取 signal——那会为每个排队请求付出完整 Request 分配，违背零包装目标。

## 7. 并发与性能预算（违反 = 缺陷，不是优化建议）

### 7.1 未配置路径（无 overload、无 requestTimeout、非 draining）

- 热路径：C1 快速路径 = 2 次字段加载 + 1 分支 + 1 自增，**<5ns**（`bench/lifecycle-overhead.ts`，与 r4-4 同口径对照 bench 噪声）；
- 结算：sync 响应路径零分配（稳定回调内联调用）；async 路径一次链上续延（`.then` 链式 promise，无闭包）+ flag 判断 + 自减——r4-4 同口径（其实现头注："a flag guard + decrement in the settle tail"）；零定时器；
- drain/队列/期限相关全局定时器：**0 个**。

### 7.2 配置路径（加严，用户裁决 D3）

| 配置 | 预算 | 验证方式 |
| --- | --- | --- |
| overload 稳态（无排队） | 准入 1 比较 + 自增；结算 1 减法 + 2 次空检查 | bench 对照 |
| overload 排队突发 | waiter 池化：稳态 1000 次 admit/release 循环 **0 次新分配**（GC 稳态）；每 waiter 恰 1 个 unref timer | perf 测试锁（allocation 计数） |
| requestTimeout | 每请求 ≤1 闭包 + 1 个 unref timer（U2）；未到点路径 0 promise 新增 | perf 测试锁 |
| drain | 计数不抖动（槽位移交）；close 后全局定时器 ≤1（Infinity 时 0） | 单元断言 + drain-verify |

### 7.3 热路径禁止动作清单

准入槽内禁止：Context 创建、池交互、错误漏斗进入、Response 分配（拒绝路径除外——它本来就要分配）、同步 IO。settle 槽内禁止：IO、跨请求状态写入。

## 8. 与 R4.5 引擎的接缝风险（实施必须逐条红测）

| # | 接缝 | 风险 | 红测要求 |
| --- | --- | --- | --- |
| S1 | `settleNativeHandle` 4 参形状 vs r4-4 `settleHandle` 5 参 | release 槽缺位；pooling 非 pooling 分叉语义 | 既有 pooling 全量回归 + release 恰一次断言 |
| S2 | R4.5 node.ts 全重写（native source、`cleanupUnread`、`bytes(limit)`） | wire 计数/abort 桥/stopGraceful 需重做；**drain 中途的 `bytes(limit)` 读取、`cleanupUnread` 与 stopGraceful 的交互是全新行为** | 新增：drain 期 body 读取中止、cleanupUnread 后停机 |
| S3 | R4.5 新增 response-plan（committed headers 能力位） | body-hold 在 settle 点重包装 Response；若 plan 已提交头，重包装可能双写 | 新增：holdBody × committed-headers 顺序用例 |
| S4 | NativeRequestSource 无 signal（§6 裁决） | 队列 abort 对 native 请求失效 | 新增：native 路径排队断开出队 |
| S5 | shape-lazy 字段纪律 | 三槽以普通字段初始化会破坏 R4.5 的冷路径形状优化 | 覆盖率 + 既有 perf fence 回归 |

## 9. 文档演进纪律

实现推翻本文任一裁决：同一提交内先改本文再改代码。升级点清单 §4 是封闭集——实施期新增升级点必须回到用户裁决。
