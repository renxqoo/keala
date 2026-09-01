# DOGFOOD-R2 — 第二位消费者（Hono 迁移者，Tillgate）反馈的裁决与实施

> 状态：已实施
> 级别：中
> 来源：/Users/wrr/work/Tillgate（refactor/hono-to-keala，keala 0.5.1）。八项缺陷逐条对照源码核验：
> 七项属实、一项部分属实；本文件只裁决定实施的四项，其余挂账或属 koa 血统语义。

## 契约

### C1 `readBodyLimited` 热路径优化（保限值语义，收复 facade 2.3 倍差距的读侧成本）

- **declared content-length 已知且 ≤ limit**：预分配 `Uint8Array(declared)`，逐块
  `set` 直填，零 chunks 数组、零二次拷贝；谎报长度（实际字节 > declared）回退到
  溢出块重组；截断（< declared）返回零拷贝 `subarray`。运行中超限仍 413。
- **无 declared（chunked）**：保留逐块计数路径，新增「单块即完 → 原样返回」（零拷贝）。
- **不处理**：把 `json()` 委托给原生 `raw.json()`——消费者建议的这行修复会拆掉 413
  预算，与其自身 P1-5/#8 安全诉求冲突（用户裁决：保限值，不做委托）。
- 既有合同不变：单次读取记忆化（`cache.bytes`）、declared 超限快速 413、
  超限中途 cancel、空体零字节、facade 各 reader 限值复检。

### C2 dev no-next 警告扩展到路由级中间件位置（P0-1 残留）

- 0.6.0 的 C4 警告只覆盖 app.use 全局位置；Tillgate 的 jsonBody 经 Router.use/路由级
  注册编为 prefixMiddleware（在 marker 之后），静默 404 不可见。
- 机制：compose 的 `makeLevel` 在「层返回 void 且未推进且下游非终端」时置
  `flags` 位 1024（CHAIN_STALLED）；位 512（DEV_CHAIN）由 context 创建/回收时按
  `app.env === "development"` 置位——生产链每层仅多一次 AND 判断，不读不写。
- 警告条件（dispatch `finish()`，与 C4 互斥按 ROUTE_REACHED 区分）：命中路由
  （marker 已置）+ 链停滞位 + 全链无响应产出（`_res` 空 && 未写 status/body）
  → 该请求将以 notFound 404 收尾，按 (app, method, path) 去重 console.warn 一次。
- **不警告**的合法形态：终端 handler 返回 void（合同：untouched → notFound）、
  状态式写响应不调 next、中间件 throw/返回 Response（C4 或正常路径）。
- 不处理：未命中路径的全局链停滞（notFound handler 仍会执行，与预期 404 不可区分）。

### C3 文档三补（en/zh 同步）

- `onError`（emitter 观察者）/ `onerror`（koa 日志钩子）都不产出错误响应——错误响应
  由框架错误路径构建；需要自定义信封时在全局中间件里 try/catch `await next()`。
- `notFound` handler **必须 return Response**：它在 finalizer 内执行，throw 走通用
  错误面（keala `createError(status,{expose})` 会正确渲染；自定义错误类型按未知
  错误 500）。
- hono 迁移表补三行：`c.url` 是 path+search（绝对地址用 `c.raw.url`）、
  `app.onError` 语义差异、`app.notFound` 必须 return。

### C4 导出与机器可读 code

- 根出口新增类型导出：`Next`（types.ts）、`RouteHandler`（router/router.ts）。
- `HttpErrorProps` 文档化 `code?: string` 字段；body-parser 的畸形 JSON 413/400、
  超限 413 错误带上 `code`（`invalid_json` / `payload_too_large`），消费者不再用
  message 正则区分（Tillgate P2-8 末项）。

## 挂账（本轮不做，记录归属）

- 注册泛型 `get<C extends Context>`（Tillgate #4）：Application 全接口改造 + decorate
  安全性由约定保证的语义问题，独立裁决后另开一轮。
- 多层洋葱按层数开销 + 内存 2 倍平台 profile（Tillgate #7）：与本仓 DOGFOOD-R1 的
  底噪调查合并，需 Haswell/heap 实测，不做盲改。
- 路径作用域 `use(pattern, mw)`（P1-4）：架构级新增，涉及 404/405 鉴权语义裁决。
- 请求流拦截点 / 流级 bodyLimit（P1-5）：架构级，长期。

## 测试口径

- C1：declared 快路径（正常/截断/谎报超限 413/declared 超限 413）、chunked 单块
  零拷贝、chunked 超限 413、memoization 不变（两次 reader 同值）、空体、
  facade json/text/formData 回归全绿（既有 plugins-body-parser 套件）。
- C2：路由级中间件 void-no-next + 无响应 → dev warn 一次且去重；终端 handler void
  → 不警告；void 后下游 handler 未执行断言 404；状态式写响应不调 next → 不警告；
  prod/test 不警告；全局位置仍由 C4 覆盖（回归）；throw → 不警告。
- C4：entry-surface 词表 + `code` 字段断言（`isHttpError(e) && e.code === "..."`）。
- 性能证据：/tmp 微基准（facade json() 优化前后 + raw.json() 对照），数字进收口记录，
  不进 CI 断言。

## 收口实测数字（2026-09-01，Bun 1.4.0 / M4）

- 测试：Node 门 92 文件 1860 过 / 2 skip；Bun 门 92 文件 1837 过 / 25 skip。
- 覆盖率：96.89 / 91.68 / 95.63 / 98.41（R1 后基线 96.90 / 91.64 / 95.61 /
  98.40 —— 语句 −0.01、分支 +0.04、函数 +0.02、行 +0.01，整体持平）。
- C1 性能（in-process facade json() echo，25 字节 declared 体，含每请求
  Request 构造 ~305ns）：
  - 优化前 reader 循环+拼接：1291 ns/req
  - R2 第一版（预分配直填）：1325 ns/req —— 仅省 ~22ns，拼接拷贝不是大头
  - **终版（declared 预检后原生 `arrayBuffer()` 单发读 + 零拷贝视图）：987
    ns/req（−23.5%）**；对 `raw.json()` 直读（618ns）的比值 2.09x → 1.60x，
  限值语义全保留（declared 预检 413 + 读后谎报长度守卫 413 + chunked 路径
  逐字节计数）。
  - 分解结论：facade 对象创建仅 ~39ns（不值得原型化）；剩余差距在
  记忆化/异步双 promise 结构与 JS 侧 decode+parse，属有界读取设计的固有成本。
  - 消费者建议的「json 委托 raw.json()」按方案裁决否决（拆 413 预算）。
- 挂账不变：注册泛型、路径作用域 use、流拦截点、层数/内存平台 profile。
