# keala 使用手册

> 洋葱模型的 web 框架，零依赖，跑在 Bun 1.4+ 与 Node 上。
> 一个扁平 context、一种响应形态（`return`）、一条预编译中间件链。

```bash
bun add keala        # Bun（主力运行时）
npm add keala        # Node 也可跑
```

---

## 1. 五分钟上手

一个完整可跑的应用，覆盖了 90% 的日常形态：

```ts
import { Keala } from "keala";
import { createCookies } from "keala";
import { cors, logger, secureHeaders } from "keala/middleware";

const app = new Keala({
  proxy: true, // 信任 x-forwarded-*（反代后）
});

app
  .use(createCookies({ keys: ["cookie-signing-secret"] })) // 插件：装出 c.cookies
  .use(secureHeaders())
  .use(cors({ origin: ["https://app.site"] }))
  .use(logger());

// 响应就是 return——没有 c.body = 这种写法
app.get("/", (c) => c.text("hello"));
app.get("/users/:id", (c) => c.json({ id: c.params("id") }));
app.post("/users", (c) => c.json({ created: true }, 201));
app.get("/old", (c) => c.redirect("/"));

// 中间件也是洋葱：await next() 前后做事，要作答就 return
app.use(async (c, next) => {
  const start = performance.now();
  await next(); // 下游全部跑完
  c.setHeader("X-Time", String(performance.now() - start)); // 直写已提交响应的头
});

app.listen(3000); // 或 app.listen({ port: 3000, hostname: "0.0.0.0" })
```

处理函数只有三种合法返回：`Response`（sugar 产物或手建）、`undefined`（交给下游/最终 404）、
`Promise` 之一。其它返回值会得到一个带指引的 500。

---

## 2. 核心心智模型

理解三件事就够了：

**① 一个扁平 context。** 没有koa 的 `req/res/ctx` 三对象——每个请求就一个普通对象 `c`，
请求读取、响应构造、路由信息全在它身上，一次分配，隐藏类固定。

**② 响应即 return。** `return c.text("hi")` / `return c.json(data)` / `return new Response(body)`
三选一。这是把响应"定下来"的唯一方式；`return c.redirect(url)` 同理。

**③ 头部是唯一的暂存面。** `c.setHeader(...)` 在 return 之前写的是"暂存记录"，
return 时自动并进响应；return 之后再写，就直接落在已提交 Response 的头上。
body 和 status 没有暂存——它们由 return 的那个 Response 携带。

```
请求 → [中间件 A 前] → [中间件 B 前] → handler（return 响应）
     ← [中间件 B 后] ← [中间件 A 后] ←── 响应沿链返回，最后写者胜
```

---

## 3. 路由

### 3.1 注册

```ts
app.get(path, ...handlers); // get/post/put/patch/delete/options/head/trace/connect
app.all(path, ...handlers); // 任意方法（没有 app.route——大应用用 Router + mount，见 3.5）
```

handler 可以多个（依次执行，任何一个 return 即作答），也可以挂中间件在路径前：

```ts
app.use(auth()); // 全局
app.use("/admin/*", auth()); // 子树作用域（注意：/admin 本身不算，/admin/* 才算）
```

### 3.2 路径参数

```ts
app.get("/users/:id", (c) => c.params("id"));        // "42"
app.get("/users/:id/posts/:postId", (c) => `${c.params("id")}/${c.params("postId")}`);
app.get("/files/:name?", ...)                        // 可选段：/files 与 /files/a 都匹配
app.get("/n/:num(\\d+)", ...)                        // 约束：只匹配数字
app.get("/static/*", (c) => c.params("wildcard"));   // 通配：捕获多段，值不含尾部斜杠
```

参数读取是函数式的：`c.params(name)`。路由匹配值不存在时返回 `undefined`
（可选段缺席、名字拼错都一样）——不会有原型链污染（`c.params("toString")`
是 `undefined`）。同一路由重复命名（`/dup/:x/:x`）取**靠后**的捕获。
需要整个参数表（日志/追踪场景）用根导出的 `paramsRecord(c.paramNames, c.paramValues, c.paramOffset)`。

### 3.3 优先级与自动 405

同一路径的多种形态按"静态 > 参数 > 通配"竞争，注册顺序只影响同级：

```ts
app.get("/shop/new", h1); // /shop/new → h1（静态赢）
app.get("/shop/:name", h2); // /shop/abc → h2
app.get("/shop/*", h3); // /shop/any/deep/path → h3
```

方法不匹配自动答 **405 + Allow 头**（空 body）；未知方法答 **501**；
`OPTIONS`（带 Access-Control-Request-Method 时由 cors 中间件接管，否则答 200+Allow）。
`new Keala({ unknownMethodAs404: true })` 可让未知方法改答 404。

### 3.4 命名路由与 URL 构建

```ts
app.get("user-detail", "/users/:id", (c) => c.text("detail"));
app.url("user-detail", { id: 7 }); // "/users/7"——缺必填参数抛错（启动心智，不是 500）
```

`c.routePath` / `c.routeName` 在 handler 里告诉你本次命中的是哪个模式
（`"/users/:id"`，含 mount 前缀）——给 metrics/span 当低基数标签用，别用原始路径。

### 3.5 组织大应用：Router + mount

```ts
import { Router } from "keala";

const api = new Router();
api.use(requireAuth()); // 子路由自己的中间件（在父全局之后、param 之前）
api.param("id", loadUser); // 参数中间件：命中带 :id 的路由时先跑
api.get("/users/:id", (c) => c.text(`user ${c.params("id")}`));

const app = new Keala();
app.mount("/api", api); // /api/users/42 → c.routePath === "/api/users/:id"
```

mount 是表合并不是运行时转发——零开销，404 自然落穿到父级。

### 3.6 常见路由问题

- **尾斜杠**：`/page/` 与 `/page` 视为同一资源（剥一个尾斜杠）。
- **大小写**：敏感。`/Page` 与 `/page` 是两个路由（与 hono 一致；serveStatic 依赖此行为）。
- **`%2F`**：解码后仍是单段——`/files/a%2Fb` 命中 `/files/:name` 时 `name === "a/b"`，
  不会重新进入路由（路径穿越的结构性防线）。
- **通配空捕获**：`/static/` 命中 `/static/*` 时 `wildcard === ""`；`/static` 是另一个资源。

---

## 4. 读取请求

### 4.1 查询串

```ts
c.query("q"); // 第一个值，缺失 null（"?" 后整段定向解析，不建全量 Map）
c.queries("tag"); // 重复键的数组
c.querystring; // 原始 "?a=1&b=2"（要自己解析时用）
```

`+` 解为空格、`%XX` 解码；没有全量枚举 API（故意的——定向读没有原型污染面）。

### 4.2 头、URL、网络

```ts
c.header("x-token"); // 大小写不敏感，缺失 ""
c.headers; // 原生 fetch Headers 对象（零包装直读）
c.method / c.url / c.path; // "GET" / "/a?b=1"（origin-form）/ "/a"
c.search; // "?b=1"
c.URL; // 惰性 WHATWG URL 视图
c.host / c.protocol / c.secure / c.origin / c.href;
c.ip; // 惰性解析；proxy: true 时走 x-forwarded-for 最右可信跳
c.raw; // 原生 Request（要 signal/arrayBuffer 等全集时）
c.signal; // 客户端断开 ∨ 请求超时 的协作取消
c.accepts("json", "html") / c.acceptsEncodings("gzip") / c.is("json");
```

伪造 Host 防护：`new Keala({ trustedHosts: ["app.site", "*.internal"] })`
在路由前校验，防 origin/href 被投毒。

### 4.3 请求体

```ts
import { bodyOf, createBodyParser } from "keala";

app.use(createBodyParser({ jsonLimit: 1 << 20, formLimit: 8 << 20 }));
app.post("/echo", async (c) => {
  const body = await bodyOf(c).json(); // 也可以 .text() / .formData() / .arrayBuffer() / .blob()
  return c.json(body);
});
```

不装插件时 `await c.raw.json()` 也能用（零配置起步），但没有预算保护。
**预算是传输级硬上限**：`jsonLimit`/`formLimit` 超限答 413，`formPartLimit`（默认 1000）
限制 multipart 部件数——内存放大攻击的围栏。同一 body 多次读取走 memo，不会重复计费。

---

## 5. 构造响应

### 5.1 三种 return，怎么选

```ts
return c.text(body, status?, headers?)       // 字符串；text/plain
return c.json(data, status?, headers?)       // 对象；application/json（自动序列化一次并 memo）
return c.html(markup, status?, headers?)     // 字符串；text/html
return new Response(...)                     // 字节/流/Blob/完全自控（fetch 标准，直接通）
return c.redirect(url, code?)                // 302/301/…，Location-only 空体
```

sugar 与手建 `Response` 完全等价地走同一条 finalize 通道；需要字节/流时直接
`new Response(bytes)` 即可，没有第二套 API。

### 5.2 头部：return 前暂存，return 后直写

```ts
app.get("/a", (c) => {
  c.setHeader("X-Staged", "1"); // 暂存——并进即将 return 的响应
  c.append("Set-Cookie", "sid=x; Path=/"); // 多值拼接
  c.remove("X-Unwanted");
  return c.text("ok", 200, { "X-Call": "2" }); // 三处头合并上 wire
});

app.use(async (c, next) => {
  await next();
  c.setHeader("X-Late", "after"); // return 之后：直写已提交 Response 的头
});
```

同名冲突规则：**暂存的头覆盖 return 的 Response 自带同名头**（你在链上显式写的
最后意图获胜）；`Set-Cookie` 永远是拼接不是覆盖。

### 5.3 状态与特殊形态

```ts
return c.text("created", 201);
return new Response(null, { status: 204 }); // 空体状态：body 与 content-* 头自动清洗
return c.text("moved", 301, { location: "/new" });
```

- 204/205/304 无论怎么构造，finalize 都会剥掉 body 和 content-type/length——放心写。
- **HEAD** 自动剥 body。sugar 构造的 HEAD 会带精确 Content-Length（从 would-be payload
  算好）；手建 `Response` 的 HEAD 不回填 CL（它只暴露你自己写的头）。
- `c.status` **只读**：post-next 的观察者（日志/metrics）读它看到已提交状态；
  设状态的方式就是 sugar 第二参或 `new Response(..., { status })`。

### 5.4 重定向

```ts
return c.redirect("/target"); // 302
return c.redirect("/target", 301); // 显式码必须是 3xx 整数，否则 TypeError
```

`c.redirect` 是纯构造器：不 return 就什么都不发生；return 了才替换当前答案
（后 return 者胜）。安全内建：`//evil.com`、`https:/evil.com` 这类"看似相对实为外域"
的目标会被编码成同源路径（开放重定向防线）；CRLF 会被百分号编码（响应拆分防线）。

### 5.5 流式响应

```ts
import { streamText, streamSSE } from "keala";

app.get("/log", (c) =>
  streamText(c, async (w) => {
    // 通用流（自动关 Bun idle 超时）
    for (const line of lines) await w.write(line + "\n");
  }),
);

app.get("/events", (c) =>
  streamSSE(c, async (sse) => {
    // SSE：心跳/规范行清洗内建
    sse.send({ event: "tick", data: JSON.stringify({ t: Date.now() }) });
    await delay(1000);
  }),
);
```

大文件在 Bun 下直接 `return new Response(Bun.file(path))`（sendfile/自动 CL/Range）；
`serveStatic` 中间件（`keala/middleware`）处理目录服务、dotfile 策略、ETag 协商。

---

## 6. 错误处理

### 6.1 抛出

```ts
c.throw(404, "no such user"); // 任何 4xx/5xx；1xx-3xx 抛 TypeError（那不是错误）
c.throw(401, "login required", { headers: { "www-authenticate": "Basic" } });
c.assert(user !== null, 404, "no such user");
throw new Error("boom"); // 未知错误一律按未暴露 500 处理
```

**暴露规则**：`c.throw` 造的是"暴露的" HttpError——4xx 的 message 会进响应体；
未知 `Error` 的 message **永不**进响应体（线上泄漏防线），只答 "Internal Server Error"。

### 6.2 兜底与接管

```ts
app.onError((error, c) => {
  observability.report(error); // 观察钩子（无 mapper 时 5xx 也会 console.error）
  return new Response("维护中", { status: 503 }); // return 即接管；undefined 走内置错误页
});
```

内置错误页契约：暂存的头照上（安全中间件覆盖错误页）、5xx 消息隐藏、
错误对象的 `headers`（如 Retry-After）会合并。mapper 自身抛错 → 静态 500 + console 大声报。

### 6.3 404

```ts
app.notFound((c) => c.text("自定义404", 404)); // 必须 return Response
```

链上没人作答 → 404 "Not Found"，暂存头照样合并。

---

## 7. Cookie 与会话

`c.cookies` 由插件安装（`app.use(createCookies({ keys }))`——与 bodyParser 同款协议，
注册期装、首触惰性，不用 cookie 的应用零成本）：

```ts
c.cookies.get("sid"); // 读（不解码签名）
c.cookies.get("sid", { signed: true }); // 验签读取——无 keys 时 fail-closed
c.cookies.set("sid", token, { signed: true, httpOnly: true, sameSite: "lax", maxAge: 3600 });
c.cookies.delete("sid");
```

内建能力（不需要额外包）：

- **签名 + 密钥轮换**：插件参数 `keys: ["new", "old"]`——新 key 签、旧 key 验，无缝换钥。
- **secure 派生**：不显式设 `secure` 时跟随请求的 TLS 状态（含可信代理头）。
- **防线**：`maxAge`/`expires` 超 400 天、`Partitioned` 无 `Secure` → 序列化期抛错
  （浏览器会静默丢的配置，直接让你在启动期看见）；值里的 CR/LF/NUL 拒绝。

---

## 8. 中间件

### 8.1 写自己的

```ts
import type { RouteHandler } from "keala";

const requestId: RouteHandler = async (c, next) => {
  const id = c.header("x-request-id") || crypto.randomUUID();
  c.setHeader("X-Request-Id", id);
  await next();
  // 这里可以对最终响应做事：读 c.status、补头、甚至 return 新 Response 替换
};
```

规则就三条：**要作答就 return；要放行就 `await next()`；都不做就是 404**
（开发模式会对"吞掉路由的中间件"给出警告——新手头号陷阱）。
中间件注册期一旦路由开始服务，晚注册会触发全链重编译——setup 时注册完。

### 8.2 内置全家（`keala/middleware`）

| 中间件                         | 干什么       | 要点                                                                                                          |
| ------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------- |
| `cors()`                       | 跨域         | Vary: Origin 正确处理（缓存投毒防线）；预检 204；`reject` 钩子自定义拒绝                                      |
| `secureHeaders()`              | 安全头全家   | CSP/HSTS/XFO/nosniff；错误页也覆盖                                                                            |
| `logger()`                     | 访问日志     | `方法 路径 → 状态 耗时 id`；读 `c.status` 而非拦截                                                            |
| `basicAuth()` / `bearerAuth()` | 认证         | RFC 7617/6750；`verify` 回调（**永远委托，别在闭包里比明文**）；配 `keala/helpers/password`                   |
| `rateLimit()`                  | 限流         | 固定窗口 per-key（默认 c.ip）；429+Retry-After；共享 store 为原子 `{ hit, get }` 接口（0.8 起不再接受裸 Map） |
| `metrics()`                    | Prometheus   | 计数/gauge/直方分桶；`metrics.page` 挂暴露端点                                                                |
| `etag()`                       | 协商缓存     | 弱 ETag + If-None-Match→304（GET/HEAD）；对 sugar 产物生效                                                    |
| `compress()`                   | gzip         | q 感知；no-transform/206/已压缩类型自动跳过；与 etag 任意顺序都正确                                           |
| `csrf()`                       | 跨站请求防护 | Origin/Referer 校验 + `csrfToken()`；Origin: null 拒绝                                                        |
| `validator()`                  | 入参校验     | Standard Schema（zod/valibot 通用接口）                                                                       |
| `serveStatic()`                | 静态文件     | GET/HEAD only；dotfile 默认忽略；ETag/Range                                                                   |
| `createBodyParser()`           | body 解析    | 见 §4.3——建议全局挂                                                                                           |
| `bodyLimit()`                  | 体积限制     | 与 sink 共存需 `noOpFor(bodyLimit(...))` 透明声明                                                             |

### 8.3 与热路由共存的透明声明

`app.sink()` 下沉的路由绕过洋葱——声明"我只是观察、不改变响应"的中间件才能与
下沉共存：

```ts
import { noOpFor } from "keala";
app.use(noOpFor(bodyLimit(1024 * 1024))); // 透明声明：允许与 sink 共存
```

---

## 9. WebSocket（Bun）

```ts
app.ws("/chat/:room", {
  open(ws, c) {
    ws.subscribe(c.params("room") ?? "");
  },
  message(ws, message, c) {
    ws.publish(c.params("room") ?? "", message);
  },
  close(ws, code) {
    /* ... */
  },
  error(ws, err, c) {
    /* producer 错误——有钩子，不静默 */
  },
});
```

升级握手复用路由表（`:room` 等参数可用）；排水（优雅停机）会等连接收尾，
之后完成的升级也会被补扫关闭——不挂进程。

---

## 10. 热路由下沉（Bun 提速 7-10%）

中间件对某条热路由是纯开销时，把它**下沉进 Bun 原生路由表**——绕过整个
fetch 洋葱：

```ts
// 函数下沉：handler 收 (request, params) 返回 Response，无 context/sugar
app.sink("/healthz", (request) => new Response("ok"));

// 静态下沉：整目录进原生表
app.sink("/assets/*", { dir: "./public" });
```

约束：下沉与 `app.onError` 互斥（错误契约基于 context）；JS 注册与 sink
路径重叠会在注册期抛错。透明中间件（§8.3）+ `sink` 的 JS 镜像层仍可组合。
Node 没有原生路由表——Node 部署不要启用 sink（镜像路径较慢，README 有警示）。

---

## 11. 生产化

### 11.1 监听

```ts
app.listen(3000);
app.listen({ port: 3000, hostname: "0.0.0.0", idleTimeout: 30, maxRequestBodySize: 1 << 20 });
app.listen({ signals: true }); // SIGTERM 优雅排水，再收一次信号 = 立即强停
```

未知配置键大声拒绝（拼错不静默）；二次 listen 拒绝。

### 11.2 优雅停机

```ts
const status = await app.close({ drain: true }); // 停接新连接 → 排空在途（或超时）→ 强停
// status: { timedOut, inFlight }
app.isDraining(); // readiness 探针翻转用（k8s preStop 里先 true 再 close）
app.inFlight; // 当前在途数
app.onShutdown(fn); // 排空后、close resolve 前的最后钩子（关 DB 连接等）
```

### 11.3 过载保护与超时

```ts
const app = new Keala({
  overload: {
    maxConcurrency: 10_000, // 在 context 创建之前拒绝——默认 503 fail-fast
    maxQueue: 1_000,
    queueTimeoutMs: 250,
    strategy: queueAdmission(), // 或 failFastAdmission()（默认）；可自定义
  },
  requestTimeout: 30_000, // 到点 c.signal abort + 504；迟到的僵尸结算静默收容
});
```

`rateLimit()` 管路由公平性，`overload` 管服务器容量——两层都要。

### 11.4 pooling（可选）

`new Keala({ pooling: true })` 复用 context 对象。**面向分配敏感的嵌入场景，
不是普适性能特性**（实测对常规服务是净退化——见 docs/HOTPATH-R4-7-POOLING-AB.md）。

---

## 12. 部署

**Bun（推荐）**：`bun app.ts` 直接跑，`app.listen` 内部就是 `Bun.serve`。

**Node**：`import { startNodeServer } from "keala/node"`——官方适配器，
流式 body 桥/背压/管线化/失败信封全处理，与 Bun 行为对齐（ws 除外，仍 Bun-only）。

环境差异速查：`c.url` 是 origin-form（`/a?b=1`）——要绝对 URL 用 `c.href`/`c.origin`。
运维清单：`trustedHosts`（公网）、`proxy: true`（仅反代后）、cookie 插件（要 `c.cookies` 时）、
`unknownMethodAs404`（按需）、overload 三件套（高流量）。

---

## 13. 从 hono / koa 迁移

从 hono 来的核心替换（完整表在 README「从 hono 迁移」）：

| hono                            | keala                                                         |
| ------------------------------- | ------------------------------------------------------------- |
| `c.req.param("id")`             | `c.params("id")`                                              |
| `c.req.query("q")`              | `c.query("q")`                                                |
| `c.header("x", "v")`（写）      | `c.setHeader("x", "v")`                                       |
| `c.body(text, status)`          | `return c.text(text, status)`                                 |
| `throw new HTTPException(404)`  | `c.throw(404)`                                                |
| `c.set("k", v)` / `c.get("k")`  | `c.state.k = v` / `c.state.k`                                 |
| `new Hono().route("/api", sub)` | `app.mount("/api", router)`                                   |
| `app.fetch(req)`                | `await app.handle(req)`（恒 Promise、永不 reject）            |
| hono/cookie 的 signed           | cookie 插件 `c.cookies.set(..., { signed: true })` + 密钥轮换 |

从 koa 来的直觉替换：`c.body = x` → `return c.text/json(x)`；
`c.status = n` → sugar 第二参；`c.set(h, v)` → `c.setHeader`；
`ctx.params.id` → `c.params("id")`。完整迁移叙事见
[KEALA-NATIVE-API-MIGRATION.md](./KEALA-NATIVE-API-MIGRATION.md)（历史记录，日常无需读）。

选型评估看逐面实现对比：[KEALA-VS-HONO.md](./KEALA-VS-HONO.md)
（14 个 API 面的双侧源码证据与探针实测，含各自更优之处）。

---

## 14. API 速查表

context 全部公开面（41 成员 + 2 直读槽位）：

```ts
// 请求（只读）
c.raw  c.signal  c.method  c.url  c.path  c.search  c.querystring
c.query(name)  c.queries(name)  c.URL  c.headers  c.header(name)
c.runtime  c.host  c.protocol  c.secure  c.ip  c.origin  c.href
c.idempotent  c.reqLength  c.is(...types)  c.accepts(...)  c.acceptsEncodings(...)

// 响应（return 形态 + 头部暂存/直写 + 状态只读）
c.status                     // 只读观察槽
c.setHeader(f, v)  c.append(f, v)  c.remove(f)  c.has(f)  c.resHeader(f)
c.text(body, status?, headers?)  c.json(...)  c.html(...)  c.redirect(url, code?)

// 核心
c.app  c.routerAllowed  c.state  c.params(name)  c.cookies（插件装出）
c.routePath  c.routeName          // 直读槽位（不在方法面里）
c.throw(status, message?, props?)  c.assert(test, status, message?, props?)
```

应用面：`app.get/post/...` `app.all` `app.use` `app.mount` `app.ws` `app.sink`
`app.url(name, params)` `app.redirect(from, to, code?)` `app.notFound(fn)`
`app.onError(fn)` `app.listen(...)` `app.close({drain})` `app.isDraining()`
`app.inFlight` `app.onShutdown(fn)` `app.decorate(key, value)` `app.reload()`。

---

## 15. 进阶原语（根入口）

大多数应用用不到这些——需要精细控制时它们都在 `keala` 根导出：

```ts
compose(handlers); // 手工洋葱装配（app 内部同款）
createBunServer / startBunServer; // 服务器引导（要自己管 Bun.serve 生命周期时）
startNodeServer; // keala/node 适配器
failFastAdmission / queueAdmission; // 过载策略素材
compilePattern(path); // 路由模式编译（自建匹配器）
readBodyLimited(request, budget); // 有界正文读取
signCookie / unsignCookie / parseCookies / serializeCookie;
pbkdf2PasswordHasher / bunPasswordHasher / hashPassword / verifyPassword;
escapeHtml / html / raw; // HTML 转义与模板字面量
streamText / streamSSE / disableIdleTimeout;
paramsRecord(names, values, offset); // 参数表适配器（日志/追踪）
statusMessage(code) / isValidErrorStatus(code);
```

类型扩展：`declare module "keala" { interface ContextExtensions { user: User } }`
让你的 `c.user` 全类型安全（`app.decorate` 运行时安装）。

---

## 附：常见问题排查

- **404 但路由明明注册了** → 中间件 `return` 了 undefined 且没调 `next()`（开发模式有警告）；
  或路径作用域写成 `/admin` 却请求 `/admin/x`（要 `/admin/*`）。
- **设置了头部却没出现** → 写在 `await next()` 之后没问题（直写已提交响应），
  但如果 handler 没 return 任何响应，链会以 404 收尾——检查 handler 的 return。
- **cookie 设置了浏览器却丢了** → 检查 `Partitioned` 是否缺 `Secure`、`maxAge` 是否超 400 天
  （这两种会直接抛错）。
- **CORS 预检 404** → 预检是 OPTIONS 请求，确认 cors() 挂在全局且在路由之前。
- **body 读第二次为空** → 用 `bodyOf(c)`（memo 化）；裸 `c.raw.json()` 只能读一次。
