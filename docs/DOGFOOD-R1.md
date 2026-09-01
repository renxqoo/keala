# DOGFOOD-R1 — 首位真实消费者反馈的六项裁决与实施

> 状态：已实施
> 级别：中
> 来源：keala-markdown（首位 npm 消费者，全程 dogfood）第一手反馈。
> 六条逐项在源码核实为真（零假 bug），A 类三条为 API 设计缺陷，B 类三条为文档缺口。

## 契约

### C1 `app.handle()` 收窄为 `Promise<Response>`（原 `Response | Promise<Response>`）

- `Application.handle(request, runtime?): Promise<Response>`、
  `Application.callback(): (request, runtime?) => Promise<Response>`。
- `ServerHandle.fetch` 同步收窄为 `Promise<Response>`（与 Bun `Server#fetch` 签名一致）。
- **内部同步快路径保留**：compose/dispatch/respond 的零 promise 链不动，
  仅公共边界做一次 `result instanceof Promise ? result : Promise.resolve(result)`。
  同步链在边界多付一次已决议 promise 分配；异步链零额外开销。
- **既有永不抛出/永不拒绝合同直接继承**：`retireWithBody` 的锁定 reader 防护
  （AUDIT R5-2，已修复于 `pool.ts`，锁 `agent-r5-runtime.test.ts:138,157`）已使
  `handle()` 实际永不抛出；边界不再添加防御性 catch（无可触达的同步抛出路径，
  不留投机死代码）。
- 联合类型从公共面删除，不留兼容层（消费者 `.then()` 链直接可用）。

### C2 HTTP/fs 安全原语提升到主出口

新模块（单一真相；serveStatic 与 etag 中间件改为消费方，库内重复一并消除）：

- `src/http/conditional.ts`
  - `weakEtag(size: number, mtimeMs: number): string` — `W/"<size-hex>-<mtime-hex>"`
  - `isNotModified(input: FreshnessInput): boolean`，`FreshnessInput = { etag, mtimeMs, ifNoneMatch, ifModifiedSince }`
    （参数形状采纳消费者 keala-markdown `paths.ts` 的既有形态，其 ~24 行重写可逐字替换）
  - 语义（RFC 9110）：If-None-Match 存在时独占判定（`*` 通配；`W/` 前缀两侧忽略）；
    否则 If-Modified-Since：`Date.parse(x) >= mtimeMs - 999`（999ms 容差 = HTTP 日期 1s 粒度；
    `Date.parse` 非法值得 NaN，比较自然为 false）。内部 `etagMatches` 同时供 etag 中间件复用。
- `src/utils/path-safety.ts`（自 `middleware/serve-static.ts` **迁移**，非再导出）
  - `resolveRelativeSegments(rawPath, windowsSeparators): string[] | null`
  - `isWithinRoot(absolute, root, sep): boolean`
  - `findSymlink(root, filePath): Promise<string | null>` — root 下首个 symlink 组件路径，
    无则 null；组件中途消失返回 null（原 serveStatic 内联为抛 404，语义并入读取路径）。

主出口新增值导出五个函数 + `FreshnessInput` 类型；
`keala/middleware/serve-static` **不再**导出 `resolveRelativeSegments`/`isWithinRoot`（单轨）。

### C3 `c.query` 形态显性化

- 主出口新增类型导出：`QueryMap`、`QueryValue`（纯类型，零运行时成本）。
- `query` getter 补 JSDoc：懒解析、null 原型普通对象、单值 string / 重复键 string[]、
  `__proto__`/`constructor`/`prototype` 键丢弃。
- README（en/zh）context 表同步说明。

### C4 开发模式吞路由警告（B4 运行时部分）

- 触发条件（全部满足）：`app.env === "development"`；请求命中了已注册路由的方法链；
  链正常 settle（**非**异常路径——中间件 `c.throw`/抛错不触发）；全局中间件未调用
  `next()` 导致首个路由层处理函数从未执行。
- 机制：`RouterState.devTrace`（app 构造时按 env 置位）→ `chainOf` 在全局中间件与
  路由层之间编入 marker（仅 dev、仅有全局中间件的 compose 链；`direct()` 快路径无
  中间件不可能吞路由，不编入）→ marker 置 `c.flags` 位 256（ROUTE_REACHED，复用
  位域不增隐类槽位）→ `dispatchChain` 成功路径（`finish()`，先查位后 finalize）检测。
- 每(app, method, path)仅警告一次（WeakMap 去重）；`console.warn` 输出，文案英文中性、
  指引两出口（不处理的路径调 `next()`；有意拒绝用 `c.throw`）。
- 生产/test 环境零开销：无 marker、无检测对象分配。
- 不处理：前缀/param 中间件吞自己路由的处理函数（路由作用域守卫是有意设计）；
  未命中路径的全局 404（koa 合同本身）。README 新章节覆盖心智模型（B4 文档部分）。

### C5/C6 README（en/zh 同步）

- 「全局中间件与路由顺序」章节：洋葱包裹路由（koa 语义）vs hono 心智、
  通配方 `app.get("/*", ...)`（显式路由天然优先）、dev 警告说明。
- 「读取请求体」指引：无插件一等路径 `await c.raw.text()/json()`（c.raw 即标准
  Request）；推荐 `createBodyParser`（记忆化 + 限额）与 `readBodyLimited`。
- 「Migrating from hono」表（获客对象；含 `app.fetch` → `await app.handle` 对应）。
- 修缮：`app.handle` API 行补返回类型；Project layout 重复行删除。

## 问题域

- 处理：公共类型收窄、原语迁移与导出、dev 警告、README/zh-CN 文档补齐、词表锁更新、版本 0.6.0。
- 不处理：keala-markdown 仓库自身改造（归属消费者，升级 keala 后自行删除重复 ~50 行）；
  AUDIT R5-2 锁定 reader 同步抛（已挂账，本次语义保持不变）；hono 式路由优先执行模型
  （明确不做——koa 语义是本框架的立身合同）。

## 并发/一致性预算

- dev 警告：marker 为链编译期一次性编入；每请求仅 dev 且命中路由链时分配一个
  trace 对象；去重 Set 按 app 弱引用，键空间 = method+path（有界于路由表）。
- 生产热路径：不编 marker、不分配 trace、不查位——与现状零差异。
- `handle` 边界：同步链 +1 次已决议 Promise 分配（JSC 优化路径，量级 ns）；
  异步链 +0。

## 拆分与依赖方向

```
src/http/conditional.ts   ← 新（纯函数；etag.ts、serve-static.ts 消费）
src/utils/path-safety.ts  ← 新（自 serve-static 迁入；serve-static 消费）
src/index.ts              ← 值/类型导出提升（不引入 middleware 层依赖）
src/core/{app,application,dispatch}.ts  ← C1 边界 + C4 检测
src/router/router.ts      ← RouterState.devTrace + chainOf marker
src/core/context/state.ts ← flags 位 256 文档
```

依赖方向不变：middleware → http/utils；root 不反向依赖 middleware。

## 实施顺序

1. 失败测试先行（dogfood-r1.test.ts：C1-C4 契约 + entry-surface 词表更新）。
2. C2/C3 原语迁移与导出（serveStatic/etag 改消费方，删内联重复）。
3. C1 边界收窄（app/application/adapters 类型 + 边界包装）。
4. C4 dev 警告（router marker + dispatch 检测 + 去重）。
5. README en/zh + docs；版本 0.6.0。
   每步四门全绿（oxfmt / oxlint / tsc / vitest --coverage），Bun 门（test:bun）与 smoke 收口复跑。

## 裁决

- 【用户裁决】不留任何兼容老代码的路径；`keala/middleware/serve-static` 的原语导出
  直接迁走，升级通知由维护者负责。
- 【用户裁决】六条建议全部采纳（1 类型收窄 + 2 导出提升 + 3 文档缺口 + dev 警告与
  README 章节【B4 二选一取双】）。
- 默认裁决（否决窗口）：原语落主出口而非新建 `keala/http` 子路径——errors/status
  助手已在主出口，再开子路径会造成双轨或搬迁破坏；`isNotModified` 用消费者的
  record 形态而非位置参数；警告放 dispatch 成功路径而非 finish 后（区分异常路径）；
  内部同步快路径保留（README「零 promise」表述限内部链，边界付一次已决议 promise）。

## 测试口径

- C1：sync/async/异常/404/405/HEAD 处理器下 `handle()` 均 `instanceof Promise` 且
  await 语义正确；`.then()` 直链（消费者痛点）类型与运行时皆通；同步抛出仍同步冒出；
  pooling 变体同契约；`callback()`/`ServerHandle.fetch` 签名一致。
- C2：`weakEtag` 格式表；`isNotModified` 表驱动（INM 命中/未命中/`*`/W/ 形/空 INM
  走 IMS/新鲜/陈旧/999ms 边界/非法日期）；`findSymlink`（无链→null、链文件→路径、
  链目录组件→路径、组件消失→null、root 自身是链→不查）；`resolveRelativeSegments`
  语义回归（迁移后原 serve-static 测试保持全绿）；主出口词表 == 文档词表（entry-surface）。
- C4：吞路由→warn 一次且去重；`next()` 后正常→无警告；中间件 throw→无警告；
  prod/test env→无警告；未命中路径全局 404→无警告；无全局中间件→无警告；
  通配路由配方→正常服务无警告。
- 回归：既有 90 文件套件全绿（Node + Bun 双门）。

## 验收清单

- [x] 契约 C1-C6 逐条（见 test/dogfood-r1.test.ts + entry-surface + README diff）
- [x] 边界/异常清单（同步抛出、非法日期、组件消失、pooling 回收位清理）
- [x] 预算（生产零开销断言 + bench 对比无回归）
- [x] 四门 + 覆盖率数字（收口报告如实记录）

## 收口实测数字（2026-09-01，Bun 1.4.0 / darwin arm64）

- 测试：Node 门 91 文件 1841 过 / 2 skip；Bun 门 91 文件 1818 过 / 25 skip（skip 集合不同源于运行时专属用例）。
- 覆盖率（全量门禁数字）：语句 96.90 / 分支 91.64 / 函数 95.61 / 行 98.40 ——
  四维较改前基线（96.79 / 91.57 / 95.39 / 98.35）均上升。
- 性能（bench/verify-baseline.ts 同机 A/B，改前 → 改后 median）：
  keala text 416ns → 388ns、keala param 516ns → 498ns；未改动的对照帧
  raw 262→242ns、hono 401→370ns 同向漂移 ±8% —— keala 变化在跑间噪声内，
  Promise 边界无可测回归（in-process handle() 逐请求正是该边界的最敏感探针）。
- 已知存量（非本次引入）：smoke 的「runtime content-type over HTTP」在
  本机 Bun 1.4.0 对无显式 content-type 的字符串体回答 application/octet-stream，
  改动前同样失败；仓内以 README「运行时默认 text/plain」为准，留观察。
