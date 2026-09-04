# keala — 设计文档（定稿）

状态：已按 4 路子代理审计（性能/安全/功能/迁移）修订，用户已批准三项关键决策。
前置阅读：`docs/AUDIT.md`（审计裁决记录）、`docs/MIGRATION.md`（逐条迁移矩阵）。

---

## 0. 决策记录（2026-08-30，用户裁决）

| #   | 决策                                         | 内容                                                                                                                                                                                      |
| --- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | content-type 与 hono 保持一致                | 快速路径返回**裸 `new Response(body)`**，不写 content-type。Bun HTTP 层自动补 `text/plain; charset=utf-8`；`c.text()`/`c.body=` 语义 = hono。进程内消费者看不到 CT 属预期行为，写入文档。 |
| D2  | WebSocket + validator 纳入，**组件化可插拔** | 两者均为独立组件，核心零依赖；不装组件零成本。                                                                                                                                            |
| D3  | 双运行时保留                                 | 核心代码不引用 `Bun` 全局；Node + Bun 双跑测试；bench 三方对比（keala / hono / raw）。                                                                                                    |
| D4  | 消灭 koa3 闭包税                             | 保留注册期预编译链（每请求零 dispatch 闭包）；所有扩展点不允许引入每请求闭包分配。                                                                                                        |
| D5  | 功能组件化可插拔                             | 见 §6 插件协议。核心 = 路由 + 洋葱 + Context + respond，其余皆组件。                                                                                                                      |

审计带来的强制修订（已并入本文）：Response 实例缓存不可行（复验 500 `ERR_BODY_ALREADY_USED`）→ 改为状态重建式缓存组件；性能门禁全部改相对比值；参数路由分桶必须自动回退 trie（防共享首段 128x 退化）；11 条安全契约绑定重写规格；`server.reload()`（`update()` 不存在）。

---

## 1. 定位

Bun 1.4+ 专属的高性能 Web 框架：**hono 的性能与功能面 + koa 的洋葱中间件人体工学**，零依赖、全函数式（无 class）、每文件 ≤500 行。不兼容 koa API（同仓库重写，历史实现存于 git 快照 `dd44353`）。

性能目标（门禁口径见 §8）：进程内 text ≥ 0.90×raw（同 run）、param ≥ 1.05×hono（同 run）；HTTP 层不劣于 hono；1000 路由规模保持 ≥4x 优势。

---

## 2. 请求管线（核心重写）

```
Bun.serve fetch(request, server)
  └─ app.handle(request, runtime)          ← runtime: {server?, remote?, env?} 注入通道
       ├─ 1. path 提取（每请求一次，复用给路由与 ctx）
       ├─ 2. 路由匹配（顶层，非洋葱层）
       │     static Map → bucket matcher → trie（自动回退，见 §5）
       ├─ 3. 执行命中的预编译链
       │     a) 无中间件单 handler → 直接调用（零 compose、零 next 闭包）
       │     b) 链 → 嵌套预编译层（koa compose 语义，double-next 守卫保留）
       ├─ 4. 响应终结（双模，见 §4）
       │     a) handler return Response → 直接用（hono 快路径）
       │     b) return undefined → 从 ctx 平铺状态终结（裸 Response 快路径优先）
       ├─ 5. 未命中 → 全局中间件仍执行（koa 语义保留）→ notFound 处理器
       └─ 6. 错误 → onError；错误路径执行 11 条安全契约（见 §7.1）
```

与 koa 的结构差异：路由从"洋葱的一层"提升为顶层先行（省 76~170ns/请求）；`app.use` 全局中间件在**注册期**编译进每条路由链首（含未命中路径的兜底链）；晚于路由注册的 `use()` 触发全部链 O(routes) 重编（文档明示成本）。

### 开发期链警告（仅 `env: "development"`）

全局中间件在注册期编入每条路由链首（koa 语义）——不调 `next()` 而直接返回的
中间件会吞掉路由。开发模式下 keala 对此给出运行时警告，规则一条：

**已命中的路由从未执行时，按 (app, method, path) 去重各警告一次**，无论停在哪一层：

- 全局中间件不调 `next()` 直接返回（吞掉整条路由，无论是否产出 Response）；
- 任一**非终端**中间件（路由级或 `Router.use` 前缀位置）既不调 `next()` 也未
  产出响应（链停滞，请求走向 notFound 404）。

```text
keala(dev): GET /health matched a route but its handler never ran — global
middleware returned before calling next(). Call next() for requests you
don't handle, or use c.throw() to reject intentionally.
```

不警告的合法形态：有意的拒绝（`c.throw`、抛错走错误路径）、状态式写响应
（`c.body = …`）不调 `next()`、终端 handler 返回 void（untouched → notFound
合同）、未命中路径的全局链（notFound 处理器仍会执行）。

实现要点：路由链编译期在全局中间件与路由层之间编入 reached 标记
（`flags` 位 256），compose 在非终端层 void 返回且未推进时置停滞位（1024；
位 512 由 context 创建时按 env 置位作为 dev 门控）——生产与 test 环境的链
不含标记、每层仅一次 AND 判断，零分配零写入。

## 3. Context：单对象扁平化

每请求 **1 个对象**（koa 为 4 个），字段一次成型（固定隐藏类）：

```ts
interface Ctx {
  // 请求侧（raw + 惰性缓存）
  raw: Request;
  method: string;
  path: string;
  query: QueryMap | null;
  params: Record<string, string> | null;
  ip: string | null;
  state: Record<string, unknown> | null; // 惰性
  runtime: Runtime | null; // server/remote/env 注入
  // 响应侧（平铺状态，终结器直接读）
  status: number;
  body: unknown;
  headers: Record<string, HeaderValue> | null; // 惰性 record
  flags: number; // 位打包：显式状态/空体/多值头/长度触碰
  // body 消费缓存（P1 设计、P2 实现，见 §6.3）
  bodyCache: { text?: string; json?: unknown; formData?: FormData } | null;
  // 扩展（decorate 协议，统一根原型，防 megamorphic；值语义，惰性访问器显式走 decorateLazy）
  [k: symbol]: unknown;
}
```

要点：`c.header(name, value)` 直写 `headers` record（惰性创建）；委托链层数 = 0（koa 有 40 处两跳委托）；`c.state`/`c.throw`/`c.assert`/`c.cookies`（含 signed + keys 轮换）**保留**（koa 人体工学，审计确认必须保留项）。

## 4. 双模响应语义（六条规则，写进 spec）

1. **单一真相源**：每请求一个内部 `res: Response | undefined` 槽。`c.body/c.status/c.header` 是暂存写；handler 返回的 Response 是提交。
2. **return 优先**：叶子 `return Response` → 直接用（同请求设过 `c.body` 则 dev 警告）；中间件在 `await next()` **前** return → 短路；在 `await next()` **后** return → 覆盖下游（最终改写权，hono 语义）。
3. **undefined 由框架兜底**：叶子 undefined 且从未写 body → notFound 处理器；中间件 undefined → 透传下游。
4. **误用检测**：return 非 Response/undefined → dev 模式 throw；`c.setHeader()` 在提交之后调用 → **直写**已提交 Response 的 headers（保证 `c.json()` 直返后仍能补头；0.7 契约——`c.body/c.status/c.redirect` 提交后写则抛 TypeError，见 docs/KEALA-NATIVE-API.md §3）。
5. **错误路径**：链中 throw → `onError(err, c)`；HTTPError 携带可选 Response；onError 结果同样可被外层改写。
6. **body 单次性**：`c.req.json()/text()/formData()/arrayBuffer()/blob()` 全部记忆化到 `bodyCache`（洋葱内多次调用安全）；需重读用 `c.req.clone()`。

**终结器（respond）**：状态与都为默认（200、无自定义头、string/Uint8Array body）→ **裸 `new Response(body)`**（D1，80ns 地板）；有自定义头 → `new Response(body, { headers: Headers 实例 })`（实测比 record init 快 60ns）；JSON 糖走 `Response.json(obj)`（省 74ns）；set-cookie 数组/多值头 → flatten 分支（判定条件全部保留）；204/205/304 清 content 头、HEAD 回填 Content-Length（状态模式从 body 值计算；return 模式由 sugar 助手在 HEAD 时构造期附带精确 CL——**终结器永不读取已提交 body**，开放流生产者不可能阻塞它）、statusText Latin-1 守卫——**判定全部保留**。流响应原样返回，`observeStream` 错误观察改为 opt-in（默认关闭，省 567ns/响应并恢复背压）。

## 5. 路由（混合结构 + 双发射 IR）

```
注册期 compilePattern(path) → PatternIR
  PatternIR = { segments, isStatic, bunSyntax }   // bunSyntax: 可直接发射为 Bun routes 表的 pattern

匹配（顶层，优先级）:
  1. staticRoutes: Map<path, RouteTarget>          // O(1)，静态路径
  2. firstSegmentBuckets: Map<seg, CompiledMatcher[]> // 首段静态的参数路由，注册期编译闭包
       — 桶内模式数 > 8 → 该桶整体落 trie（防共享首段 128x 退化，审计 P0-9）
  3. rootTrie                                       // 复用原 trie（规模化 + wildcard + optional）
  4. 首段即参数（/:org/:repo）→ 专用 paramBuckets

正确性规格（继承自原 trie，配 48 例 router-edge 测试）：
  静态 > 参数 > 通配；:x? 左到右贪心；:id(\d+) pattern；坏 percent-escape 原样回显不 500；
  %2F 不拆段；尾斜杠静态重试；同位置参数名冲突注册期抛错；重复 path+method 注册链式执行。
405/Allow/501：顶层判定（KNOWN_METHOD_LIST 固定顺序）；GET 自动广告 HEAD；OPTIONS 200 空体。
strict/trailing-slash：路由选项 `strict: false`（默认 true），trim 中间件组件提供。
```

## 6. 可插拔组件系统

**插件协议**（D5，核心零依赖）：

```ts
interface Plugin {
  name: string;
  install(app: App): void; // 注册期钩子；可在 listen 前任意顺序插拔
}
app.use(Plugin); // 中间件组件（进链，注册期编译）
app.use(plugin); // 组件实例（bodyParser/ws/validator/cache/…）
```

内建组件全景（全部独立文件、可插拔、不装零成本）：

| 组件                                                                                      | 阶段 | 说明                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| bodyParser                                                                                | P2   | json/text/formData/arrayBuffer/blob + 记忆化；**默认上限 json/text 1MB、formData 10MB**，可配；超限 413 `expose:true`；`JSON.parse` 失败 → 400                                                                                                                                   |
| websocket                                                                                 | P2   | `app.ws("/path", {open,message,close,...})`，Bun 原生 `server.upgrade` 直通；topic publish/backpressureLimit 直暴露                                                                                                                                                              |
| validator                                                                                 | P2   | Standard Schema 协议（zod4/valibot/typebox 通吃）；`c.req.valid()` 出口                                                                                                                                                                                                          |
| logger / cors / csrf / etag / secure-headers / timing / request-id / timeout / body-limit | P2   | 安全默认值见 §7.3                                                                                                                                                                                                                                                                |
| compress                                                                                  | P2   | `Bun.gzip`（异步整包）+ `CompressionStream`（流式）；gzipSync 仅 tiny body                                                                                                                                                                                                       |
| serveStatic                                                                               | P2   | decode→normalize→realpath 包含校验顺序；null 字节拒、symlink 默认拒、nosniff；纯静态目录建议降级 `routes {dir}`（内核 openat2 防穿越）                                                                                                                                           |
| responseCache                                                                             | P3   | **状态重建式**（缓存 body 字符串+共享 Headers 实例，每请求重建 Response ~80ns；**绝不缓存 Response 实例**）。命中条件硬编码：GET/HEAD + 200 + string/Uint8Array + 无 set-cookie/vary + `ctx.cookies` 未触碰；键 = 完整解码 path；含参数路由默认禁用；LRU 上限 + TTL；Date 头剔除 |
| nativeSink                                                                                | P3   | `listen({nativeRoutes:true})`：无鉴权前缀的静态路径 + 静态 Response 下沉 `Bun.serve routes`；**鉴权前缀强制不下沉**；双路由对拍测试（同 URL 集合纯 JS vs 下沉，404/200 必须一致）；热更新用 `server.reload()`                                                                    |
| auth（basic/bearer/jwt）                                                                  | P3   | `Bun.password`（argon2id/bcrypt native）做地基                                                                                                                                                                                                                                   |
| stream / streamText / streamSSE                                                           | P2   | helper；SSE 内建心跳（Bun idleTimeout 默认 10s 必死）；desiredSize 背压感知                                                                                                                                                                                                      |

砍掉（审计裁决）：JSX 体系（保留 `html\`\``+`raw()` 转义协议）、SSG、9 个多运行时 adapter、preset、method-override、powered-by、pretty-json、combine、context-storage（ALS 默认关）。后置：hc RPC client（P1 只留类型累积门：路由注册泛型保留 path 字面量 + TypedResponse）、proxy、ip-restriction、jwk。

## 7. 安全规格（审计 P0-4/5/6 全量并入）

### 7.1 重写规格必须继承的 11 条契约（逐条绑定测试，见 MIGRATION.md §3）

1. 错误路径清头（除 set-cookie 全删）+ 5xx 隐藏 message + `error.headers` 逐个过校验、失败静默丢弃（旧实现 app.ts:286-308）
2. respond 空状态头清理 + HEAD CL 回填 + Latin-1 statusText 守卫（respond.ts:50-97）
3. 裸 Response 快路径前置条件：多值头/set-cookie 必须走 flatten 分支
4. proxy 信任门：一切 X-Forwarded-* 读取以 `proxy===true` 为前提（request.ts:232-279）
5. trie decode 防护：坏转义原样回显、%2F 不拆段（trie.ts:51-59,243-246）
6. pooling 重置契约：全部字段逐一重置 + `delete _routerAllowed`（跨模块依赖，字段守恒测试）
7. compose double-next 守卫
8. url setter 缓存失效链（path/search/querystring/query 五写器）
9. 错误兜底永不抛出（buildErrorResponse 失败回落固定 500）
10. header 名 RFC7230 token + `__proto__/constructor/prototype` 拒绝；值 CRLF/NUL 拒绝
11. cookie jar null 原型（`__proto__` 是合法 cookie token，唯一防线）+ 签名 timingSafeEqual

### 7.2 新能力安全设计

body 解析默认上限（见 §6 bodyParser）；pooling 保持 **opt-in** + guarded 模式（epoch 代际号，回收后写入抛错 + 门禁测试）；routes 下沉鉴权禁沉 + 对拍（§6 nativeSink）；responseCache 命中条件硬编码（§6）；SSE 心跳 + 背压 + 错误事件 sanitize（不含 error.message）；serveStatic 顺序敏感防护 + nosniff；cors：`allowCredentials:true` 绝不回显任意 Origin、`Vary: Origin` 强制、预检不带 set-cookie；secure-headers：HSTS 仅 TLS 上下文建议、nosniff/XFO/Referrer-Policy 默认底座；trustedHosts 白名单钩子（防 Host 伪造中毒 origin/href/back）。

### 7.3 网络层

`idleTimeout` 文档化（默认 10s，SSE 场景调大或心跳）；`maxRequestBodySize` 框架默认（json/text 1MB、formData 10MB，Bun 全局兜底透传）；501 vs 404 提供 `unknownMethodAs404` 开关；reusePort 共享主机提权警示；TLS 透传 + proxy 信任边界部署文档。

## 8. 性能门禁体系（相对比值 + ABAB，审计 P0-2 修订）

基准纪律：ABAB 交错批（keala/raw/hono 同进程同批次循环，每框架 ≥5 批取中位+IQR）；预热至连续 3 批变异 <2%；drain 必须消费 body（堵假快）；整套 ≥3 遍取中位；判定带 ±5% 噪声带；Bun 版本/机器/日期写入 BENCH.md。

| 门禁                        | 判定                                                                      | 阶段  |
| --------------------------- | ------------------------------------------------------------------------- | ----- |
| G1 进程内 text              | keala ≥ 0.90 × 同 run raw                                                 | P1    |
| G2 进程内 param             | keala ≥ 1.05 × 同 run hono                                                | P1    |
| G3 分配预算                 | param 路径每请求 JS 分配 ≤3（现状 ~10）                                   | P1    |
| G4 HTTP 吞吐                | keala ≥ 0.98 × hono（100 与 1000 路由、hit+miss）                         | P1/P4 |
| G5 p99 延迟                 | keala ≤ 1.10 × hono                                                       | P4    |
| G6 路由规模                 | 1000 路由（含**共享首段**形态与 404 miss）keala ≥ 4 × hono                | P1    |
| G7 并发                     | Promise.all 批量 in-flight 下 G1/G2 不回退                                | P1    |
| G8 流/SSE                   | 流响应无 observeStream 税（opt-in 关闭时 ≤ 1.1× raw stream）              | P2    |
| G9 JSON                     | `c.json()` 走 Response.json 杠杆（≥1.15× koa）                            | P1    |
| G10 缓存命中（opt-in 组件） | ≥ 0.80 × 同 run raw                                                       | P3    |
| G11 内存                    | 稳态 RSS/heap ≤ koa；soak 三层漂移 <0.5%                                  | P4    |
| G12 结构围栏                | 零 Promise 同步链、隐藏类键序稳定、字节预算（agent-perf-evidence 重标定） | P1    |

## 9. 双运行时（D3）

核心（app/compose/context/router/respond/utils）不引用 `Bun` 全局——`Bun.serve`/`requestIP`/`routes` 全部经 `adapters/bun.ts` 注入；Node 下 `app.handle` 完整可用（vitest 双跑）；Bun-only 组件（websocket/nativeSink/responseCache 的 Date 处理等）在 Node 下 `install()` 抛明确错误或跳过（`skipIf(!isBun)` 测试模式）。bench 对比固定三方：keala / hono（同版本钉死）/ raw，双运行时数据并列展示。

## 10. 阶段计划（修订版）

| 阶段 | 交付                                                                                                          | 出口门禁                                                          | 估时   |
| ---- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------ |
| P0   | ✅ git 快照 + 四门恢复绿 + 本设计文档 + MIGRATION.md                                                          | 已完成（`dd44353`/`502f594`）                                     | —      |
| P1   | 核心重写：管线/Context/路由混合/终结器 + 11 条契约绑定测试迁移 + bench 基建重建                               | G1/G2/G3/G6/G7/G9/G12 + 迁移套件 ≥550 例绿（构成见 MIGRATION §2） | 3-5 天 |
| P2   | 组件：bodyParser/websocket/validator/中间件套件/stream/SSE + 双模六规则全测试                                 | 全量 ≥900 例 + 新功能 ≥150 例 + 覆盖率 ≥90% + G8                  | 3-5 天 |
| P3   | nativeSink/responseCache/Bun.password auth/pooling guarded                                                    | G10 + G4 不回退 + 双路由对拍 + 下沉鉴权禁沉测试                   | 2-4 天 |
| P4   | 红队（只找不改，账本制）+ soak + 1000 路由复测 + BENCH.md 重测 + PARITY.md 再生 + README/示例/发布面（2.0.0） | 0 高危 + G4/G5/G11 + 总验收清单（MIGRATION §5）                   | 2-3 天 |

红队纪律：写入白名单仅 `test/redteam/`；账本四段式（repro/expect/actual/root）；入口=功能全绿；出口=连续一轮零新增高危；170+ 例安全语料全程保持绿。

## 11. 明确不做的（记录在案）

Response 实例缓存（500 复验）；JSX/SSR；多运行时 adapter；每请求闭包分配的任何扩展点（D4）；进程内可见 content-type 的默认快速路径（D1 取舍）；`app.request/response/context` 原型扩展层（改 decorate + 泛型累积）。
