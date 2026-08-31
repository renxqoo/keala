# Honu

[English](./README.md) | 简体中文

**Koa 的人体工学 + Hono 的速度，融于同一个 context —— 基于
[Bun 1.4+](https://bun.sh)，零依赖。**

```bash
bun add @renxqoo/honu
```

## 快速开始

```ts
import { Honu } from "@renxqoo/honu";

const app = new Honu();

app.get("/", (c) => c.text("hello honu")); // hono 风格 return
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
import { Router } from "@renxqoo/honu";

const api = new Router({ prefix: "/v1" });
api.param("oid", async (c, next) => {
  /* 组织守卫 */ await next();
});
api.get("/orgs/:oid", (c) => c.text("org"));

app.mount("/api", api);
```

同样跑在 Node 上 —— 同一个应用，多一行导入：

```ts
import { listen } from "@renxqoo/honu/node";
listen(app, 3000);
```

## 为什么选 honu

- **Hono 级速度。** ABAB 交错的 HTTP 基准显示 honu 与 Hono 统计持平
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
- **生产级硬化。** **1800+ 测试在 Node 与真实 Bun 双运行时全绿**
  （90 个文件），七轮红队审计、每个缺陷测试先行修复，与真实
  koa/hono/negotiator 包做差分模糊测试，外加路由表等价性模糊验证。
  每次变更过四道质量门（fmt / lint 0 错误 / tsc / 双运行时测试）。
- **安全优先的默认值。** 头写入拒绝 CRLF/NUL 与控制字节、查询与
  Cookie 映射防原型污染、RFC 6265 Cookie 校验、签名 Cookie 恒时比较、
  生产环境绝不外泄堆栈的 `expose` 语义、表单解析字节与部件双重预算。

基准装置中还包含 Go `net/http` 参照：在对比机器上，Go 在吞吐上领先
所有 JS 运行时（包括裸 `Bun.serve`）约 10–15%，内存优势更为悬殊 ——
差距来自运行时的 HTTP 栈，而非框架开销（相对于 hono，honu 在其上
没有增加任何东西）。见 `bench/BENCH.md`。

## 中间件、插件与 helper

三种生命周期，一个 `app.use()` 入口。**只有 middleware 与 adapter 被
拆分出去** —— middleware 层是最重的一层（加载约 2.7MB），而 adapter
是互斥的运行时选择，因此它们放在各自的子路径下，根入口保持一次导入
即得完整应用面：

| 入口                   | 提供什么                                                                    | 加载量             |
| ---------------------- | --------------------------------------------------------------------------- | ------------------ |
| `@renxqoo/honu`                 | Honu / Router / compose / Context / errors / cookies / bodyParser / helpers | 应用面             |
| `@renxqoo/honu/middleware`      | 一次导入拿到全部中间件工厂                                                  | 整个 middleware 层 |
| `@renxqoo/honu/middleware/cors` | 单个工厂                                                                    | 仅该文件           |
| `@renxqoo/honu/node`   | Node 监听器（bun/node 互斥）                                                | 仅该文件           |

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
} from "@renxqoo/honu/middleware"; // 聚合入口 —— 也可按文件导入：honu/middleware/cors
import { createBodyParser, hashPassword, verifyPassword, streamSSE, html, raw } from "@renxqoo/honu";

app.use(createBodyParser({ jsonLimit: 1024 * 1024 })); // PLUGIN：安装 c.req.json()/text()/formData()…
// formData() 采用双重预算：formLimit 字节 AND formPartLimit 个部件
// （默认 1000 —— 数千个微型部件是一种内存放大攻击向量，
// 单纯的字节上限拦不住）。
app.use(cors({ origin: ["https://app.site"], allowCredentials: true }));
app.use(secureHeaders());

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
// 要求应用没有全局/参数中间件（原生路由表会绕过它们 ——
// sink() 与 app.use(fn) 会对此显式报错）。
app.sink("/health", new Response("ok")); // 静态响应，被原生复用
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

| 请求侧                                        | 响应侧                                         | 语法糖（return 风格）            |
| --------------------------------------------- | ---------------------------------------------- | -------------------------------- |
| `c.raw/method/path/url/query`                 | `c.status/body/message/type/length`            | `c.text(str, status?, headers?)` |
| `c.get(name)` / `c.header(name)`              | `c.set/append/remove/vary/has/resHeader`       | `c.json(obj, status?, headers?)` |
| `c.params` `c.query` `c.ip/ips/host/hostname` | `c.etag/lastModified/attachment/redirect/back` | `c.html(str, status?, headers?)` |
| `c.accepts*/is/fresh/stale/charset`           | `c.cookies`（签名、密钥轮换）                  | `c.throw/assert`                 |

双模式规则各一句话：**返回的 `Response` 立即提交；`c.*` 写入先暂存；
最后一个提交者获胜；未被写过的请求落入 `app.notFound`**。路径命中但
方法不匹配时回答 405 + `Allow`（OPTIONS 得到 200 + `Allow`，未知方法
501）。

## 从 koa 迁移

| Koa                                                     | honu                                                |
| ------------------------------------------------------- | --------------------------------------------------- |
| `ctx.request.get("x")`                                  | `c.get("x")`                                        |
| `ctx.response.set("x", v)` / `ctx.set(...)`             | `c.set("x", v)`                                     |
| `ctx.body = x` / `ctx.status = n`                       | `c.body = x` / `c.status = n`（相同）               |
| `ctx.throw(404, "msg")` / `ctx.assert(...)`             | `c.throw(404, "msg")` / `c.assert(...)`             |
| `app.use(router.routes()).use(router.allowedMethods())` | 直接 `app.get(...)`，或 `app.mount(prefix, router)` |
| `new Koa({ proxy: true })`                              | `new Honu({ proxy: true })`                         |
| `ctx.state.user`                                        | `c.state.user`（相同）                              |
| `ctx.cookies.get/set`                                   | `c.cookies.get/set`（相同，签名 + keys）            |

有意为之的差异（见 `docs/DESIGN.md` §0）：字符串响应体不再由框架设置
`content-type`（运行时会默认给 `text/plain`；需要显式类型请用 `c.type`
或语法糖）；不再做标记嗅探；对象响应体在读取 `c.body` 时保持对象形态。

## 为什么快

| Koa (Node)                               | honu (Bun)                                                       |
| ---------------------------------------- | ---------------------------------------------------------------- |
| **每次请求**重新编译分发闭包             | 链在**注册时**一次性编译                                         |
| 每个中间件跳转都包一层 `Promise.resolve` | 全同步链**零 Promise** 返回                                      |
| `req`/`res` 对象 + 头部重序列化          | Web `Request`/`Response` 原生直通                                |
| 急切的 body/URL 处理                     | query、cookies、客户端 IP、`state` 全部**惰性**                  |
| 路由正则遍历                             | 静态 = 一次 `Map` 命中；简单参数 = 编译好的 matcher；其余 = trie |
| 每请求三个 context 对象                  | **一个**扁平 context 对象                                        |
| 路由作为洋葱的一层运行                   | 路由发生在链**之前**（hono 模型）                                |
| 响应用 header map 重建                   | 裸 `new Response(body)` 快速路径；对象走 `Response.json`         |

## API

### 应用

| 成员                                                                           | 说明                                                                                                                                          |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `new Honu(options?)`                                                           | 应用类（koa 风格的 `new`）。选项：`keys`、`proxy`、`proxyIpHeader`、`maxIpsCount`、`subdomainOffset`、`env`、`silent`                         |
| `app.use(...mw)`                                                               | 全局中间件，编译进每条路由链（延迟 `use` 会重新组合）                                                                                         |
| `app.get/post/put/patch/delete/head/options/all(path, ...handlers)`            | 路由注册；命名形式 `app.get(name, path, ...handlers)`                                                                                         |
| `app.on(method, path, ...handlers)`                                            | 任意方法、任意大小写                                                                                                                          |
| `app.mount(prefix, routerOrApp)`                                               | 表合并挂载（404 穿透到父级）；子应用的全局中间件会被前置                                                                                      |
| `app.param(name, mw)`                                                          | 作用于所有捕获该参数的路由的中间件                                                                                                            |
| `app.handle(request, runtime?)`                                                | fetch 风格处理器；`runtime = { server?, remote?, env? }` 为 `c.ip` 和 websocket 升级提供数据                                                  |
| `app.listen(port?, host?, cb?)`                                                | 启动 `Bun.serve`；返回 Bun 的 `Server`（带 `reload()`）；`onServeError` 可选覆盖 500 处理器。Node 下请改用 `@renxqoo/honu/node` 的 `listen()` |
| `app.sink(path, Response \| { dir })` / `app.reloadNativeRoutes()`             | 把静态路由沉入 Bun 原生路由表；在运行中的服务器上热重载该表                                                                                   |
| `app.onError(fn)` / `app.notFound(fn)`                                         | 错误订阅与自定义 404；`silent`/`env: "test"` 会抑制默认日志                                                                                   |
| `app.decorate(key, value)`                                                     | 扩展每个 context（安装期进行；重复/核心 key 抛错 —— 绝不静默遮蔽）                                                                            |
| `app.ws(path, handlers)`                                                       | WebSocket 路由（仅 Bun；重复路径在安装时抛错）                                                                                                |
| `app.redirect(src, dest, code?)` / `app.url(name, params)` / `app.route(name)` | 重定向路由与命名 URL 构建                                                                                                                     |
| `app.callback()`、`app.toJSON()`                                               | 适配与自省                                                                                                                                    |

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
import { Honu } from "@renxqoo/honu";
import { listen } from "@renxqoo/honu/node";

const app = new Honu();
app.get("/", (c) => {
  c.body = "hello";
});
listen(app, 3000, "127.0.0.1", () => console.log("up"));
```

适配器对流式转发请求体（绝不缓冲），带真实背压地管道输出响应，展开
`set-cookie`，对畸形 HTTP 回答 400，并暴露 `port/hostname/stop/fetch/
ready()`，与 Bun 句柄的形状保持一致。WebSocket 仅限 Bun：`app.ws()`
路由回答 501，裸 Upgrade 请求在协议层直接拒绝。Node 原生模块
（crypto/fs）全部惰性加载 —— 空闲的 `import "honu"` 不加载任何桥接
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
  - `test/redteam*.test.ts` —— 加固阶段确认的 11 组 bug 的红队回归锁，
    外加 `matchRoute ≡ pure trie` 等价性模糊测试（每次运行 100 张随机
    路由表 × 120 条路径）
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
  http/         状态码表、错误工厂
  negotiation/  带 q-values 的 accepts/*、type-is
  router/       静态 Map + 模式 trie（多变体参数）+ 路由工厂
  middleware/   逐请求管道工厂（16 个）+ index.ts 聚合入口
  middleware/   逐请求管道工厂（16 个）
  plugins/      安装期安装器（body-parser）
  helpers/      handler 内工具（流/SSE、html、password）
  adapters/     bun.ts（Bun.serve 胶水）、node.ts（官方 node:http 适配器）
  utils/        url/query/text/mime 工具、node-lazy（惰性内建桥接）
```

MIT 许可证。主运行时 Bun ≥ 1.4（也可通过 `@renxqoo/honu/node` 在
Node 下运行）。
