# HOTPATH-R4.5 — Bun/Node 运行时执行引擎设计基线

> 状态：已核销（设计预算按 §6 配对统计修正）
> 分支：`codex/r4-5-runtime-engine-rewrite`
> 基线：`c1f2a6a`（R4.4 已核销）
> 施工图：[HOTPATH-R4-5-RUNTIME-IMPLEMENTATION.md](./HOTPATH-R4-5-RUNTIME-IMPLEMENTATION.md)
> 迁移单元：[HOTPATH-R4-5-MIGRATION-RUNTIME-ENGINE.md](./HOTPATH-R4-5-MIGRATION-RUNTIME-ENGINE.md)

## 1. 目标与成功定义

本单元将 Keala 从“Fetch 核心外包一层通用 Node 桥”重写为共享协议核心、Bun/Node
各自原生收发的执行引擎。目标不是与 Hono 打平，而是在相同响应、安全、流式和错误语义
下，让 Bun 与 Node 的生产 HTTP 热路径都稳定超过同版本 Hono。

成功必须同时满足：

1. Node 小响应不再经过 `Readable.fromWeb()` 或 `pipeline()`；
2. Node 路由前不无条件创建原生 `Headers`、`Request` 和 Web body stream；
3. Bun 只在服务器边界物化一次最终 Response，不为 Node transport 付费；
4. JSON 限额、lying Content-Length 复核、跨 reader memo、流式取消均保留；
5. 外部 Response、SSE、未知长度流走同一个新流引擎，不保留旧桥或双轨开关；
6. Node/Bun 真实 HTTP、进程内核心、p99、错误数和内存均给出 fresh-process 对拍；
7. 所有功能、安全、属性、跨进程及源码/构建产物门禁通过后才核销。

### 1.1 已确认基线

Node 22.20.0 进程内 8 个 fresh process 中位数：Keala/Hono probe 为
2992/2960ns；3/6 层同步全局链 Keala 快 11.5%/13.9%；3/6 层异步链快
2.0%/4.6%；正确 late-header text 快 21.7%；严格安全 JSON 慢 2.3%。核心路由与洋葱
调度不是 Node 的主要缺口。

真实 Node HTTP（Hono 4.13.5、`@hono/node-server` 2.1.1，100 connections、
pipeline 10、4 load workers，2 秒预热 + 5 秒采样，三轮交错独立服务进程）：Keala
中位数 28.35k RPS / p99 88ms，Hono 137.56k RPS / p99 14ms，双方 0 error。
缺口集中于 Node transport。

Bun 1.4 进程内 R4.4 已实现 probe 快 20.3%、3/6 sync 快 41.0%/47.2%、3/6
async 快 22.6%/21.7%、正确 dirty text 快 29.4%；真实 HTTP 必须在本单元用独立服务
进程重新测量，不能把进程内优势直接宣称为 wire 优势。

## 2. 外部契约

### 2.1 公开 API 不新增双轨

- `app.handle(Request, runtime?)` 仍返回永不 reject 的 `Promise<Response>`；
- `c.raw` 仍提供标准 Request 行为；`c.headers`、body readers、clone/formData 等按需可用；
- `c.text/json/html` 仍返回 Response；state style 与 return style 的 rule-4 时序不变；
- `listen/startNodeServer` 的签名和 server handle 形状不变；
- 不增加 `fast`、`legacy`、`compat`、`unsafe` 或运行时选择开关；
- 不要求应用标注 handler 是否同步、响应是否可缓存或 body 是否有限。

### 2.2 用户裁决

- **用户裁决**：采用最新执行引擎方案，允许重写；旧 Node bridge 整体删除，不保留兼容
  老实现的代码路径。
- **用户裁决**：目标是 Bun 和 Node 都超过 Hono，不接受仅打平作为性能完成条件。
- **用户裁决**：框架必须是企业生产实现，不能用删除 body 安全、背压、断连清理、
  错误隔离或响应正确性换取 benchmark 数字。
- **用户裁决**：不修改 Tillgate；只允许读取和运行其测试/基准。

## 3. 内部问题域

### 3.1 单一响应计划

核心在最终状态仍掌握 body 的原始表示，统一形成内部 `ResponsePlan`：

```text
status + statusText + headers
body = empty | text | bytes | stream | foreign-response
```

- text/json/html/state string 只序列化一次；
- Node 直接写 `ServerResponse.end(string|Buffer)`；
- Bun 将计划一次物化为原生 Response；
- stream 只经一个 Web reader→Node writer 背压循环；
- foreign Response 归一进同一计划，不能证明 body 表示时归为 stream；
- late header/status/body 修改发生在计划或已提交 Response 的唯一语义合并器上。

公开的 sugar Response 携带模块私有 body 元数据。该元数据是该 Response 的真实构造事实，
不是按 handler 猜测的缓存；body 已使用或锁定时禁止直接写元数据，仍按标准错误语义处理。

### 3.2 请求来源抽象

Context 持有一个运行时 `RequestSource`，而不是强制持有已物化的 Request：

- Fetch/Bun source 包装已有 Request；
- Node source 直接持有 IncomingMessage、method、target、authority 和 socket；
- router 从 source 的 path/method 匹配；
- `c.get()` 优先从原生头表读取；`c.headers` 首次访问时物化 Headers；
- `c.raw` 首次访问时物化标准 Request；
- body ownership 只能由 source 内一个状态机取得，raw/body parser 不得双读。

### 3.3 Node body 引擎

Node 有界 body 直接读取 IncomingMessage Buffer：

- declared 长度读前预检；
- 实际累计字节读后复核；
- 无声明/chunked 每块计数，超限立即停止消费并拒绝；
- 客户端提前断开、解析未完成、socket error 产生明确 rejection；
- 首次 reader 的 bytes/Promise 与 parsed result memo 不变；
- handler 未消费请求 body 就提前响应时，适配器必须安全 drain/destroy，避免 keep-alive 阻塞。

### 3.4 Node 响应引擎

- empty/HEAD/204/205/304：直接 `end()`，严格清理 content headers；
- text/json/bytes：设置一次 status/headers，直接 `end`，长度与实际 wire bytes 一致；
- stream：Web reader 按下游 `write()` 背压拉取；drain 前不继续读；
- 客户端断开：取消 source reader；producer error：headers 未发则 500，已发则 destroy；
- Set-Cookie 使用独立数组，不逗号折叠；
- 不使用 `Readable.fromWeb`、`pipeline` 或每个小响应的 stream 监听器集合。

## 4. 明确不处理

- 不重写 router、compose 或错误 mapper 的语义；允许注册期单路由/单 handler 特化和移除
  可证明的重复解析；
- 不加入 HTTP/2/3：归属后续协议适配器单元；
- 不把 WebSocket 移植到 Node：现有公开契约仍是 Bun-only，归属独立 ws 设计；
- 不加入压缩策略、缓存策略、graceful drain、熔断或观测 API：各自归属独立单元；
- 不通过替换 Node 全局 Request/Response 获取性能：全局副作用不适合企业库；
- 不保证在所有硬件、所有 Hono 未来版本和所有 workload 上永久领先；验收绑定本文版本、
  相同语义矩阵和统计纪律。

## 5. 并发、内存与性能预算

违反以下任一项视为缺陷：

- text/json/bytes Node wire：零 WebStream bridge、零 pipeline、零 body copy（string UTF-8
  编码由 Node writer 完成；Uint8Array 只建立共享 Buffer view）；
- Node GET probe：未访问 `c.raw/c.headers` 时不得创建 Request、Headers、ReadableStream；
- body 算法 O(n)，有限额时内存 O(limit)，多 chunk 最多一次合并；
- stream 全程有背压，未消费请求不得导致连接永久挂起；
- 不新增全局无界 Map/WeakMap；响应私有元数据随 Response 生命周期回收；
- Bun probe/body/bare text 相对 R4.4 不得稳定回退超过 3%；
- Node 真实 probe 必须相对 R4.4 提升至少 3 倍；同轮配对中位数必须超过 Hono，`+10%`
  作为 stretch goal；
- Bun 真实 probe、global middleware 和安全 JSON 的同语义配对中位数必须超过 Hono，
  `+10%` 作为 stretch goal；
- p99 不得用吞吐交换，错误/timeout 必须为 0；RSS/GC 不得显著恶化。

## 6. 基准统计纪律

- 每个框架/变体独立服务进程；交替启动顺序；至少 8 个进程内样本和 5 个 wire 样本；
- wire 每样本先预热再采样，固定 connections/pipelining/load workers；
- 同时报每轮 Keala/Hono 比率及其中位数、各自 median、所有样本、RPS、p50/p99、
  errors、timeouts；同机受漂移影响时不得用两组独立中位数之比冒充主结论；
- 计时前断言 status、body、Content-Type、Content-Length、late header 和 413；
- Hono 必须使用官方 Node adapter；body 只以相同实际字节复核语义参与排名；
- load generator 饱和时改为独立机器/核绑定，不把客户端上限当 server 平价。

## 7. 完成定义

响应、请求、body 三个旧执行路径均已替换；旧 `requestOf`、`Readable.fromWeb`、`pipeline`
和兼容开关不存在；测试矩阵、双形态进程冒烟、Node/Bun 全量、coverage、fmt/lint/
typecheck/build、smoke/example/soak、Tillgate 只读消费验证全部通过；性能按配对统计超过
Hono 并记录 stretch goal 的达成/未达成后，本单元才可标记“已核销”。
