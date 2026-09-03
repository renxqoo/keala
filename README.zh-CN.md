# Keala

[English](./README.md) | 简体中文

**Koa 的人体工学 + Hono 的速度，融于同一个 context —— 基于
[Bun 1.4+](https://bun.sh)，零依赖。**

```bash
bun add keala
```

## 快速开始

```ts
import { Keala } from "keala";

const app = new Keala();

app.get("/", (c) => c.text("hello keala")); // hono 风格 return
app.get("/users/:id(\\d+)", (c) => c.json({ id: c.params.id }));
app.get("/page", (c) => {
  // koa 风格 state
  c.type = "text/html";
  c.body = "<b>hi</b>";
});

app.listen(3000);
```

路由分组通过表合并挂载（未命中的路径穿透到父级，404 不会被吞掉）：

```ts
import { Router } from "keala";

const api = new Router({ prefix: "/v1" });
api.param("oid", async (c, next) => {
  /* 组织守卫 */ await next();
});
api.get("/orgs/:oid", (c) => c.text("org"));

app.mount("/api", api);
```

同样跑在 Node 上 —— 同一个应用，多一行导入：

```ts
import { listen } from "keala/node";
listen(app, 3000);
```

## 为什么选 keala

- **Hono 级速度。** ABAB 交错的 HTTP 基准显示 keala 与 Hono 统计持平
  （所有比值落在运行噪声内），**比 Koa 3 快 3.0–3.5 倍**（1000 条路由
  时 15 倍），且在参与对比的 JS 框架中峰值内存最低 —— 同时保留惰性
  内容协商、签名 Cookie、405/Allow 合成与完整洋葱模型。中间件链在
  注册时编译一次；全同步路径零 Promise 分配；路由发生在洋葱之前
  （静态路由 = 一次 `Map` 命中）。
- **双模 API、单一扁平 context。** `return c.json(...)`（hono 式）与
  `c.body = ...; c.status = 404`（koa 式）自由混用 —— 最后提交者胜。
  每个请求只分配一个 context 对象；`query`、`cookies`、`ip`、`state`
  均为首次访问时才物化。
- **零运行时依赖。** 一切内置：CORS、CSRF、认证、ETag、压缩、静态
  文件、SSE、body 解析、Standard Schema 校验、WebCrypto 密码哈希、
  支持密钥轮换的签名 Cookie。
- **Bun 原生超车道。** `app.sink()` 将静态路由直接沉入 Bun 原生路由表
  （每请求零 JS 执行）并镜像为普通路由；`serveStatic` 走 `Bun.file`
  sendfile；WebSocket 走原生 socket 升级；`streamSSE` 内置 Bun 官方的
  空闲超时对策。
- **久经考验。** **1800+ 测试在 Node 与真实 Bun 双运行时全绿**
  （90 个文件），针对注入、原型污染、请求走私、恶意滥用等真实
  攻击手法加固，行为与 koa、hono 本尊逐项比对验证。每次变更过
  四道质量门（格式 / lint / 类型 / 双运行时全量测试）。
- **安全优先的默认值。** 头写入拒绝 CRLF/NUL 与控制字节、查询与
  Cookie 映射防原型污染、RFC 6265 Cookie 校验、签名 Cookie 恒时比较、
  生产环境绝不外泄堆栈的 `expose` 语义、表单解析字节与部件双重预算。

基准装置中还包含 Go `net/http` 参照：在对比机器上，Go 在吞吐上领先
所有 JS 运行时（包括裸 `Bun.serve`）约 10–15%，内存优势更为悬殊 ——
差距来自运行时的 HTTP 栈，而非框架开销（相对于 hono，keala 在其上
没有增加任何东西）。见 `bench/BENCH.md`。

## 中间件、插件与 helper

三种生命周期，一个 `app.use()` 入口。**只有 middleware 与 adapter 被
拆分出去** —— middleware 层是最重的一层（加载约 2.7MB），而 adapter
是互斥的运行时选择，因此它们放在各自的子路径下，根入口保持一次导入
即得完整应用面：

| 入口                    | 提供什么                                                                                           | 加载量             |
| ----------------------- | -------------------------------------------------------------------------------------------------- | ------------------ |
| `keala`                 | Keala / Router / compose / Context / errors / cookies / bodyParser / helpers / HTTP 与 fs 安全原语 | 应用面             |
| `keala/middleware`      | 一次导入拿到全部中间件工厂                                                                         | 整个 middleware 层 |
| `keala/middleware/cors` | 单个工厂                                                                                           | 仅该文件           |
| `keala/node`            | Node 监听器（bun/node 互斥）                                                                       | 仅该文件           |

- **middleware** —— 逐请求的管道函数：`app.use(cors())`
- **plugins** —— 安装期的安装器（`install(app)`），为 context 装饰成员：`app.use(createBodyParser())`
- **helpers** —— 在 handler 内调用：`streamSSE(c, ...)`、`hashPassword(pw)`

```ts
import {
  cors,
  csrf,
  csrfToken,
  csrfTokenGuard,
  basicAuth,
  bearerAuth,
  etag,
  compress,
  secureHeaders,
  timing,
  requestId,
  logger,
  bodyLimit,
  timeout,
  serveStatic,
  validator,
} from "keala/middleware"; // 聚合入口 —— 也可按文件导入：keala/middleware/cors
import { createBodyParser, hashPassword, verifyPassword, streamSSE, html, raw } from "keala";

app.use(createBodyParser({ jsonLimit: 1024 * 1024 })); // PLUGIN：安装 c.req.json()/text()/formData()…
// formData() 采用双重预算：formLimit 字节 AND formPartLimit 个部件
// （默认 1000 —— 数千个微型部件是一种内存放大攻击向量，
// 单纯的字节上限拦不住）。
app.use(cors({ origin: ["https://app.site"], allowCredentials: true }));
app.use(secureHeaders());

// 零依赖可观测:per-key 限流 + Prometheus 指标
app.use(rateLimit({ limit: 100, windowMs: 60_000 })); // 429 + Retry-After
const m = metrics(); // 状态类计数、in-flight、时延分桶
app.use(m.middleware);
app.get("/metrics", m.page); // Prometheus 文本

app.post("/users", validator(schema), (c) => c.json(c.valid)); // Standard Schema
app.get("/feed", (c) =>
  streamSSE(c, async (sse) => {
    sse.send({ data: tick() });
  }),
);
app.get("/page/:slug", (c) => c.html(html`<h1>${c.params.slug}</h1>`)); // 自动转义
app.ws("/chat", {
  open(ws) {
    /* 原生 Bun socket */
  },
  message(ws, data) {},
});
```

## Bun 原生快速路径（P3）

```ts
// app.sink() —— 由 Bun 原生路由表直接服务（每请求零 JS 开销），
// 同时镜像为普通路由，app.handle() 因此处处可用。
// 参数中间件永远拒绝下沉；全局/作用域中间件须经 noOpFor() 透明性
// 声明豁免（sink() 与 app.use() 会大声拒绝违规组合）。下沉是 Bun
// 原生优化 —— Node 上镜像语义相同但更慢，Node 部署不要对热路由下沉。
app.sink("/health", new Response("ok")); // 静态响应，被原生复用
app.sink("/users/:id", (request, params) => new Response(`user ${params["id"]}`)); // 函数下沉：
// 无中间件/Context/sugar，只收 (request, params) → Response；错误走
// 内置 funnel（app.onError() 与函数下沉互斥，双向拒绝）
app.sink("/assets/*", { dir: "./public" }); // 目录树（index/Range）
app.listen({ port: 3000 }); // 路由表在启动时内嵌
app.sink("/ping", new Response("pong")); // 后续 sink → server.reload()
app.reloadNativeRoutes(); // 或显式重建路由表

// 密码：默认 WebCrypto PBKDF2-SHA-256（Bun/Node 之间可移植 ——
// Bun 1.4.0 自带的 Bun.password.verify 和 node:crypto.scrypt
// 在某些平台上是坏的）。bunPasswordHasher() 可显式选用 argon2id。
const hash = await hashPassword(pw); // pbkdf2$600000$…
await verifyPassword(hash, pw); // true/false，坏数据一律按失败处理

// 签名 CSRF token：Bun 上原生走 Bun.CSRF，Node 上回退为 HMAC。
const tokens = csrfToken({ secret: process.env.CSRF_SECRET! });
app.use(csrfTokenGuard({ service: tokens, sessionId: (c) => sessionCookie(c) }));
app.get("/form", (c) => c.html(formWithHidden(tokens.issue(sessionCookie(c)))));
```

`basicAuth`/`bearerAuth` 中间件负责解析与质询（RFC 7617/6750）；校验
始终委托给你的 `verify` 回调。`serveStatic` 的响应体在 Bun 下是
`new Response(Bun.file(path))`（sendfile、自动 Content-Length、
Range），在 Node 下则缓冲后输出。`streamSSE` 在心跳之外，还通过
`server.timeout(req, 0)` 关闭该请求的空闲超时 —— 这正是 Bun 官方
给出的 SSE 处理方式。

### 读取请求体

`c.raw` **就是**标准的 web `Request` —— 零配置即可读体：

```ts
app.post("/echo", async (c) => {
  const text = await c.raw.text(); // 或 .json()、.arrayBuffer()、.formData()
  return c.text(text.toUpperCase());
});
```

每次调用都会消费底层流 —— 每个请求只读一次。`createBodyParser` 插件
则为所有 handler 安装记忆化、有界的读取器：`c.req.json()` /
`c.req.text()` / `c.req.formData()` 超限回答 413、畸形输入回答暴露的
400，表单双重预算（字节 AND 部件数）。底层的一次性有界读取助手
`readBodyLimited` 同样导出，供自定义读取器使用。

### HTTP 与 fs 安全原语

`serveStatic` 背后经过审计的语义是公开 API —— 做文件型产品的消费者
直接复用一份实现，而不是各自重新推导一遍：

```ts
import { weakEtag, isNotModified, resolveRelativeSegments, isWithinRoot, findSymlink } from "keala";

const segments = resolveRelativeSegments(path, sep === "\"); // 先分段 → 逐段解码 → 归一化；null = 拒绝
const absolute = resolve(root, segments.join("/"));
if (!isWithinRoot(absolute, root, sep)) c.throw(403);
if ((await findSymlink(root, absolute)) !== null) c.throw(403); // 首个符号链接组件，或 null

const etag = weakEtag(stat.size, stat.mtimeMs); // W/"<size-hex>-<mtime-hex>"
if (isNotModified({ etag, mtimeMs: stat.mtimeMs, ifNoneMatch: c.get("if-none-match"), ifModifiedSince: c.get("if-modified-since") })) {
  return new Response(null, { status: 304 });
}
```

| 组件                                  | 要点                                                                                                                                                                                     |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createBodyParser`                    | 一次有界的记忆化读取；每个读取器都会重新校验各自的限制（413）；畸形 JSON/formData → 抛出 400                                                                                             |
| `validator`                           | Standard Schema（zod 4 / valibot / typebox）；issues → 400；结果放在 `c.valid`                                                                                                           |
| `cors` / `csrf`                       | 携带凭证时要求 origin 白名单；反射 origin 始终带 `Vary: Origin`（恒定回答 `*` 的不带 —— 它永不变化）；拒绝 `Origin: null`；只处理真正的预检（带 `Access-Control-Request-Method` 的请求） |
| `etag` / `compress`                   | 弱 tag + 304（If-None-Match 优先级遵循 RFC 9110）；异步 gzip，gzip 实现可注入用于测试                                                                                                    |
| `serveStatic`                         | 解码 → 归一化 → 包含性检查；NUL 字节 400；出现任一符号链接组件即拒绝（目录也算）；index 路径重新做包含性检查                                                                             |
| `streamSSE` / `stream` / `streamText` | 帧 CRLF/CR 净化、心跳对抗 Bun 的 10s 空闲超时、`onAbort`、背压信号                                                                                                                       |
| `html` + `raw()`                      | 标签模板转义；信任标记是一个 Symbol —— 无法通过 JSON 伪造                                                                                                                                |
| `bodyLimit` / `timeout`               | 带 Content-Length 的请求快速 413；墙钟 504 并收敛漂浮的 Promise                                                                                                                          |
| `app.ws`                              | 原生 `server.upgrade`；事件按路由分发，并携带请求 context                                                                                                                                |

## Context：一个扁平对象

每个请求只分配一个 context。请求与响应在同一个对象上；一切惰性属性
（`query`、`cookies`、`ip`、`state`）在首次访问时才物化。

| 请求侧                                                                | 响应侧                                         | 语法糖（return 风格）            |
| --------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------- |
| `c.raw/method/path/url/query`                                         | `c.status/body/message/type/length`            | `c.text(str, status?, headers?)` |
| `c.get(name)` / `c.header(name)`                                      | `c.set/append/remove/vary/has/resHeader`       | `c.json(obj, status?, headers?)` |
| `c.params` `c.query(name)` `c.queries(name)` `c.ip/ips/host/hostname` | `c.etag/lastModified/attachment/redirect/back` | `c.html(str, status?, headers?)` |
| `c.accepts*/is/fresh/stale/charset`                                   | `c.cookies`（签名、密钥轮换）                  | `c.throw/assert`                 |

双模式规则各一句话：**返回的 `Response` 立即提交；`c.*` 写入先暂存；
最后一个提交者获胜；未被写过的请求落入 `app.notFound`**。路径命中但
方法不匹配时回答 405 + `Allow`（OPTIONS 得到 200 + `Allow`，未知方法
501）。

`c.query(name)` 是定向读(0.6.2):返回 `name` 的首个值(缺失为
`undefined`;裸尾键读作 `""`),解码规则 `+` → 空格、`%XX`,非法转义原样
保留。重复键用 `c.queries(name)` 收集。不再有全量 Map——建表每请求
~111ns,边界匹配扫描只要 ~2ns,而 `c.query.name` 属性形态无法比它读取的
对象更懒。需要枚举时用 `c.querystring`(原始串)。键按原文或规范
encodeURIComponent 形态匹配;非规范编码的非保留字符(`%5F` 代 `_`)不在
匹配路径上解码。

## 全局中间件与路由顺序 —— 头号陷阱

路由发生在洋葱**之前**，但全局 `app.use()` 中间件会包裹**每条路由的
处理函数**（koa 语义）：中间件不调用 `next()` 而直接返回 Response，
该路由就永远不会执行 —— 下面的 `/health` 回答的是中间件的 404，
而不是它自己的 handler：

```ts
app.use(markdown()); // 服务文件；未命中时直接 404，不调 next()
app.get("/health", (c) => c.text("ok")); // 永远不会执行
```

「处理其余一切」有两种受支持的形态：

- **会谢幕的全局中间件**：对你不处理的请求调用 `next()` —— 这是
  keala 对 `app.use()` 中间件的合同；
- **通配路由**：显式路由天然优先于通配，顺序不再重要：

```ts
app.get("/health", (c) => c.text("ok"));
app.get("/*", markdownHandler); // 只接住没被认领的请求
```

只属于某个静态路径或子树的中间件可以在安装期限定作用域：

```ts
app.use("/oauth/*", auth()); // 匹配 /oauth 本身及全部子路径
app.use("/health", probeHeaders()); // 只匹配精确路径
```

作用域层保持注册顺序，并且仍会覆盖作用域内的 404、405 与自动 OPTIONS。
作用域外的已注册路由没有请求期前缀判断：适用层在编译路由链时已经选定。
pattern 有意只支持静态精确路径和末尾独立 `/*`；参数、正则或中段通配会在
注册期抛错。

`env: "development"` 下，中间件停掉链导致已命中路由从未执行时，keala 会
按 (method, path) 警告一次；生产环境零开销（规则详见 `docs/DESIGN.md` §2）。

## 从 koa 迁移

| Koa                                                     | keala                                               |
| ------------------------------------------------------- | --------------------------------------------------- |
| `ctx.request.get("x")`                                  | `c.get("x")`                                        |
| `ctx.response.set("x", v)` / `ctx.set(...)`             | `c.set("x", v)`                                     |
| `ctx.body = x` / `ctx.status = n`                       | `c.body = x` / `c.status = n`（相同）               |
| `ctx.throw(404, "msg")` / `ctx.assert(...)`             | `c.throw(404, "msg")` / `c.assert(...)`             |
| `app.use(router.routes()).use(router.allowedMethods())` | 直接 `app.get(...)`，或 `app.mount(prefix, router)` |
| `new Koa({ proxy: true })`                              | `new Keala({ proxy: true })`                        |
| `ctx.state.user`                                        | `c.state.user`（相同）                              |
| `ctx.cookies.get/set`                                   | `c.cookies.get/set`（相同，签名 + keys）            |

有意为之的差异（见 `docs/DESIGN.md` §0）：字符串响应体不再由框架设置
`content-type`（运行时会默认给 `text/plain`；需要显式类型请用 `c.type`
或语法糖）；不再做标记嗅探；对象响应体在读取 `c.body` 时保持对象形态。

## 从 hono 迁移

| Hono                                               | keala                                                                 |
| -------------------------------------------------- | --------------------------------------------------------------------- |
| `new Hono()`                                       | `new Keala()`                                                         |
| `app.get(path, (c) => c.json(...))`                | 相同的 return 风格                                                    |
| `c.req.param("id")`                                | `c.params.id`                                                         |
| `c.req.query("q")`                                 | `c.query("q")`（同款惯用法；重复键 `c.queries("q")`）                 |
| `c.req.header("x")`                                | `c.get("x")`                                                          |
| `await c.req.json()`                               | `await c.raw.json()`（零配置）或解析插件的 `c.req.json()`             |
| `app.use(mw)`                                      | 相同 —— 但吞掉路由时会给出[开发警告](#全局中间件与路由顺序--头号陷阱) |
| `app.notFound(fn)` / `app.onError(fn)`             | `app.notFound(fn)` / `app.onError(fn)`                                |
| `hono.route("/api", subApp)`                       | `app.mount("/api", router)`（表合并；404 自然落穿）                   |
| `app.fetch(req)` → `Response \| Promise<Response>` | `await app.handle(req)` → 恒为 `Promise<Response>`，永不 reject       |
| `Bun.serve({ fetch: app.fetch })`                  | `app.listen(port)` —— Bun.serve 已内建                                |
| `new Hono({ strict: false })`                      | 没有 strict 模式：`/path` 与 `/path/` 是同一条路由                    |
| `new URL(c.req.url())`                             | `c.url` 是 path+search（koa 形态）；绝对地址是 `c.raw.url`            |
| `app.onError(fn)` 产出错误响应                     | 同样返回 Response；额外支持返回 void 使用内置响应                     |
| `app.notFound(fn)` 可以 throw                      | 必须 `return` Response —— throw 落入通用 500 路径                     |

值得知道的差异：`c.body` 是**响应**体（hono 的请求体在 `c.raw` 或解析
插件上）；中间件按 koa 语义运行 —— 见

## 错误处理：onError、notFound

`app.onError(mapper)` 是唯一错误入口（单槽；重复注册会抛错）：

```ts
app.onError((error, c) => {
  // 副作用就是观察机制：在这里统一日志与遥测
  if (error.status >= 500) logger.error({ err: error.stack, url: c.url });
  // 返回 Response 接管错误响应；不返回则使用 keala 内置响应
  return c.json({ error: { code: error.code ?? `HTTP_${error.status}` } }, error.status);
});
```

- mapper 恒定收到 `HttpError`（`status`/`expose`/`code`/`headers`）；普通
  抛出物会被归类为不暴露细节的 500。
- 接管响应保留自身头；`error.headers`（如 `WWW-Authenticate`）和已暂存
  的安全头只补空位。运行时给出的不可变 Response 会在确需合并时重建
  一次；HEAD 响应会剥除 body。
- 错误漏斗覆盖 handler/middleware 抛错、`c.throw`、finalize 失败和 ws
  upgrade 拒绝。
- mapper 抛错、拒绝或返回非 Response/非 `undefined` 值时，框架会响亮
  `console.error` 并返回静态 500；只有 `undefined` 表示使用内置响应。
- 未注册 mapper 时，非 test 环境的 5xx 保留框架 console 兜底；注册
  `app.onError(() => {})` 可显式静默。
- `app.notFound(fn)` 必须 **return** 一个 Response；其中抛错会进入通用
  错误漏斗。
  [全局中间件与路由顺序](#全局中间件与路由顺序--头号陷阱)。

## 为什么快

| Koa (Node)                               | keala (Bun)                                                      |
| ---------------------------------------- | ---------------------------------------------------------------- |
| **每次请求**重新编译分发闭包             | 链在**注册时**一次性编译                                         |
| 每个中间件跳转都包一层 `Promise.resolve` | 全同步链**零 Promise 跳转**（`handle` 边界仅一次已决议 Promise） |
| `req`/`res` 对象 + 头部重序列化          | Web `Request`/`Response` 原生直通                                |
| 急切的 body/URL 处理                     | query、cookies、客户端 IP、`state` 全部**惰性**                  |
| 路由正则遍历                             | 静态 = 一次 `Map` 命中；简单参数 = 编译好的 matcher；其余 = trie |
| 每请求三个 context 对象                  | **一个**扁平 context 对象                                        |
| 路由作为洋葱的一层运行                   | 路由发生在链**之前**（hono 模型）                                |
| 响应用 header map 重建                   | 裸 `new Response(body)` 快速路径；对象走 `Response.json`         |

## API

### 应用

| 成员                                                                           | 说明                                                                                                                                  |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `new Keala(options?)`                                                          | 应用类（koa 风格的 `new`）。选项：`keys`、`proxy`、`proxyIpHeader`、`maxIpsCount`、`subdomainOffset`、`env`                           |
| `app.use(...mw)`                                                               | 全局中间件，编译进每条路由链（延迟 `use` 会重新组合）                                                                                 |
| `app.use(path, ...mw)`                                                         | 静态精确路径或末尾 `/*` 作用域中间件；同样覆盖作用域内的 404/405                                                                      |
| `app.get/post/put/patch/delete/head/options/all(path, ...handlers)`            | 路由注册；命名形式 `app.get(name, path, ...handlers)`                                                                                 |
| `app.on(method, path, ...handlers)`                                            | 任意方法、任意大小写                                                                                                                  |
| `app.mount(prefix, routerOrApp)`                                               | 表合并挂载（404 穿透到父级）；子应用适用的全局/作用域中间件会被前置                                                                   |
| `app.param(name, mw)`                                                          | 作用于所有捕获该参数的路由的中间件                                                                                                    |
| `app.handle(request, runtime?)`                                                | fetch 风格处理器 → `Promise<Response>`，永不 reject；`runtime = { server?, remote?, env? }` 为 `c.ip` 和 websocket 升级提供数据       |
| `app.listen(port?, host?, cb?)`                                                | 启动 `Bun.serve`；返回 Bun 的 `Server`（带 `reload()`）；`onServeError` 可选覆盖 500 处理器。Node 下请改用 `keala/node` 的 `listen()` |
| `app.sink(path, Response \| { dir } \| handler)` / `app.reloadNativeRoutes()`  | 把静态路由沉入 Bun 原生路由表；在运行中的服务器上热重载该表                                                                           |
| `app.onError(mapper)` / `app.notFound(fn)`                                     | 单槽错误映射器（`Response \| void`）与自定义 404；`env: "test"` 抑制默认 console 兜底                                                 |
| `app.decorate(key, value)`                                                     | 扩展每个 context（安装期进行；重复/核心 key 抛错 —— 绝不静默遮蔽）                                                                    |
| `app.ws(path, handlers)`                                                       | WebSocket 路由（仅 Bun；重复路径在安装时抛错）                                                                                        |
| `app.redirect(src, dest, code?)` / `app.url(name, params)` / `app.route(name)` | 重定向路由与命名 URL 构建                                                                                                             |
| `app.callback()`、`app.toJSON()`                                               | 适配与自省                                                                                                                            |

### Context

一个扁平对象 —— 请求侧、响应侧与语法糖共享它：

- 请求：`raw method url path query querystring search originalUrl URL host
hostname protocol secure ip ips subdomains origin href fresh stale idempotent
charset reqType reqLength headers get/header is accepts acceptsEncodings
acceptsCharsets acceptsLanguages params state`（`url`/`path`/`query` 可写；
  重写会使缓存失效，行为与 koa 完全一致）
- 响应：`status message body type length etag lastModified attachment
redirect back set append remove vary has resHeader cookies`
- 语法糖：`text/json/html(body, status?, headers?)` —— 可直接从 handler
  返回
- `c.throw(status, msg?, props?)`、`c.assert(cond, status, ...)`

### Cookies

`c.cookies.get(name, { signed })` / `c.cookies.set(name, value, options)`，
支持 `maxAge expires path domain secure httpOnly sameSite partitioned
priority overwrite signed`。签名采用 HMAC-SHA256 并支持密钥轮换
（Keygrip 格式：`value.signature`）；未配置 keys 时签名读取一律按失败
处理。

### Router

`new Router({ prefix })` 为 `app.mount` 分组路由。模式：`:name`、
`:name(\\d+)`（自定义正则）、`:name?`（可选）、`*`（通配尾部）。匹配
优先级 static > param > wildcard；HEAD 回落到 GET handler（Express
风格）；405 + `Allow`、OPTIONS 200、未知动词 501 内建于分发 —— 不需要
`allowedMethods()` 中间件。同一位置使用不同自定义模式的参数
（`/users/:id(\\d+)/a` 与 `/users/:id/b` 相邻）是独立变体 —— 每棵子树
都保持可达；同一位置参数**名字**冲突仍在注册时抛错。

## 在 Node 下运行

核心是 fetch 形态、不绑定运行时；官方 Node 适配器放在独立子路径，因此
在 Bun 上导入框架永远不会加载 node:http 桥接：

```ts
import { Keala } from "keala";
import { listen } from "keala/node";

const app = new Keala();
app.get("/", (c) => {
  c.body = "hello";
});
listen(app, 3000, "127.0.0.1", () => console.log("up"));
```

适配器对流式转发请求体（绝不缓冲），带真实背压地管道输出响应，展开
`set-cookie`，对畸形 HTTP 回答 400，并暴露 `port/hostname/stop/fetch/
ready()`，与 Bun 句柄的形状保持一致。WebSocket 仅限 Bun：`app.ws()`
路由回答 501，裸 Upgrade 请求在协议层直接拒绝。Node 原生模块
（crypto/fs）全部惰性加载 —— 空闲的 `import "keala"` 不加载任何桥接
（Bun 上少约 2.8MB RSS）；crypto 桥在第一次签名 Cookie / CSRF 回退 /
密码校验时才加载。

## 质量门禁

```bash
bun run test        # vitest（在 Node 下同样可跑）
bun run coverage    # statements/branches/functions/lines 四维 >90% 阈值
bun run lint        # oxlint（强制 max-lines 500）
bun run fmt         # oxfmt
bun run typecheck   # TypeScript 7 native（tsc --noEmit）
bun run verify      # 一条命令跑完以上全部
bun run smoke       # 启动真实 Bun.serve 并走一遍所有关键路径
bun run soak        # 内存浸泡：进程内 + HTTP + 并发，堆必须稳定
bun run bench       # 对比 hono / koa / fastify / raw / Go 的基准装置
```

- **1800+ 个测试在 Node 与真实 Bun 运行时下全绿**（90 个文件，
  `bun run test` / `bun run test:bun`），包括：
  - `test/adapters-node.test.ts` —— Node 适配器在两个运行时下跑真实
    socket（桥接、set-cookie 展开、流式、HEAD、400/500/501 失败面）
  - `test/security*.test.ts` + `agent-security-audit` —— 注入 / 污染 /
    泄露 / 滥用 / 代理信任用例（255+ 断言）
  - `test/redteam*.test.ts` —— 开发过程中全部已确认缺陷（85+ 个）的
    回归锁，外加 `matchRoute ≡ pure trie` 等价性模糊测试（每次运行
    100 张随机路由表 × 120 条路径）
  - `test/anomalies*.test.ts`、`matrix`、`agent-bugs`、
    `agent-concurrency*` —— 从 koa 语料移植的完整异常输入与状态机矩阵
  - `test/parity-security.test.ts` —— 安全相关的 koa 语义对齐
    （GHSA-c5vw-j4hf-j526、redirect/back 同源、expose 门…）
- 覆盖率四个维度阈值 >90%，由 `bun run verify` 强制执行。
- soak：48 万+ 进程内请求、3.2 万真实 HTTP 请求与并发洪泛 —— 进程内
  保留堆漂移 ≤ 0.1 B/请求（预算 1500 B）。

## 安全

- 头名称/值均做校验（拒绝 CRLF/NUL —— 无响应拆分）；
  `__proto__`/`constructor`/`prototype` 不能作为头名称
- query 与 cookie 映射使用受保护对象 —— 无原型污染
- Cookie 值/名称在序列化前按 RFC 6265 校验
- 5xx 错误消息在响应中隐藏（`expose` 语义与 Koa 相同）；生产 `env`
  永不泄露堆栈
- 签名 Cookie 使用 `timingSafeEqual` 比较

## 项目结构

```
src/
  core/         应用、compose（预编译洋葱）、dispatch、respond、sink、emitter
  context/      cookies + HMAC 签名
  http/         状态码表、错误工厂、条件请求原语
  negotiation/  带 q-values 的 accepts/*、type-is
  router/       静态 Map + 模式 trie（多变体参数）+ 路由工厂
  middleware/   逐请求管道工厂（16 个）+ index.ts 聚合入口
  plugins/      安装期安装器（body-parser）
  helpers/      handler 内工具（流/SSE、html、password）
  adapters/     bun.ts（Bun.serve 胶水）、node.ts（官方 node:http 适配器）
  utils/        url/query/text/mime/路径安全工具、node-lazy（惰性桥接）
```

MIT 许可证。主运行时 Bun ≥ 1.4（也可通过 `keala/node` 在
Node 下运行）。
