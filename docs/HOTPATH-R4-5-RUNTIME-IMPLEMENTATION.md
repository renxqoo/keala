# HOTPATH-R4.5 — 运行时执行引擎施工图

> 状态：已核销（2026-09-02）
> 设计基线：[HOTPATH-R4-5-RUNTIME-DESIGN.md](./HOTPATH-R4-5-RUNTIME-DESIGN.md)
> 迁移单元：[HOTPATH-R4-5-MIGRATION-RUNTIME-ENGINE.md](./HOTPATH-R4-5-MIGRATION-RUNTIME-ENGINE.md)

## 1. 旧实现审计结论

### 1.1 确认问题

| 编号  | 级别        | 结论                                                                                           | 证据                                                   | 裁决                                |
| ----- | ----------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------- |
| B45-1 | P0 性能     | 每个 Node 小响应都走 WebStream→Node Readable→pipeline，真实吞吐仅 Hono 的约 20.6%              | `src/adapters/node.ts:91-107` + 三轮 wire 对拍         | 整段重写                            |
| B45-2 | P1 可用性   | handler 未读请求 body 提前响应时没有统一 drain/destroy 所有权，keep-alive 可能被残留 body 阻塞 | `src/adapters/node.ts` 无 cleanup 状态；既有测试未覆盖 | 新 source 在 response settle 时清理 |
| B45-3 | P1 验证缺口 | “客户端先断开”测试只验证不崩溃，不断言 source/producer 被取消或资源释放                        | `test/adapters-node.test.ts`                           | 补可观察回归                        |
| B45-4 | P2 性能     | Node 请求无条件创建 Headers、Request；GET probe 从不需要大部分对象                             | `requestOf()`                                          | 改为 lazy RequestSource             |
| B45-5 | P2 测试装置 | Node framing 测试跨整个 pipelined 报文搜索 Content-Length，会误取第二条响应的长度              | `test/agent-review-security.test.ts`                   | 只解析第一条 header block           |

### 1.2 结构证据

| 编号  | 结论                                                                    | 裁决                                      |
| ----- | ----------------------------------------------------------------------- | ----------------------------------------- |
| A45-1 | Node 进程内核心 probe 平价，3/6 层洋葱与 late-header 领先 Hono          | 不改语义；只做可证明的注册期特化          |
| A45-2 | sugar 和 state finalizer 在 Response 构造前拥有原始 string/bytes/object | 提取单一 ResponsePlan/元数据              |
| A45-3 | 现有 implicit-text 私有 symbol 已证明 Response 可携带无全局表的构造事实 | 扩展为统一 body metadata 后删除单用途标记 |
| A45-4 | 外部 Response 可能是锁定、disturbed、未知流，不能假装为直接 body        | 归一为 foreign/stream，严格 fallback      |
| A45-5 | Bun.serve 必须接收 Response；Node ServerResponse 可直接写 string/Buffer | 共享计划、运行时专用终端                  |
| A45-6 | body parser 已是单一固定形状 memo，缺口是 Node Web Request/Stream 入口  | 保留 reader 语义，替换 raw read port      |

### 1.3 重复与契约缺口

- **D45-1**：body kind 分别在 sugar、respond、Node adapter 被隐式推导；归并到响应计划。
- **D45-2**：请求 method/url/header 在 adapter 构造、Request、Context 再次解析；归并到 source。
- **C45-1**：Application 只有公开 Fetch handle，缺少供原生 adapter 传入 source 的内部端口。
- **C45-2**：body reader 只接受 Web Request，无法利用 Node IncomingMessage 的直接 bytes。
- **C45-3**：adapter 没有可观察的 in-flight request body cleanup 生命周期。

### 1.4 实现期发现并修复

| 编号   | 问题                                                        | 修复与回归锁                                                       |
| ------ | ----------------------------------------------------------- | ------------------------------------------------------------------ |
| B45-6  | Node origin-form 为路由提前拼绝对 URL                       | source 保存 request-target；只在 `c.raw/c.URL` 首次访问时拼 origin |
| B45-7  | 计划响应重建若继承旧 headers facts，会丢 late header        | 重建只继承 byte-exact body；新 header 集合归新 Response 所有       |
| B45-8  | Bun 1.4 对轻量文本 Response 的隐式 Content-Type 行为不同    | plan 暴露标准 headers，并在删除/重建后保持真实用户修改             |
| B45-9  | declared body 在 Bun 路径仍可能先进入 WebStream             | declared 路径直接 `Request.bytes()`，再以实际字节复核预算          |
| B45-10 | benchmark Bun wrapper 实际用 `process.execPath` 启动了 Node | Bun 模式显式使用 Bun binary；进程结果记录 runtime                  |
| B45-11 | 两组独立 RPS 中位数相除会被同机漂移扭曲                     | 主指标改为每轮配对比率的中位数，独立中位数只作诊断                 |
| B45-12 | Bun `it.each` 把空数组 fixture 当作零参数展开               | fixture 改为对象行，Node/Bun 两套测试都执行真实空数组 case         |
| B45-13 | pooled context 从显式 runtime 切到无 runtime 时保留旧值     | `runtimeValue` 纳入原型 sentinel，回收时删 own slot 并加泄漏锁     |

## 2. 逐模块裁决

| 旧文件                        | 裁决         | 审计状态            | 动作                                                 |
| ----------------------------- | ------------ | ------------------- | ---------------------------------------------------- |
| `src/adapters/node.ts`        | 重写         | 已审（B45-1/2/4）   | 删除 requestOf/pipeline；原生 source + writer        |
| `src/adapters/bun.ts`         | 重构         | 已审（A45-5）       | 调用共享内部 source/终端，不引入 Node 分支           |
| `src/core/app.ts`             | 重构         | 已审（C45-1）       | 单一内部 dispatchSource；公开 handle 包 Fetch source |
| `src/core/application.ts`     | 重构         | 已审                | 用私有 symbol 暴露 adapter 调度端口，不增加用户 API  |
| `src/core/dispatch.ts`        | 重构         | 已审（D45-2）       | 从 source path/method 调度，算法不变                 |
| `src/core/context/state.ts`   | 重构         | 已审                | rawRequest 改 requestSource；冷字段迁入原型 sentinel |
| `src/core/context/context.ts` | 重构         | 已审                | 热字段固定 own slots；pool 清理 source 生命周期      |
| `src/core/context/request.ts` | 重写入口     | 已审（D45-2）       | lazy raw/headers；其余 Koa API 语义保留              |
| `src/core/context/sugar.ts`   | 重构         | 已审（A45-2/3）     | 用统一 body metadata 替代 implicit-text 专用标记     |
| `src/core/respond.ts`         | 重构         | 已审（A45-2/4）     | 生成/传播唯一计划事实，fallback 不读流               |
| `src/plugins/body-parser.ts`  | 重构读取端口 | 已审（A45-6/C45-2） | source 有界 bytes；memo/413 语义不变                 |
| `src/core/compose.ts`         | 特化         | 已审（A45-1）       | 洋葱语义不变；单 handler 走直接调度                  |
| `src/router/*`                | 特化         | 已审（A45-1）       | 静态 match 复用、单动态 fast matcher、无冗余 decode  |
| `test/adapters-node.test.ts`  | 扩展/改写    | 已审（25 cases）    | 新 source/writer/cleanup/wire 矩阵                   |
| body/stream/property tests    | 扩展         | 已审                | 新端口等价、断连、背压、pool 隔离                    |
| benchmark harness             | 重构         | 已审                | 官方 Node Hono、fresh server、正确性断言             |

不存在“复制”裁决；所有进入热路径的旧桥模块都重写或重构。旧实现删除后不保留 feature
flag、别名或第二套 writer/source。

## 3. 目标依赖方向

```text
Node IncomingMessage ─┐
                      ├─ RequestSource ─> Context/Router/BodyReader
Bun/Fetch Request ────┘

Context/Finalizer ─> ResponsePlan/body metadata
                       ├─ Bun materialize Response
                       └─ Node writeHead/end OR stream writer
```

source/plan 只能依赖 Web/Node 的最小结构；router 不依赖 adapter；context 不 import
`node:http`；Node adapter 不重复实现 response rule-4。

## 4. 测试迁移计划

### 4.1 Node request source

- origin/absolute form、OPTIONS `*`、Host-less HTTP/1.0、IPv4/IPv6；
- 重复头、Cookie、proxy headers；headers/raw 的延迟单例；
- content-length 0、declared、chunked、truncated、lying、客户端中断；
- body 未读提前响应后，同一 keep-alive 连接继续请求；
- raw 与 body facade 的所有权、同 Promise/reason/object memo。

### 4.2 Node response writer

- text/json/html/bytes/empty/HEAD/204/205/304；
- statusText、普通头、多 Set-Cookie、late header/status/body；
- 明确/隐式 Content-Length 与 framing 一致；
- SSE、慢 consumer 背压、producer error、client abort/cancel；
- foreign Response、locked/disturbed body、error mapper takeover；
- pipelined keep-alive 不串帧、不丢第二响应。

### 4.3 Bun 与共享核心

- 现有 response/property/body/pooling 全量不变；
- 真 Bun server 的 text Content-Type、body-safe、SSE cancel；
- Response 元数据不能跨 clone/foreign/pooled context 泄漏；
- Node source 不得进入 Bun bundle 的运行时引用路径。

### 4.4 性能门

- commit 前记录 R4.4 Node/Bun 核心与 wire 基线；
- 每阶段 fresh-process A/B，未达本阶段预算不扩大；
- 最终对 Hono 官方适配器做同路由、同安全语义、同负载对拍。

## 5. 实施与提交顺序

1. 文档定稿；
2. 行为锁、资源清理锁、benchmark harness；
3. 响应 body metadata + Node direct writer，删除旧 pipeline；
4. RequestSource + Node lazy request，删除旧 requestOf；
5. Node direct bounded body + cleanup，接入 body parser；
6. Bun 终端和共享 finalizer 收口；
7. 双形态 e2e、全门、Tillgate、性能核销。

每阶段独立提交；实现发现设计错误时同提交先修文档。禁止以暂存兼容分支让两个执行引擎
长期并存。

## 6. 停止与返工条件

- 任何 response framing、HEAD/empty status、Set-Cookie、rule-4 或 never-reject 改变；
- body budget、actual-byte guard、memo/取消/错误 reason 改变；
- stream 失去背压，client abort 不取消 producer，未读请求阻塞 keep-alive；
- Bun 非目标热路径稳定回退超过 3%；
- Node 提升不足 3 倍或仍明显落后 Hono；
- 需要全局替换 Request/Response 或修改 Tillgate 才能达标。

## 7. 最终实现与性能核销

最终实现不是全局替换 `Request/Response`，而是作用域内 `PlannedResponse`：自身承载 direct
body/status/header facts；Bun 在 Fetch 边界使用标准 Response，Node 对已知 string/bytes
直接 `writeHead/end`，对未知流使用有背压、断连取消的单 writer。Node source 的常见 probe
只有 incoming/server/method/url 四个 own slots，Headers、Request、body、absolute URL 均按需。

真实 HTTP 使用 Hono 4.13.5 官方 Node adapter，200 connections、pipeline 1、交错 5 轮；
主统计量是同轮配对 Keala/Hono 比率中位数。代表性结果：

| Runtime | 场景                    | Keala 相对 Hono（配对中位数） | p99        |
| ------- | ----------------------- | ----------------------------: | ---------- |
| Node 22 | probe                   |                         +7.1% | 2ms vs 3ms |
| Node 22 | JSON 小响应             |                         +4.6% | 3ms vs 3ms |
| Node 22 | param                   |                         +4.2% | 3ms vs 3ms |
| Node 22 | 3 层 middleware         |                        +61.0% | 不劣       |
| Node 22 | 同实际字节复核安全 JSON |                        +11.2% | 不劣       |
| Bun 1.4 | probe                   |                         +7.7% | 2ms vs 3ms |
| Bun 1.4 | param（5 秒样本）       |                         +6.2% | 2ms vs 2ms |
| Bun 1.4 | JSON（5 秒样本）        |                        +11.9% | 3ms vs 3ms |

Node probe 从 R4.4 的约 28.35k RPS 提升到约 133k RPS，约 4.7 倍，并超过本机同口径 Hono。
所有记录场景 error/timeout 为 0。统一 `+10%` 是 stretch goal，middleware/安全 JSON 达到，
最窄 probe/json/param 未达到；生产验收采用更严格、也更诚实的结论：本版本与同语义矩阵下
两运行时所有主场景配对中位数均领先，不声称跨硬件或未来 Hono 的数学永久最优。

质量门：Node 2008 pass/8 skip，Bun 1979 pass/37 skip，coverage
`97.32/92.07/96.29/98.69%`，构建、smoke、example、soak、四象限进程检查全绿；Tillgate
5 个直接消费者以本地构建产物验证 718 tests，原仓库未修改。旧 requestOf、pipeline、
WebStream 小响应桥、兼容开关和双 writer 均不存在，无待办占位或已知正确性挂账。
