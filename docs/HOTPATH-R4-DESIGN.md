# HOTPATH-R4 — 企业级多通道执行架构设计基线

> 状态：R4.1 已核销
> 级别：大
> 基线提交：`fa532f9`（R3 已核销）
> 工作分支：`codex/hotpath-r4-execution-plan`
> 范围：仅 keala；Tillgate 只允许只读测试，不修改源码或生成物。
> 施工图：[HOTPATH-R4-IMPLEMENTATION.md](./HOTPATH-R4-IMPLEMENTATION.md)
> 首个迁移单元：[HOTPATH-R4-MIGRATION-COMMIT-FAST-LANE.md](./HOTPATH-R4-MIGRATION-COMMIT-FAST-LANE.md)

## 1. 目标与成功定义

R4 的目标不是在一个裸 `GET` 数字上用掉企业语义，而是在**相同正确性与安全语义**下
超过 Hono，并让高性能、高可用能力成为可组合的生产架构：无需 koa 语义的请求不付完整
重建税，需要语义的请求仍得到可证明的 fallback。

成功必须同时满足：

1. 正确输出的 post-next header + text 路径得到可重复的真实加速；
2. probe、JSON 安全读取、流式响应和 Node 适配器没有显著回退；
3. 不取消 413 字节预算、不弱化洋葱时序、不吞错误、不读取已提交流 body；
4. 每条快路都有确定的适用条件和语义等价 fallback，而不是运行时猜 handler；
5. 任何性能结论都来自 fresh-process、交替顺序、多轮中位数和响应正确性断言；
6. 高可用能力按独立子系统推进，不能用每请求全局锁、无界缓存或后台定时器换取表面功能。

### 1.1 已知基线

R3 在 Hono 4.13.5 对拍中已实现：三个作用域 gate 外的 probe 快 17.1%；裸
`c.text()` 慢 5.2%；正确 `text/plain` 的 post-next header 场景在 IQR 内平价；JSON
echo 慢 28.9%，但 Hono 对照没有强制字节预算，不能作为同安全语义结论。

本轮额外隔离探针（Bun 1.4，20 万次、同一进程预热后）显示：本地 Response 直接
`headers.set` 约 160ns/次，复制 Headers 并重建 Response 约 436ns/次。它只证明首个
迁移单元值得验证，不代替最终端到端基准。

## 2. 外部契约

### 2.1 R4 第一阶段不新增公开 API

首个迁移单元只改变内部执行方式，以下公开行为必须逐字节等价：

- handler 返回的 `Response` 在下游完成时提交；外层 middleware 在 `await next()` 后
  读取到已提交 status，并可继续 `set/append/remove/vary`；
- 晚写 header、cookie、status、message、body 的 rule-4 胜负顺序不变；
- `HEAD`、204/304、Set-Cookie、多值 header、notFound、405/501/OPTIONS 与错误响应不变；
- `app.handle()` 始终返回 Promise 且不 reject；Bun 与 Node 的结果一致；
- 不可变或未知来源的 Response 自动落回现有重建通道，用户不需要声明来源。

### 2.2 `onError` 错误响应策略（R4.3 修订）

> 本节原文（「onError 契约冻结为观察事件、错误响应策略须另命名 `app.catch`」）
> 已按用户裁决废止——项目无存量用户，不保留兼容逻辑。修订后契约：

- `app.onError(mapper)` 是**唯一**错误入口，**单槽**（重复注册抛 `TypeError`）；
- `type ErrorMapper = (error: HttpError, c: Context) => Response | Promise<Response> | void`；
  返回 Response 接管错误响应（HEAD 剥体 + `error.headers`/安全 staged 头 if-absent
  合并），返回 void 走内置默认（永不泄露非 expose 的 message）；
- mapper 抛错/拒绝 → static 500 且框架 console.error（不静默）；`app.handle`
  永不 reject；
- 覆盖整个错误漏斗：chain 抛错、finalize 失败、ws upgrade 拒绝；404 未中归
  `app.notFound`；
- 随本修订删除纯兼容机制：emitter 多播模块、`off/emit/listenerCount`、
  `KealaOptions.silent`、`HttpError.statusCode` 别名、第三方 `.statusCode`
  回退链。详见
  [HOTPATH-R4-3-MIGRATION-ERROR-POLICY.md](./HOTPATH-R4-3-MIGRATION-ERROR-POLICY.md)。

### 2.3 不提供不安全 JSON 快路

强制 body limit、谎报 Content-Length 复核、流式超限取消及 reader memo 是 keala 的
生产契约。R4 不加入默认裸 `request.json()`，也不把安全性藏在 benchmark-only 开关。
若未来需要受信任内网的裸读取，它必须是显式 plugin/route policy，并与安全默认值分开
计分；本轮不处理。

## 3. 内部执行模型

### 3.1 三通道，而非一个万能 dispatcher

| 通道     | 进入条件                                                             | 每请求责任                                  | 失败/不确定时              |
| -------- | -------------------------------------------------------------------- | ------------------------------------------- | -------------------------- |
| Native   | 用户显式 `sink()` 且无冲突 middleware                                | Bun 原生路由表直接答复                      | 注册期拒绝冲突；不自动猜测 |
| Fast     | 已编译 JS chain；操作可证明不改变 status/body；Response headers 可变 | 原地应用等价 header 变更，不新建 Response   | 原子退回 Semantic          |
| Semantic | 其余所有请求                                                         | 现有 staged state + rule-4 rebuild/finalize | 现有静态 500 最终兜底      |

Native 通道继续显式 opt-in。任意 middleware 都可能依赖请求、时间、状态或副作用，R4
不做静态函数体嗅探，也不自动把 handler 下沉到 Bun routes。

### 3.2 Fast 通道的资格

首个单元只处理“已提交 Response + 晚写普通 header”的窄路径。资格是运行时事实而非
handler 形状：

- `_res` 已存在；
- 本次操作只影响 headers；
- header 名值已完成与 Semantic 通道相同的校验；
- 没有已知需要整体重建的 status/message/body 标志；
- Response Headers 可修改，且此次操作可在第一次有副作用前确定完成。

第一阶段允许：普通 header 的 `set`、`remove`，以及可等价实现的单值 append/vary。
第一阶段默认不快化：Set-Cookie、多值数组、Content-Type/Length 单例边界、cookies
facade、status/message/body、空状态和任何需要读取 body 的操作。后续只有在表驱动
语义测试与分配证据齐备后逐项放行。

### 3.3 可变性状态机

Web Fetch 对不同来源 Response 的 Headers guard 不一致。实测 Node 22：本地
`new Response()` 可变，`Response.error()`、`Response.redirect()` 与 fetch 结果不可变；
Bun 1.4 对这些样本均可变。因此不能全局按 runtime 分流。

每个 context 记录三态能力：unknown / mutable / immutable。第一次符合条件的操作在
校验完成后尝试一次；成功后记 mutable，抛 `TypeError` 且未改变 headers 时记
immutable 并按原 staged 算法处理。后续操作不重复用异常探测。该状态随 context 回收
必须重置，不能用按任意 Response 增长的全局 Map。

若一个操作无法保证失败前无部分写入，则它不进入第一阶段 Fast 通道。Fast 通道对
用户不可见，任何不能证明的情形直接走 Semantic，而不是补偿式回滚。

### 3.4 后续重建的闭包性

原地改过 headers 后，若更外层随后晚写 status/body 并触发 Semantic，重建必须以当前
committed Response headers 为源。这样较早的直接写不会丢失，较晚的 staged/removal
仍按 rule-4 覆盖；快路只是状态表示优化，不改变操作顺序。

## 4. 明确不处理

- **不在首个单元重写 router**：现有静态 Map 为 O(1)，动态 trie 为 O(path segments)
  且有单简单 pattern 特化。是否加入 Hono 式组合 regexp 必须先有 1/10/100/1000 路由
  的静态、单参、冲突动态、失败匹配矩阵；归属 R4-Router 独立迁移单元。
- **不在首个单元重写 compose**：R3 同层对拍已否定其为当前主要差距；归属有新
  profile 证据后的 R4-Compose 单元。
- **不发布 `app.compile()`/freeze**：keala 当前允许 listen 后注册路由、middleware、ws
  和 sink reload。冻结会改变生产热更新契约；归属生命周期 API 的独立设计。
- **不自动 sink**：任意 middleware 的副作用不可安全推断；归属显式部署编译器，不是
  请求核心。
- **不在本轮同时做 graceful drain、过载拒绝、deadline、熔断、健康状态聚合**：这些是
  企业高可用路线图，但涉及 server 生命周期和运维契约，必须分别设计与压测，不能夹带
  在 header 优化中。
- **不修改 Tillgate**：只允许运行其现有测试/基准并检查工作树保持 clean。

## 5. 并发、内存与性能预算

违反以下预算视为缺陷：

### 5.1 每请求热路径

- Fast header-only 路径：零 `new Response`、零 `new Headers`、不新增 Promise/闭包；
  复用与旧 staging 路径同量级的一个 prototype-less 观察镜像（remove 复用既有
  tombstone list），不增加第二份记录；时间 O(1) 加 header 实现本身成本。该镜像是
  保持 `c.has()/resHeader()` 以及外层新 Response replay 语义所必需，不能为零分配数字
  删除公开行为。
- Semantic fallback：维持 O(header count) 时间与空间；绝不读取、clone 或等待
  committed body，尤其是 open/locked/disturbed stream。
- capability 只占既有 `flags` 的两个命名位，不新增 context slot；pool recycle 后为
  unknown；无全局无界表。
- probe、body、裸 text 的进程内中位数相对 R3 不得回退超过 3%；超出即停止合并。
- 正确 dirty text 目标：相对 R3 的约 1030ns/req 至少降低 15%，并保持
  `text/plain; charset=utf-8` 与 late header 正确。
- immutable fallback 相对 R3 重建路径不得回退超过 5%。

### 5.2 基准统计

- 每个变体独立 fresh process；至少 3 轮 A-B-B-A 或 B-A-A-B；固定 warmup、batch；
- 报 median、IQR、所有失败/timeout；先断言 status、body、Content-Type 和 late header；
- 对 Hono 只比较相同语义。Hono 未启用 body limit 的 JSON 结果必须标为非等价参考；
- HTTP 压测同时报告 RPS、p50/p99、错误数和 RSS，不能用单次 best 证明提升。

## 6. 高可用路线图与优先级

R4 按可独立回滚的纵向单元推进：

1. **R4.1 committed header Fast 通道**：已核销（见
   [HOTPATH-R4-MIGRATION-COMMIT-FAST-LANE.md](./HOTPATH-R4-MIGRATION-COMMIT-FAST-LANE.md)）；
2. **R4.2 路由规模自适应研究**：已核销，裁决为**不重写 router**（见
   [HOTPATH-R4-2-MIGRATION-ROUTER-SCALE.md](./HOTPATH-R4-2-MIGRATION-ROUTER-SCALE.md)：
   N≥1000 参数路由 keala 快 3–72 倍、miss 全规模快 32–47%，唯一小表缺口
   N≤10 param-shared ~130ns 不达立项门槛；regexp dispatcher 不立项）；
3. **R4.3 错误响应策略**：保留 `onError` 观察面，新策略 API 单独确认；
4. **R4.4 生命周期与过载控制**：drain、in-flight、accept/reject、deadline 分开定约；
5. **R4.5 可观测性低税接口**：仅在订阅时付费，默认热路径零分配。

每一项都必须先形成自己的 MIGRATION 文档，上一项核销不自动授权下一项编码。

## 7. 裁决

- **用户裁决**：目标是超越 Hono，同时保持企业生产可用、高性能、高可用；允许重构、
  重写算法；不得修改 Tillgate；必须验证前后真实性能和 bug 面。
- **用户裁决**：R3 先独立提交，再切新分支；R4 先写执行方案后实现。
- **用户裁决**：第一实现单元做 committed header Fast 通道；不先重写
  router/compose，不新增公开 API。
- **用户裁决**：现有 `onError` 永久保留观察语义；错误响应策略另命名。
- **用户裁决**：性能竞争以同语义为准，不用关闭 413 安全预算制造胜利。
- **用户裁决**：R4.1 必须完整实施、生产可用并通过全部门禁，不留下占位实现。
- **用户裁决**（R4.3 修订，废止上一条「onError 冻结/另命名」）：项目无存量用户，
  不保留任何兼容逻辑，纯兼容机制直接删除；onError 单槽化为唯一错误入口
  （返回 Response 接管）；错误处理方案以真实业务用法（企业信封、集中映射、
  零泄露默认、协议头不丢）为验收形态。

## 8. 总体验收

- [x] R4.1 的契约矩阵、双运行时与属性测试全部通过
- [x] R4.1 达成性能预算，且 immutable fallback 无显著回退
- [x] fmt / lint / typecheck / build / Node / Bun / coverage / smoke 全绿
- [x] 覆盖率四项不低于 `fa532f9` 基线
- [x] Tillgate 只读验证前后工作树 clean
- [x] 后续单元各有数据、设计和否决窗口，不以路线图代替授权
