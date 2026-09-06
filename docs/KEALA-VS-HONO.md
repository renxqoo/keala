# keala vs hono 4.13.5 —— 逐 API 面实现对比

> 回答一个问题：**两边的 API 各自实现得更好？** 只看实现质量与可验证行为
> （源码 file:line + 探针实证），不谈 bench 数字（见 bench/route-shootout/）。
> hono 源码取自 node_modules/hono@4.13.5（与 .parity/hono 同版）；行为断言
> 均在 Bun 下双框架并排实测。诚实是本文档的第一原则——hono 更优的面
> 明确写出，keala 的自报短板也不遮掩。

## 总览

|   # | 面           | 判定             | 一句话                                                    |
| --: | ------------ | ---------------- | --------------------------------------------------------- |
|   1 | 路由核心     | 平手（取舍）     | hono 模式语法更宽；keala 结构性优先级 + 内置 405/命名路由 |
|   2 | Context/请求 | 平手（取舍）     | keala 单对象全惰性 + ip/协商内置；hono 类型生态宽         |
|   3 | 响应面       | **keala 略优**   | HEAD 保真 / 204 清洗 / redirect 中和三项协议正确性实证    |
|   4 | 错误处理     | **keala 略优**   | 永不泄漏、永不 reject、错误页安全头必达                   |
|   5 | 中间件模型   | **keala 优**     | 注册期编译链，请求期零组合零逐跳 promise                  |
|   6 | Body 解析    | **keala 明显优** | 默认字节+部件双预算；hono 核心零预算                      |
|   7 | Cookie       | **keala 优**     | 密钥轮换 + fail-closed + secure 派生                      |
|   8 | 安全中间件   | 分项             | cors keala 优；secureHeaders **hono 明显优**（有 CSP）    |
|   9 | 流式         | **keala 略优**   | Bun 存活三件套全有；hono 写背压内建                       |
|  10 | WebSocket    | 平手             | keala 路由级+drain（Bun only）；hono 多运行时抽象         |
|  11 | 生命周期     | **keala 明显优** | 优雅停机/准入/deadline 全在核心，hono 无对应物            |
|  12 | 性能实现结构 | **keala 优**     | 每请求 1 对象、零组合、planned-response、原生 sink        |
|  13 | TS/DX        | **hono 明显优**  | 路径→validator→RPC 全链类型化是代差                       |
|  14 | Node 适配    | 平手             | hono 全覆盖（HTTP/2/ws）；keala 直写+停机集成更深         |

计分：keala 优 6 面 + 略优 3 面；hono 明显优 2 面（TS/DX、secureHeaders）；
平手 4 面。**结论：运行期正确性与生产件 keala 密集占优；类型系统、DX 生态、
安全头覆盖 hono 占优。**选型按部署形态取舍，不是单边碾压。

---

## 1. 路由核心 —— 平手（取舍不同）

**优先级模型**：keala 是结构性优先级——trie 显式"静态先弹、参数次之、通配最后"
（src/router/trie.ts:197-239），实测注册顺序无关。hono 是注册顺序优先：先注册
`/users/:id` 再注册 `/users/admin` 时 `/users/admin` 命中**参数路由**（实测）；
更实际的坑：`app.get('/api/*')` 先注册、再 `app.route('/api', sub)`，
`/api/hit` 被通配**吞掉**落 404（实测）。hono 匹配器本身是一流的
（SmartRouter→RegExpRouter：per-method 静态 map + 单条巨型正则，
reg-exp-router/matcher.ts:16-24）；keala 是 staticMap → slice 快匹配器 →
全表单正则 → trie 四层（src/router/match.ts:93-127）。

**模式语法**：hono 更宽——`:id{[0-9]+}` 约束、`:x?` 可选、`:path{.+}` 跨段命名
捕获（实测 `/tail/a/b` → `tail:"a/b"`）。keala 有 `:name`/`:name(\d+)`/`:name?`/
`*`（固定名 wildcard），无跨段命名捕获；但编译期校验更严（空段、`**`、模式后悬
文本注册即抛错，pattern.ts:53-99）。

**keala 独有**：内置 **405+Allow 合成 / OPTIONS 200 / 未知方法 501**
（respond.ts:59-83）——hono 默认全 404，要用户挂 `methodNotAllowed()` 中间件
且它靠事后翻转 404、自认分不清 `app.use` 与 `app.all`（其源码注释）；
**命名路由** `app.get(name, path)` + `app.url(name, params)`——hono 核心
无（实测 `app.url === undefined`）；**晚注册**永远可用（epoch 失效重编译）——
hono 首请求后再加路由直接抛 "matcher is already built"（实测）。

**%2F**：双侧等价（解码后仍是单段，不重入路由）。

## 2. Context / 请求面 —— 平手

keala 每请求**一个**扁平对象（惰性槽位默认值全在原型，context.ts:139-171）；
hono 是 `new Context` + 首触再 `new HonoRequest` 两个对象（hono-base.ts:422、
context.ts:366-369）。query 双方都做了定向优化，但 hono 的 URL 含 `%`/`+` 时
回落全量解析且无缓存（utils/url.ts:261-322），keala 恒为边界扫描+记忆化
（utils/query.ts:120-187）；**keala 无 query 全量枚举**（设计裁决——定向读无
原型污染面），这是真实的能力缺口。ip/代理信任模型（转发链/剥端口/maxIpsCount）
与 accepts/is 类型协商 keala 内置；hono 核心无，靠适配器 helper。hono 的
`c.env/c.executionCtx/c.var` 是 Workers 生态位，类型面更宽。

## 3. 响应面 —— keala 略优（协议正确性实证）

return Response 模型双方同构（staged 头合并、提交后写头、next 后替换全部实测
一致）。差别在协议保真：

- **HEAD**：keala 在 sugar 构造期就建 HEAD 视图——实测带精确 `Content-Length: 5`
  与 content-type。hono 把 HEAD 转派 GET 再 `new Response(null,...)`——实测
  **CL 与 CT 双 null**（连 content-type 都丢）。
- **204/304 清洗**：keala 无条件净化（body 与 content-* 头一起剥，respond.ts:
  sanitizeEmptyStatus）；hono 运行时**放行 bodied 204**——实测
  `c.text("oops", 204)` 带 4 字节 body 和 content-type 上 wire（RFC 9110 §8.6
  违约面；类型层用 ContentfulStatusCode 挡，运行时没挡）。
- **redirect**：keala 有开放重定向中和（`//evil.com` → 同源编码路径）；
  hono 无此层。

hono 的可变性表达力更强（`c.status()` 可写、`c.res` 可整体替换）——但代价是
finalized 后克隆整个 Response（context.ts:519-523）与上述协议坑。keala 的
`c.status` 只读、替换靠 return，模型窄而稳。

## 4. 错误处理 —— keala 略优

keala 单漏斗三件套有实证完备性：**永不泄漏**（非 expose 的 5xx message 不进
body；hono 的 HTTPException 默认 `getResponse()` 把 err.message 原样进 body——
`throw new HTTPException(500, {message:"db conn string"})` 会泄漏，实测）；
**永不 reject**（app.handle 双层 guard；hono fetch 对非 Error throw 会 rethrow
炸穿，hono-base.ts:400-405）；**安全头必达错误页**（staged 头 + error.headers
的 if-absent 合并、set-cookie 拼接、content 头禁并，error-response.ts:117-316）。
hono 的模型更灵活（HTTPException 携带 res、onError 可重复注册后者覆盖、
middleware 级 onError），但框架级不保证错误页带头。

## 5. 中间件模型 —— keala 优（结构性）

hono 的 compose 忠实复刻 koa-compose（其注释自认）：多 handler 请求**每请求
重建组合闭包**（hono-base.ts:451）且 dispatch 是 async——**每一跳一个
promise**（compose.ts:32,51）。keala 在注册期把链编译为嵌套 level
（src/core/compose.ts:162-175"composition cost is paid once at
registration"），请求期零组合、全同步链零 promise；单 handler 路由走
DIRECT_HANDLER 直通（dispatch.ts:193-282）。中间件的 scope 选择 keala 也是
编译期静态分析（always/never/conditional，middleware-stack.ts:317-409）。
DX 双方各有亮点：keala 的 dev 吞路由/stall 警告 vs hono 的
"Did you forget to return a Response?"——都是好错误。

## 6. Body 解析 —— keala 明显优

keala 默认就是安全位：json/text 1MB、form 10MB 字节预算 + multipart **部件数**
预算（默认 1000，内存放大围栏）+ 每个 reader 二次复验（先宽后窄也兜住）+
declared Content-Length 快速 413（plugins/body-parser.ts:102-247）。
hono 核心**零预算**——`c.req.json()` 无上限，等价防护要用户知道去装
`bodyLimit` 可选件。hono 独有 `parseBody` 的 `all/dot` 表单语义（数组/嵌套）
与已消费 body 的请求重建（cloneRawRequest）。

## 7. Cookie —— keala 优

双侧都做了认真工程（400 天上限、partitioned-secure 约束都有）。keala 胜在
**密钥数组轮换**（新签旧验无缝换钥，cookies.ts:41-58）+ timing-safe 比较 +
未配 keys 时 signed 读**fail-closed 抛错** + `secure` 从请求 TLS 派生（session
降级防护）。hono 是单 secret 无轮换（helper/cookie:17）、WebCrypto 异步签名；
胜在有 `__Secure-`/`__Host-` 前缀处理与 deleteCookie 便利件。

## 8. 安全中间件 —— 分项判定

- **cors：keala 优**——`allowCredentials:true` + `origin:"*"` 的规格非法组合
  注册即抛（hono 可同时生效）；只拦真 preflight（带 ACM 头，hono 拦一切 OPTIONS
  会劫持用户自建的 OPTIONS 路由）；白名单反射必带 `Vary: Origin`（含 403 拒绝
  路径——缓存投毒防线，hono 覆盖不全）。hono 胜在 origin/methods 支持函数与异步。
- **secureHeaders：hono 明显优**——完整 helmet 移植（CSP/nonce/
  Permissions-Policy 构建器/COOP/COEP/Report-To）。keala 只有 nosniff/XFO/
  Referrer-Policy 等，**无 CSP**——安全面的实质差距。keala 胜在一点：写在
  `finally` 里，**错误页也带防护头**（hono 在 next() 之后 set，handler 抛错时
  防护头不上错误页）。
- **csrf：各有覆盖**——keala 双模型（Origin/Referer 校验 + 签名 token 服务
  `csrfToken()` 带 session 绑定/TTL/常数时间校验）；hono 有 Sec-Fetch-Site 与
  自定义 handler，但以表单 content-type 为门——JSON 请求跳过。
- **auth**：hono 功能多（静态账密/回调/onSuccess）；keala 解析更严（UTF-8
  fatal、NUL/长度上限、realm 注入剥离、invalid_token 区分）且永远委托 verify。
- **validator**：hono 类型面明显优（六 target 的 in/out 织入 c.req.valid 与
  RPC）；keala 用 Standard Schema v1（zod4/valibot 零适配）+ body 预算继承。
- keala 另有 hono 核心没有的 `rateLimit`/`metrics`；hono 货架更宽
  （jwt/jwk/ip-restriction/language/combine…）。

## 9. 流式 —— keala 略优（Bun 现实问题）

SSE 能在 Bun 上活下来需要三件事，keala 全有：关 10s idleTimeout（官方 remedy，
helpers/streams.ts:17-22）、默认心跳+闭连接自动清理、CR/CRLF **清洗**而非抛错。
hono 的 streamSSE 无心跳、无 idle 处理，event/id 含换行直接抛错；但它的写入经
TransformStream **自带背压**（keala 的 send 是同步 enqueue，背压要用户看
desiredSize）——这点 hono 更好。静态文件：hono 有预压缩探测（br/zstd/gz）；
keala 有完整路径安全链——**hono 的 serve-static 默认照常服务 dotfile**
（root 下有 `.env` 就是 200，实测面），keala 默认忽略 dotfile、拒绝符号链接。

## 10. WebSocket —— 平手

keala：路由级 `app.ws()`、origin 白名单在升级前 403、open socket 计入优雅
停机排水、错误有钩子——Bun only。hono：WSContext 运行时无关抽象 +
Node/Deno/CF 适配，无 origin 策略、无 drain 概念。按部署形态各有最优解。

## 11. 生命周期 —— keala 明显优（hono 无对应物）

优雅停机（drain→排空→强停 + readiness 翻转 + `onShutdown` 钩子）、过载准入
（maxConcurrency/maxQueue/queueTimeout，context 创建之前拒绝）、请求 deadline
（504 + `c.signal` abort + 迟到僵尸结算收容）——全在 keala 核心
（core/lifecycle*.ts；Node 适配器按 **wire 真相**计 in-flight 并在排水时
`connection: close`）。hono 源码 grep SIGTERM/graceful/shutdown 零命中；
Bun 形态连 server 都是用户自己写。自管进程的生产件这是 keala 的独有面。

## 12. 性能实现结构 —— keala 优（只看结构不看数字）

每请求分配：keala 1 对象 + 每层 1 闭包，静态路由返回注册期冻结的产物（零
match 对象）；hono 2 对象 + 多 handler 时每请求重建 compose 闭包 + 逐跳
promise。keala 的 planned-response 在默认 200 时**不构造原生 Response**
（Bun 直接用、Node 直写字节）；`app.sink()` 把热路由沉进 Bun 原生表——
hono 无对应档位。诚实注：keala 的 `pooling:true` 是 README 自报的负优化
（面向分配敏感嵌入场景），不是卖点。

## 13. TS / 开发体验 —— hono 明显优

hono 的泛型链（路径字面量→param 类型收窄→validator in/out→`hono/client`
端到端类型化 RPC）是护城河；jsdoc 全覆盖 + hono.dev + 大生态。keala 的
`ContextExtensions` 声明合并只覆盖 decorate 面，路径参数/query/validator 结果
不进类型——用运行期守卫（loud failure + dev 警告）补，类型维度不在同一档。

## 14. Node 适配 —— 平手

@hono/node-server：全覆盖工程（HTTP/2、ws 集成、全局对象原型层、early-hints、
请求体 drain）。keala/node：窄而深——planned-response 零 WebStream 直写、
外来流真背压（drain/close/error 三 listener）、framing 防呆、**wire 级优雅
停机集成**；无 HTTP/2、ws 明确 501。

---

## 两个诚实注脚

1. keala 的 pooling 是自报负优化（docs/HOTPATH-R4-7-POOLING-AB.md），本文
   不列为优势。
2. keala 的 validator 类型保真弱于 hono 一档（运行时槽位是 unknown +
   `validOf<T>()` 手动收窄）——选型时若端到端类型化是硬需求，这是 hono 的
   决定性优势。

（证据细节：双侧 file:line 已内联；行为断言的探针脚本与输出存于本仓库
bench/route-shootout/diag/ 与本次评审记录。hono 侧行号基于 4.13.5 源码树
.parity/hono/src/。）
