# keala 原生 API 参考(0.7.x)

> 状态:0.7.0 已裁决定稿并实施(2026-09-04),R4.10 审计修订(同日),
> R411 人体工学四项(0.7.2,2026-09-05:bodyOf / c.get 退役 / params
> 非空 / routePath);**U1-U3c 去 Koa 形态迁移已实施(2026-09-06)**——
> `c.params("id")` 函数式取代下标/属性/解构形态;响应 setter 家族
> (body/type/length/etag/lastModified/attachment/res 及 status 写路径)
> 删除,响应唯一形态 = return;`c.redirect` 改纯构造器(必须 return)。
> 行为映射、替代配方与实施记录见
> [KEALA-NATIVE-API-MIGRATION.md](./KEALA-NATIVE-API-MIGRATION.md)。
> 本文是 keala 的**完整 API 参考**:每个 API 的签名、用法,以及与 Hono
> 的逐项差异与**为什么**。底层原语(根入口导出的 compose/cookie
> 签名/编译器等)在第七部分;设计史(裁决记录、性能实测、验收)保留在
> 第六部分——**第六部分是历史记录**,其中引用的旧形态 API 以本部分与
> 迁移文档为准。对照源:keala `src/`(0.7.3)与 Hono 4.13.5
> (`.parity/hono/src/`,逐条核对;请求面另对照 hono.dev 官方文档)。

---

## 第一部分 设计原则与定位

### 0. 五条原则

1. **一页纸可记住**:context 公共面就是 §2.3 的速查表——多一项少一项
   都会被测试锁死(`test/integration/commit-contract.test.ts` 的表面锁)。
2. **实测快的留下**:洋葱(205 vs 602ns)、定向 query 读(~2ns)、零构造
   params 直达(U2 实测全形状反超 3-7ns)——keala 自己的赢法。
3. **纯 koa 语义仿真删除**:为"与 koa 一致"而非正确性必需的分支一律
   不存在(0.7.0 已删 16 项,见第六部分 §6.2;U1-U3c 迁移再把状态式
   响应面整体删除)。
4. **已提交即冻结**:响应一经 return 即定局;头部写入仍直写已提交
   Response 的 `Headers`,要换响应就构造新 Response 返回。零重建机器。
5. **请求是客户端的事实**:请求侧全部只读;要改派生值,放 `c.state`。

### 1. 定位

```
keala = 洋葱模型 + 零依赖 + Bun 原生能力(+ Node 官方适配器)
```

- 返回式:handler **返回** Response——`return c.text/c.json/c.html(...)`,
  `return c.redirect(...)` 或自建 `new Response(...)`。链上最后返回的
  Response 获胜;全程无返回的链回答 404(暂存头仍合并上去)。
- 生命周期/过载/优雅停机/原生路由下沉是 keala 自有资产(Hono 无对应物)。
- 双运行时:Bun(主力,含 ws/原生路由表)与 Node(`keala/node`)。

```ts
import { Keala } from "keala";

const app = new Keala({ env: "production", keys: ["secret-1"] });

app.use(async (c, next) => {
  const start = performance.now();
  await next(); // 洋葱:下游(路由 handler)运行
  c.setHeader("X-Response-Time", `${Math.round(performance.now() - start)}ms`);
});

app.get("/hello/:name", (c) => c.text(`hello ${c.params("name")}`));

const server = app.listen(3000, "127.0.0.1");
// 优雅停机:SIGTERM → 排空在途 → 关连接池 → 退出
process.on("SIGTERM", () => {
  void app.close({ drain: 10_000 }).then(() => flushLogs());
});
```

---

## 第二部分 Context 完整参考

一个请求一个扁平 context 对象——请求侧、响应侧、糖共用一个原型,
核心请求面没有 `c.req` 门面(Hono 有;为什么见第五部分 D2)。唯一的
例外是 bodyParser 插件安装的 `c.req` **正文**门面——经类型化访问器
`bodyOf(c)` 使用(见第四部分)。

### 2.1 请求侧(全部只读)

```ts
c.method; // "GET" | "POST" | …(大写)
c.url; // "/path?query"(path+search,memo 化,dispatch 预填)
c.path; // "/path"
c.querystring; // "a=1&b=2"(无 "?" 前缀;原生 indexOf 扫描 + memo)
c.search; // "?a=1&b=2"(有 "?";空查询时为 "")

c.query("page"); // 首个值:"3";缺失 undefined;裸键 `?flag` 读作 ""
c.queries("tag"); // 重复键全部值:["a","b"];缺失 []
// 解码:`+`→空格、%XX;非法转义原样保留(安全契约)
// 键匹配 raw 与 encodeURIComponent 两种 wire 形态;非规范编码
// (%5F 表示 _)不参与匹配——需要时读 c.querystring 自解析

c.params("id"); // 命中路由的参数值:"12345";该参数未被捕获(可选段
// 缺席、名字不符)或未匹配路由时 undefined;重复名取最新捕获
// 读取零分配、零构造:names/values 是路由匹配产物数组,槽位直达;
// 数组无原型链——"toString"/"__proto__" 天然 miss。
// 要"整个 map"(日志/链路追踪枚举):paramsRecord(names, values, offset)
// 适配器(src/router/router.ts,sink 镜像边界同款)

c.routePath; // 命中的注册模式(含 mount 前缀):"/users/:id";未匹配 ""
c.routeName; // 命中命名路由时的名字;未命名/未匹配 undefined
// 观测地基:metrics 标签 / span 名用 c.routePath(有界基数),不用 c.path

c.header("x-token"); // 请求头,缺失 ""(注意:不是 undefined);"referrer"/"referer" 可互换
c.headers; // 原生 Headers 对象(需要遍历时用;大小写不敏感)

c.host; // "api.example.com"(proxy 时取 x-forwarded-host 首项)
c.protocol; // "https"(proxy 时取 x-forwarded-proto)
c.secure; // protocol === "https"
c.ip; // 客户端 IP:proxy 链首项(剥端口),否则 socket 远端
c.origin; // "https://api.example.com"
c.href; // 完整 URL(绝对形态请求目标原样返回)

c.idempotent; // GET/HEAD/PUT/DELETE/OPTIONS/TRACE → true
c.reqLength; // 请求 content-length 数字;缺失 undefined

c.raw; // 原生 Request(惰性,Node 侧延迟物化)
c.signal; // AbortSignal:客户端断开 ∨ 请求期限(R4.6,惰性)
c.URL; // WHATWG URL|null(绝对 URL 解析失败为 null;memo)
c.runtime; // 运行时通道(server 句柄/远端地址;嵌入时 undefined)

// 内容协商(compress 内部依赖 acceptsEncodings)
c.is("json"); // 请求 content-type 判型:"json"|null|false
c.accepts("html", "json"); // 可接受类型:"html" | false
c.acceptsEncodings("gzip"); // "gzip" | false
```

### 2.2 响应侧与提交契约

**响应唯一形态:返回**。handler/中间件以 `return c.text/c.json/c.html(...)`,
`return c.redirect(...)` 或 `return new Response(...)` 作答;链上最后返回的
Response 获胜(last-committer-wins),全程无返回的链回答默认 404(暂存头
仍会合并上去)。状态式写入器(body/type/length/etag/lastModified/
attachment/res 一族)已随 U1-U3c 迁移删除。

**头部(唯一暂存面:return 前暂存,return 后直写)**:

```ts
c.setHeader("X-Trace", "abc"); // 单值;对象形式 c.setHeader({ A: "1", B: 2 })
// UX-11:undefined/null 值静默忽略(不写入);清除已写的头用 c.remove,
// 显式空串 c.setHeader(k, "") 会覆盖为空值
c.append("Vary", "Origin"); // 多值追加(content-type/length 单值头不可 append)
c.remove("X-Unwanted"); // 删除
c.has("X-Trace"); // boolean(提交后读穿到已提交 Response)
c.resHeader("X-Trace"); // string;缺失 ""
// return 之前:写入暂存记录(零分配直到首写),糖构造 Response 时消费进最终响应
// return 之后:写入直落已提交 Response 的 Headers(与 Hono post-next 同语义)
```

**状态码**:`c.status` 是只读观察槽(已提交 Response 的状态;或 405/501/
OPTIONS 合成答案、404 默认)。设置状态只有两个入口:

```ts
return c.json({ ok: true }, 201); // 糖第二参
return c.text("created", 201, { "X-App": "keala" }); // 第三参头对象
return new Response(body, { status: 202 }); // 自建
```

**已删 setter 的等价配方**(有损映射——旧 setter 悄悄做的简写展开/引号/
编码,现在由调用者显式给出完整值):

```ts
// MIME 简写不再展开("json" 不再变成 application/json; charset=utf-8):
c.setHeader("Content-Type", "application/json; charset=utf-8");
c.setHeader("Content-Length", "42"); // 类型面要求字符串（HeaderValue）
// ETag 的引号不再自动包裹(实体串必须带引号):
c.setHeader("ETag", '"v1"'); // 弱 tag:W/"v1"
// Date → HTTP 日期串不再自动转换:
c.setHeader("Last-Modified", new Date().toUTCString());
// attachment 的类型推断/RFC 5987 编码不再自动,手写 Content-Disposition:
c.setHeader("Content-Disposition", 'attachment; filename="report.pdf"');
c.setHeader(
  "Content-Disposition",
  "attachment; filename=\"report.bin\"; filename*=UTF-8''%E6%8A%A5%E8%A1%A8.bin",
);
// 常见场景直接用糖,content-type 由糖正确带出:
return c.json(data); // application/json（handle 路径 Bun 带 charset）
return c.html(page); // text/html; charset=utf-8
```

**redirect(纯构造器,必须 return)**:

```ts
return c.redirect("/login"); // 302 + Location,空体
return c.redirect("/gone", 301); // 显式码接受任意 3xx 整数并按传入值保留;非 3xx 整数 TypeError
// 开放重定向防护:`//evil.com`、`https:/evil.com` 会被中和为同源路径
// c.redirect 不 mutate context——不 return 就不生效(天然无
// throw-on-commit);构造前 staged 的同名 Location 按同名头规则反杀目标
```

**提交后(return 之后)**:

```ts
// 头部写入直写已提交 Response 的 Headers(与 Hono 同语义,不抛):
c.setHeader("X-Late", "1");
c.append("Vary", "Origin");
c.setHeader("Content-Type", "text/csv"); // 完整值——MIME 简写 setter 已删
// 读取:c.status(只读)/ c.has / c.resHeader 读提交值

// 要替换已提交响应:构造新 Response 返回覆盖(外层是最后提交者);
// 已提交的 Response 本体经内部提交槽 _res 观察(见 §7.1):
app.use(async (c, next) => {
  await next();
  if (c._res !== undefined && c._res.status === 404) {
    return c.text("nothing here", 404); // 覆盖内层的 404
  }
});
```

**规则细则**:

- 提交后 SET/REMOVE 幂等镜像进暂存记录 → 外层中间件事后抛错时错误页
  保留防护头;更新的提交(外层 return 新 Response)重放这些 SET。
- **content-describing 头**(content-type/length/transfer-encoding/
  content-encoding)不参与镜像重放——它们描述当时的 body,不应覆盖
  新提交自己的值(但当前 Response 上的就地写生效)。
- 提交后 APPEND 并入暂存记录的既有条目(时序上最后的写生效);
  `c.setHeader("Set-Cookie", …)` 提交后是**替换**——追加 cookie 用
  `c.cookies.set`(任何时刻可用,连接不替换)。
- 不可变守卫(handler 返回了 `fetch()` 来的 Response)上写头 → TypeError。
- **不要返回模块级共享的 Response 常量**:提交后头部写入是就地操作,
  会跨请求累积污染;重发已消费的 Response 是 500(双运行时一致)。

**糖(返回式,Hono 同签名)**:

```ts
return c.text("plain"); // text/plain; charset=utf-8
return c.text("created", 201);
return c.json({ ok: true }); // application/json;undefined → "null"
return c.json({ err: 1 }, 422, { "X-App": "keala" }); // 第三参头对象
return c.html("<h1>hi</h1>");
// 糖会消费此前暂存的头(c.setHeader/c.cookies 写入的都带进 Response)
// 204/205/304:无体、无 content 头;HEAD:构造期附带精确 content-length
```

### 2.3 速查表(公共面 = 全部 context API)

```ts
// 请求(只读)
c.method  c.url  c.path  c.querystring  c.search
c.query(name)  c.queries(name)  c.params(name)  c.ip  c.host  c.protocol  c.secure
c.origin  c.href  c.idempotent  c.reqLength  c.URL
c.headers  c.header(name)  c.raw  c.signal  c.runtime
c.routePath  c.routeName
c.is()  c.accepts()  c.acceptsEncodings()

// 响应(头部暂存/直写 + 返回式;status 只读)
c.setHeader(k, v)  c.append(k, v)  c.remove(k)  c.has(k)  c.resHeader(k)
c.status  c.redirect(url, code?)
c.text(s, status?, headers?)  c.json(x, status?, headers?)  c.html(s, …)
return new Response(...)

// 核心
c.app  c.routerAllowed  c.state  c.cookies
c.throw(status, msg?, props?)  c.assert(cond, status, msg?, props?)
```

### 2.4 错误流

```ts
c.throw(404, "user not found"); // 抛出 HttpError,进错误漏斗
c.throw(429, "too many", {
  // props 三件套
  expose: true, // 4xx 默认暴露消息,5xx 默认隐藏(expose 可覆盖)
  code: "RATE_LIMITED", // 透传给 mapper 的机器码
  headers: { "Retry-After": "1" }, // 随错误发出的响应头
});
c.assert(user !== null, 401, "login required"); // 条件版 throw

// 错误漏斗(单槽;第二次注册抛 TypeError)
app.onError((error, c) => {
  return c.json({ error: error.code ?? "internal" }, error.status);
});
// mapper 返回 undefined → 走内置信封(prod 隐藏 5xx 消息)
// app.notFound(handler):未匹配路由;返回 Response 定制 404
// (返回 undefined → 内置 404)——但不可 throw,throw 落入通用 500
```

**`c.throw` 只接受 4xx/5xx**:传入 1xx-3xx 抛 `TypeError` 而不是
`HttpError`(信息与重定向不是错误;`c.assert` 同规)。重定向用
`return c.redirect(url, code?)` 或 `app.redirect(source, dest, code)`——
code 接受任意 3xx 整数并按注册意图原样保留（304/306/309+ 不会被静默改写；
`isRedirectStatus` 的 {300-303, 305, 307, 308} 是已指派语义集，供隐式
回退判定用）。

### 2.5 Cookies(内置签名 + 密钥轮换)

```ts
new Keala({ keys: ["new-secret", "old-secret"] }); // 首个签名,全部可验

c.cookies.set("sid", session, {
  signed: true, // HMAC 签名(默认跟随 app.keys 配置则签)
  maxAge: 3600, // 秒(上限 400 天,超出抛错——浏览器会静默丢弃)
  expires: new Date(),
  path: "/", // 默认 "/"(R4.10;显式传 "" 可省略 Path)
  domain: "example.com",
  secure: true, // 未指定时跟随请求 TLS 状态(代理后自动)
  httpOnly: true,
  sameSite: "strict", // strict | lax | none | true(=strict)| false(省略)
  priority: "high",
  partitioned: true, // 需 Secure;违反 CHIPS 约束会抛
  overwrite: true, // 覆盖同名旧值(默认首次写入生效)
});
c.cookies.get("sid"); // 验签失败返回 undefined
c.cookies.get("sid", { signed: false }); // 读原始值
// 值经对称编解码:空格/逗号/引号/非 ASCII 都安全 percent-encode;
// 仅 CR/LF/NUL/C0 控制符抛 TypeError
```

### 2.6 状态与扩展

```ts
c.state.userId = 42; // 中间件传值(null 原型对象,首次触碰分配)
app.decorate("db", pool); // 每个 context 固定成员:c.db.query(...)
app.decorateLazy("req", () => buildFacade(c)); // 惰性 getter(首读物化)
```

---

## 第三部分 应用面

### 3.1 构造

```ts
new Keala({
  env: "production", // 默认 process.env.NODE_ENV 或 "development"
  keys: ["k1", "k2"], // cookie 签名密钥(轮换:首个签,全部验)
  proxy: true, // 信任 x-forwarded-{for,proto,host}
  proxyIpHeader: "x-real-ip", // 默认 "x-forwarded-for"
  maxIpsCount: 3, // proxy 链截断
  pooling: false, // context 池(分配敏感嵌入场景;性能为净退化)
  requestTimeout: 30_000, // ms;超时 c.signal abort + 504(0 关闭)
  trustedHosts: ["example.com", "*.example.com"], // Host 白名单,伪造 403
  unknownMethodAs404: true, // 未知方法答 404(默认 501)
  overload: {
    // 准入控制(pre-context)
    maxConcurrency: 1000, // 在途上限(硬上限,R4.10)
    maxQueue: 100, // FIFO 队列容量(默认 0 = fail-fast)
    queueTimeoutMs: 10_000,
    retryAfterSeconds: 1,
    handler: (req, reason) => custom503, // 自定义拒绝响应
    strategy: customStrategy, // 可插拔策略
  },
  onStreamError: (err, c) => log(err), // 流体响应错误观察
});
```

### 3.2 路由与中间件

```ts
app.get("/users/:id", handler); // 路径参数;?x? 可选段;* 通配
app.get("/files/*", handler); // 前缀通配
app.get("named-route", "/report", handler); // 命名路由(名在前;运行时 c.routeName 可读)
app.post / put / patch / delete / head / options / all("/x", ...handlers);
app.on("TRACE", "/x", handler);
app.use(authMiddleware); // 全局洋葱层
app.use("/admin/*", adminOnly); // 路径作用域层
app.param("id", loadUser); // 参数中间件(该参数出现即运行)
app.mount("/blog", blogRouter); // 子路由挂载(Router 实例或子 app)
app.redirect("/old", "/new"); // 301 路由级重定向
app.url("named-route", { id: 7 }); // 反向构建 URL
app.route("named-route"); // 查询路由路径
// 一个路由可写多个 handler(洋葱尾端是最后一个):
app.get("/x", authorize, validate, handler);

// 中间件就是 (c, next) 函数——无工厂、无泛型仪式:
const authorize = async (c, next) => {
  const token = c.header("authorization");
  if (token === "") return c.text("login required", 401); // 短路
  c.state.userId = decode(token);
  await next(); // 下游运行;之后的代码看到提交后的响应
  c.setHeader("X-Ran", "authorize"); // 提交后装饰头部
};
// 规则:不处理就 next();短路要么 return Response 要么 c.throw;
// 每个 next() 只能调一次(第二次抛错)
```

### 3.3 WebSocket(Bun)

```ts
app.ws("/chat/:room", {
  origin: ["https://app.site"], // 升级前校验 Origin;数组或 (c) => boolean,
  // 不匹配 → 403(浏览器 WS 握手带 Origin 但过不了 csrf()——那是 HTTP 中间件)
  open(ws, c) {
    broadcast(c.params("room"), "joined");
  },
  message(ws, message, c) {
    ws.send(`echo:${String(message)}`);
  },
  close(ws, code, reason, c) {
    /* c 活到连接结束(pooling 与 ws 互斥) */
  },
  drain(ws, c) {
    /* 背压缓解 */
  },
  error(ws, error, c) {
    log(error);
  },
});
// listen({ websocket: { maxPayloadLength, backpressureLimit, … } }) 调优
// ws 仅 Bun;Node 侧升级请求答 501
```

**Origin 防护(SEC-2)**:浏览器的 WS 握手不能自定义头、不带 CSRF
token,`csrf()`(Origin/Referer 校验中间件)罩不住它——跨站页面可以
让浏览器向你的 ws 端点发起握手。升级请求的 Origin 白名单因此是 ws
路由的一等选项:`origin: string[]` 精确匹配(大小写不敏感;**缺失
Origin 的握手直接拒绝**——浏览器握手必带 Origin,fail closed),或
`(c) => boolean` 自担全部裁决;校验发生在升级之前,不匹配回答 403,
不配置则不做 Origin 约束(旧行为)。

### 3.4 原生下沉(Bun 热路由)

```ts
app.sink("/healthz", new Response("ok")); // 静态 Response(克隆注册)
app.sink("/assets/*", { dir: "./public" }); // 目录(镜像 + 原生表)
app.sink(
  "/hot/:id",
  (request, params) =>
    // 函数:零中间件/Context,
    new Response(`user ${params["id"]}`),
); // 绕过整个 fetch 路径
// 守卫:与下沉路径冲突的 JS 路由/未声明透明的中间件在注册期抛错
// listen({ nativeRoutes: false }) 强制 JS-only
```

`{ dir }` 下沉的目录树由 Bun 原生路由表直接服务,`serveStatic` 的
运行期忽略式防御(dotfiles、symlink 拒绝)盖不住原生表——因此每次
构建原生路由表(`listen()`、listen 之后的 `sink()`、每次
`reloadNativeRoutes()`)都会重新扫描目录:发现 dotfile(`.well-known`
豁免)或 symlink 即抛 `TypeError` 并列出违规路径(SEC-1)。要发布
dotfile 的根目录请继续用 `serveStatic({ dotfiles: "allow" })` 的普通
路由。

### 3.5 监听与停机

```ts
const server = app.listen(3000);
app.listen(3000, "127.0.0.1");
app.listen(3000, () => console.log("up"));
app.listen({
  port: 3000,
  hostname: "127.0.0.1",
  reusePort: true, // Bun:SO_REUSEPORT 多进程
  idleTimeout: 30, // 秒(Bun;Node 映射 keepAliveTimeout 毫秒)
  maxRequestBodySize: 1 << 20, // 传输级请求体硬上限(双运行时)
  nativeRoutes: true, // 启用原生路由表(默认有 sink 即启用)
  websocket: { maxPayloadLength: 1 << 20 },
  onServeError: (error) => custom500, // fetch 层失败信封
  signals: true, // SIGTERM/SIGINT 桥:首信号 drain,再信号强停
});
server.port;
server.stop();
server.stop(true); // true = 丢弃活动连接
server.reload({ routes }); // 热更新原生路由表

await app.close({ drain: 10_000, shutdownTimeout: 10_000 });
// → { timedOut: false, inFlight: 0 }
// drain:默认 30s(0 立即强停;Infinity 无限等待)
// shutdownTimeout:onShutdown 钩子的总预算,默认 10s(0 禁用);
//   超时的钩子记录日志后继续——停机不因一个卡死的清理钩子挂死
app.isDraining(); // readiness 探针(排水开始即 true)
app.inFlight; // 在途计数(过载容量视图)

app.onShutdown(async () => {
  // 排空后、close() resolve 前,顺序运行
  await flushMetrics(); // 一次;失败包容并记录;thenable 被等待
  await db.close();
});
```

Node 侧:`import { listen } from "keala/node"` 同参(idleTimeout 映射
keepAliveTimeout;`http` 选项透传 node:http ServerOptions)。Bun-only 键
(reusePort/nativeRoutes/websocket)给出迁移指引报错。

---

## 第四部分 内置中间件与助手(`keala/middleware`)

```ts
secureHeaders({ hsts: 31536000 })   // nosniff/XFO/Referrer-Policy 默认;HSTS 可选
requestId()                         // c.state.requestId + X-Request-ID 回显
timing()                            // Server-Timing 总时延;timingMark(name) 记段(见下方代码块)
logger({ write: line => … })        // 每请求一行,含失败
cors({ origin: ["https://app.com"], allowCredentials: true })  // 白名单必填
csrf()                              // Origin/Referer 校验(状态变更请求)
csrfToken({ secret })               // HMAC 双提交 token;csrfTokenGuard({ service }) 校验
etag()                              // 弱 ETag + If-None-Match → 304(GET/HEAD)
compress({ gzip: customImpl })      // q 感知;跳过 206/no-transform/已压缩类型
cache({ ttl, max, maxBytes, maxEntryBytes, includeQuery })  // 路由级缓存
rateLimit({ limit: 100, windowMs: 60_000, key: c => c.ip })  // 429 + Retry-After
metrics()                           // Prometheus /metrics(计数+在途+时延桶)
basicAuth({ users, realm })         // c.header("authorization")
bearerAuth({ verify: async t => user|false })
bodyLimit(bytes)                    // 413 硬上限
timeout(ms)                         // 路由级超时
serveStatic({ root, index, prefix, followSymlinks, dotfiles })  // HEAD/Range/条件请求
validator(schema)                   // Standard Schema(zod4/valibot/typebox)→ validOf<T>(c) 取值
```

```ts
// 正文读取(createBodyParser 插件 + bodyOf 类型化访问器)
app.use(createBodyParser({ jsonLimit: 1 << 20, formLimit: 10 << 20 }));
app.post("/echo", async (c) => {
  const body = await bodyOf(c).json(); // memo 化,重复读安全;零 cast(0.7.2)
  return c.json(body);
});
// 全部 reader 直达:bodyOf(c).text() / .arrayBuffer() / .blob() / .formData()
// 未装插件时 bodyOf 抛带修复指引的 TypeError(不再是无指引的 undefined.req)

// validator 的解析结果:validOf<T>(c) 类型化取值(c.valid 运行时存在,
// 但框架层类型是 unknown——不要裸用):
// import { validator, validOf } from "keala/middleware";
app.post("/users", validator(userSchema), (c) => {
  const user = validOf<{ name: string }>(c);
  return c.json({ created: user.name }, 201);
});

// timing() 的记段钩子挂在 c.state 上——c.state 是 Record<string, unknown>,
// 记段时窄化一次类型即可:
app.use(timing());
app.get("/report", (c) => {
  const mark = c.state["timingMark"] as ((name: string) => void) | undefined;
  mark?.("db"); // Server-Timing: db;dur=…(total 由中间件自己补)
  return c.text("done");
});

// 流式助手(src/helpers)
return stream(c, async (w) => {
  w.write(bytes);
  w.close();
}); // 二进制
return streamText(c, async (w) => {
  w.write("chunk");
}); // 文本(自动关 idleTimeout)
return streamSSE(
  c,
  async (sse) => {
    // SSE
    sse.send({ event: "tick", data: { t: Date.now() } });
  },
  { heartbeat: 5000 },
); // 默认 5s 心跳
// w.desiredSize < 0 = 消费者落后,无限生产者应暂停(见 streams.ts 注释)
```

---

## 第五部分 对比 Hono:逐项差异与为什么

Hono 是 keala 的对标与部分场景的超越对象(见第六部分性能实测)。
以下差异**全部是有意的**,每条附理由。Hono 侧逐条核对自 4.13.5 源码。

### D1. 参数:`c.params("id")` vs `c.req.param("id")`

```ts
// Hono                              // keala
const id = c.req.param("id");
const id = c.params("id");
```

**为什么**:路由匹配产物就是数组(names/values/offset),`c.params(name)`
一次 `lastIndexOf` + 下标读取直达——零对象构造、零物化。Hono 的
`c.req.param()` 每次调用走 HonoRequest 门面再进 `#cachedParamData`。
千路由规模实测 keala 匹配快 6-81x(见 §9.2);读取侧差距是同一来源。
U1-U3c 前的形态是预填 null-proto Record 的属性读取(构造 ~5ns/请求);
函数化后零拷贝直达,同窗口 A/B 全形状实测再反超 3-7ns。

### D2. 查询:`c.query("q")` vs `c.req.query("q")`

```ts
// Hono                              // keala
const q = c.req.query("q");
const q = c.query("q");
const all = c.req.queries("tag");
const all = c.queries("tag");
```

**为什么**:两层。(1) **形态**——koa 式一次性物化全量 Map 实测 111ns/
请求(解析 + 5 次分配),而边界匹配定向扫描 ~2ns;`.name` 属性形态无解
(Proxy 陷阱比建 Map 还慢),2026-09-04 裁决定为方法定向读,0.6.2 实施。
(2) **挂载点**——Hono 把请求面收在 `c.req` 门面后;keala 无门面,扁平
context 就是请求侧(一个对象、一个隐藏类、零委托跳数——koa 的审计结论
是两跳委托在热路径有可测成本)。代价:请求/响应名字空间必须精心分割
(见 D3)。

### D3. 头部:`c.setHeader` / `c.header(name)` vs `c.header(name, value)`

```ts
// Hono                              // keala
c.header("X-A", "1"); // 写响应    c.setHeader("X-A", "1");  // 写响应
c.req.header("x-a"); // 读请求    c.header("x-a");          // 读请求,缺失 ""
c.header("Vary", "X", { append: true });
c.append("Vary", "X");
```

**为什么**:Hono 的 `c.header()` **写响应**而 `c.req.header()` 读请求——
同名单双向,从 Hono 迁移极易写反(读侧误写)。keala 拆名:写必带
`setHeader`(动作语义),读侧 `c.header(name)` 空参即读。0.7.0 裁决,
迁移成本一次性付清,陷阱永久消失;0.7.2 退役 koa 遗产别名 `c.get`
(读侧从此单入口,与写侧严格对偶)。读侧缺失返回 `""`(falsy 但可判),
Hono 返回 `undefined`——统一 falsy 判断,代价是区分"缺失"与"空值"
需 `c.headers.get()`(返回 null)。

**佐证**(Hono 官方文档):Hono 的 `c.req.header()` 无参形态返回键全
小写的 record,文档自己挂着 ❌/✅ 警告——`headerRecord['X-Foo']` 静默
undefined。keala 的遍历面是原生 `c.headers`(大小写不敏感),该陷阱
结构性不存在。

### D4. 响应:同构的返回式(差异只在覆盖面)

```ts
// Hono                              // keala
return c.text("hi"); // 两侧同签名(含 status/headers 参)
return c.json({ a: 1 }, 201); // 两侧同签名(第二参状态码,第三参头对象)
return c.body("hi"); // 仅 Hono 有泛型糖
return new Response("hi"); // keala:非糖 body(流/Blob/Uint8Array)直接构造
```

**为什么**:U1-U3c 迁移把 koa 形态的状态式写入(body/type/length/
etag/lastModified/attachment/res 一族)整体删除,keala 与 Hono 同为
"构造并返回"。剩余差异:keala 没有 `c.body()` 泛型糖——文本/JSON/HTML
有糖,其余 body 形态(流、Blob、Uint8Array)直接 `new Response(...)`;
糖构造时会**消费暂存头**(`c.setHeader`/`c.cookies` 先写的内容随糖进
最终 Response,与 Hono 的 `c.header()` 预写行为一致)。历史上曾有的
双态(状态式 138ns vs 糖 197ns)随 staged-commit 状态机一起退役——
commit 机器净删 ~236 语句,换来单一可推理的响应形态。

### D5. 提交契约:冻结 + 就地装饰 vs 静默替换

```ts
// Hono:handler 返回后仍可对响应对象  // keala:提交后只有两种合法操作
// 整体替换(context 的 res 属性       c.setHeader("X-Late", "1"); // ✓ 直写已提交 Headers
// 可反复赋值,身份随链流动)          c.append("Vary", "X");      // ✓
//                                    return new Response(…);     // ✓ 返回覆盖(最后提交者赢)
// 响应体/状态没有写路径——要换就 return 新 Response(keala 侧唯一替换形态)
```

**为什么**:Hono 允许 handler 返回后对响应对象整体替换(context 的
res 属性可赋值),响应在链上流动时身份可变,推理成本高;keala 把"替换"
收敛为唯一显式形态——外层**返回**新 Response,头部则就地写(与 Hono 的
post-`next()` `c.header()` 同语义)。0.7.0 删除整类 rule-4 重建机器
(旗标合并矩阵、`rebuildCommitted`),U1-U3c 再删掉整个状态式写入面——
响应一经 return 即定局。错误漏斗会收割已提交 Response 的头重建错误页,
防护头不丢(R4.10)。这是可预测性换灵活性的裁决。

### D6. 错误:`c.throw` vs `HTTPException`

```ts
// Hono                              // keala
throw new HTTPException(404,         c.throw(404, "user not found", {
  { message: "user not found" });      expose: true, code: "NO_USER",
app.onError((err, c) => …);            headers: { "Retry-After": "1" },
                                      });
                                     app.onError((err, c) => …);  // 同
                                     c.assert(cond, 401, "…");    // 条件版
```

**为什么**:功能等价(单槽 onError、5xx 默认隐藏)。`c.throw` 是
状态优先的一站式形态(props 收拢 expose/code/headers),少一个
导出类;`c.assert` 是 Hono 没有的便捷面。

### D7. 中间件状态:`c.state` vs `c.set()/c.var`

```ts
// Hono                              // keala
c.set("message", "hi");              c.state.message = "hi";
const m = c.get("message");          const m = c.state.message;
// 类型化:泛型工厂 + 字符串键        // 类型化:声明合并 + decorate
const mw = createMiddleware<         import { Keala, createMiddleware,
  { Variables: { msg: string } }>(…);   type ContextExtensions } from "keala";
const m = c.var.msg;                 declare module "keala" {
                                       interface ContextExtensions { db: Pool }
                                     }
                                     const app = new Keala();
                                     app.decorate("db", pool);
                                     c.db.query(…);        // c.db 强类型
                                     // 第三方中间件收窄 context:
                                     const mw = createMiddleware<{ db: Pool }>();
```

**为什么**:Hono 需要字符串键 + 泛型工厂给中间件变量上类型,读侧分
`c.get`(写读)与 `c.var`(只读)两套。keala:`c.state` 是 null 原型
普通对象(首次触碰才分配,零状态请求零成本),类型自然推导;应用级
**强类型**服务走 `decorate` + `ContextExtensions` 声明合并——`c.db`
的类型真的就是 `Pool`,不是 `unknown`;发布第三方中间件时用
`createMiddleware<{ db: Pool }>()` 把依赖的扩展键收窄进 handler 签名
(对应 Hono 的 `createMiddleware<{ Variables: … }>`,键的来源是全局
声明合并,而非每个调用点重复的泛型参数)。Hono 的 `c.env`(
平台绑定,如 Cloudflare KV)在 keala 无对应——keala 不面向 edge 平台
绑定模型,平台资源经 `decorate` 或 `c.state` 注入。

### D8. 路由组织:`mount(Router)` vs `route()/basePath()`

```ts
// Hono                              // keala
const api = new Hono();
const api = new Router();
api.get("/u", h);
api.get("/u", h);
app.route("/api", api);
app.mount("/api", api);
const sub = new Hono(); // mount 也可挂子 app(中间件保留)
sub.basePath("/v2"); // Router 独立 use()/param() 保留
```

**为什么**:形状同、名字不同(mount 沿 koa 生态命名)。keala 额外有
命名路由 + `app.url("name", params)` 反向构建(Hono 的 `app.route()`
只是挂载,没有名字)与 `app.param()` 参数中间件(@koa/router 语义)。

### D9. Cookies:内置 vs `hono/cookie` 助手

```ts
// Hono(helper 模块)                // keala(核心)
import { getCookie, setCookie }      c.cookies.set("sid", v, { signed: true });
  from "hono/cookie";                c.cookies.get("sid");
setCookie(c, "sid", v, { path: "/" });
getCookie(c, "sid");
```

**为什么**:keala 的 cookie 是核心能力(签名 + 密钥**轮换**:首密钥
签名、全密钥可验——滚动换钥不踢会话)、`secure` 跟随请求 TLS(代理
后自动)、400 天寿命上限与 CHIPS 校验(浏览器会静默丢弃的配置直接抛
错)。R4.10 起 `Path` 默认 `/`(与 cookies 包/koa 一致;Hono 需显式
传,不传走 RFC 默认路径——在 `/api/auth` 设置的 cookie 不会发往 `/`)。

### D10. WebSocket:`app.ws` 内置 vs 适配器包

```ts
// Hono(需 @hono/hono-websocket 等) // keala(Bun 内置)
import { createNodeWebSocket } …     app.ws("/chat", { message(ws, m) { … } });
app.get("/ws", upgradeWebSocket(c => …));
```

**为什么**:keala 在 Bun 上直连原生 upgrade;handler 的每个事件都带
**同一个 context**(连接生命周期内可读 `c.params(name)/c.state`)。代价:
ws 仅 Bun(Node 升级请求 501,文档明示)。

### D11. 生命周期/高可用:keala 独有面

Hono 没有对应物(`app.close/isDraining/inFlight/onShutdown`、
overload 准入、requestTimeout、c.signal、信号桥)——Hono 的定位是把
生命周期交给运行平台(Workers/容器)。keala 面向自管进程(Bun/Node
直跑),把排水、准入、期限做进核心并全部测试锁定。`app.sink` 原生
下沉同理(利用 Bun 路由表,指定热路由 +7~10% RPS)。

### D12. 零依赖与双运行时

Hono 按平台发适配器包(hono/node-server 等);keala 核心零依赖、
Node 适配器(`keala/node`)与 Bun 路径都在主包,同一 `listen()` 选项
(差异键给迁移指引)。中间件(压缩/验证/限流/指标)全部内置,无
hono/zod-validator 式外挂——`validator()` 直收 Standard Schema。

### D13. `url` 语义:Hono 绝对 vs keala 相对

```ts
// Hono                              // keala
c.req.url; // "http://host/about/me" c.url;   // "/about/me?x=1"(path+search)
c.href; // 绝对形态(http://host/…)
c.origin; // "http://host"
```

**为什么**:keala 用相对形态(origin-form;代理/嵌入场景里原始请求
目标常是路径形态,绝对化需要 host 解析——`c.href` 惰性做这件事)。
**迁移陷阱**:
Hono 老兵写 `c.url` 期待绝对 URL,keala 给相对串——要绝对用 `c.href`。

### D14. Hono 有而 keala 不做 API 的三件(配方替代)

对照 hono.dev/docs/api/request 全景(2026-09-05 评审),三项能力 keala
**用配方而非 API** 承接(裁决记录见 `docs/R411-API-ERGONOMICS-PLAN.md`):

| Hono API                | keala 配方                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| `parseBody({all, dot})` | `for (const [k, v] of formData.entries())` 十行循环;`dot` 嵌套是原型污染教科书,坚决不学         |
| `cloneRawRequest()`     | memo 化读取下重复读安全;转发用 `new Request(url, { body: await bodyOf(c).arrayBuffer() })` 重建 |
| 全量 `query()` 解构     | `c.querystring`(原始串)或 `c.URL.searchParams`;定向读覆盖绝大多数场景                           |

`matchedRoutes`/`routeIndex`(Hono 自己 v4.8 已弃用)不学;`valid()` 六
目标验证是真实缺口,独立方案(0.7.3)另行评审。`routePath` 能力 keala
0.7.2 以 `c.routePath`/`c.routeName` 承接(Hono 弃属性换 Helper,keala
直接属性,合"无键事实→属性"规则)。

---

## 第六部分 设计史(裁决、实测、验收)

### 6.1 裁决记录(2026-09-04,全部已决)

1. **redirect body**:**空体**(仅 Location;删 koa 文本体渲染)。
2. **请求不可变**:**全删四个 setter**(url/path/search/querystring),
   请求只读;五写入器失效矩阵整条删除。
3. **`c.hostname`**:**删**(host 剥端口一行即得)。
4. **版本/节奏**:**一次性 0.7.0**(避免中间态双契约与双重迁移文档)。
5. **`c.set` → `c.setHeader`**(消与 Hono 的同名陷阱;读侧
   `c.header(name)/c.get(name)` 不变;状态是 `c.state`,与之无关)。
6. **README 重定位**:"洋葱 + 双态 + Bun 原生快路径"。

### 6.1b 裁决记录(2026-09-05,R411,0.7.2 实施)

1. **`bodyOf(c)`**:插件化正文的类型化访问器,库内唯一 cast;未装插件
   抛带修复指引的 TypeError(替代无指引的 `undefined.req`)。declaration
   merging 对"内部声明+再导出"的入口不可行,泛型方案破坏扁平性——
   访问器是终裁。
2. **`c.get` 退役**:0.7.0 只改了写侧,读侧 koa 别名漏了;读请求头单
   入口 `c.header(name)`,与 `c.setHeader` 严格对偶。
3. **`c.params` 永不为 null**:handler 只在匹配后运行,类型不该为最
   罕见场景买单;未匹配中间件读冻结空对象,属性读取逐字节不变。
4. **`c.routePath` / `c.routeName`**:运行时匹配模式(含 mount 前缀),
   观测地基——metrics 标签/span 名用有界模式而非高基数路径;与 params
   同族直读槽位,注册期一次 pattern 引用赋值,请求期命中路径 +2 属性写。
5. **不学清单**:parseBody({dot})/cloneRawRequest/全量 query()/matchedRoutes
   (配方替代,见 D14);validator 多目标独立 0.7.3 方案。

### 6.2 删除的 koa 语义面(0.7.0;U1-U3c 迁移续删)

0.7.0 删:`c.message`(get/set)、`c.fresh`、`c.stale`、`c.vary`、
`c.back()`/`c.redirect("back")`、`c.subdomains`、`c.ips`、`c.hostname`、
`c.charset`、`c.reqType`、`c.acceptsCharsets`、`c.acceptsLanguages`、
`c.toJSON()`、`c.headerSent`、`c.originalUrl`、"body 槽位直存 Response"
的 koa 怪癖、koa 405/501 消息体、redirect 文本体。逐项替代写法:
`docs/MIGRATION-0.7.md` §5。

U1-U3c 迁移(2026-09-06)续删整个状态式响应面:params 的下标/属性/
解构形态(→ `c.params(name)` 函数式)、响应 body/type/length/etag/
lastModified/attachment/res 的全部访问器、status 写路径(读保留)、
redirect 的 void staged 调用形态(→ 纯构造器,必须 return)。
行为映射、有损映射的替代配方与实施记录:
`docs/KEALA-NATIVE-API-MIGRATION.md`。

### 6.3 性能实测(R4.6/R4.9/R4.10 协议,vs Hono 4.13.5)

| 场景           | 运行时     | K/Hono           | 备注                                                                    |
| -------------- | ---------- | ---------------- | ----------------------------------------------------------------------- |
| text           | Bun / Node | 1.00 / 1.00-1.05 | 平到领先                                                                |
| json           | Bun / Node | 1.06 / 1.03      | 领先                                                                    |
| param          | Bun / Node | 1.00 / 1.04      | 平到领先                                                                |
| query          | Bun / Node | **1.01** / 0.88  | Bun 领先;Node 残差 = fixture 全局 body-parser 层 + V8 散布(进程内 0.95) |
| middleware-3   | Bun / Node | 1.02 / **1.58**  | Node 大幅领先(洋葱 205 vs 602ns)                                        |
| probe(/livez)  | Bun / Node | 1.02 / 1.05      | 领先                                                                    |
| json-body-safe | Bun / Node | 1.02 / 1.14      | 领先                                                                    |

etag 开销(R4.10 修复后):30k 行 JSON,Node +0.11ms、Bun +0.05ms
(单次序列化 memo + 原生哈希道)。原始样本 `docs/bench/*.jsonl`。

### 6.4 验收(全部通过)

1. 速查表即全 API:表面锁测试通过(§2.3;0.7.2 删 `get` 行,params/
   routePath/routeName 是直读槽位不计入表面锁)。
2. 全门禁绿:2000+ 用例在 Node 与 Bun 双运行时全绿、coverage ≥90
   底线、build、soak(双运行时)/example/
   process:check;R411 抽查:命中路径 +2 属性写零位移(stash 前后
   对照,机器噪声带内)。
3. 契约测试:提交后写入抛、请求只读、redirect 码校验、405/501 空体、
   错误漏斗防护头收割(R4.10 审计 30 项回归锁;R411 十项:
   test/r411-api-ergonomics.test.ts)。
4. `docs/MIGRATION-0.7.md` 覆盖每个删除项的替代写法(§10 为 0.7.2)。

---

## 第七部分 底层原语(`keala` 根入口)

框架赖以构建、且**稳定导出**的底层件。它们不是内部实现细节——嵌入式
产品、测试替身与自定义中间件直接消费这些原语,语义被测试锁定。

### 7.1 洋葱原语:`compose` / `direct` / `NOOP_TAIL`

`compose(handlers)` 在注册期把中间件数组编译成嵌套调用链(每层一个小
`next` 闭包,双 `next()` 抛错);`direct(handler)` 是无守卫的单 handler
链——无中间件路由的快路径;`NOOP_TAIL` 是空尾巴。handler 返回的
Response 由链 commit 进 `_res` 槽(最后提交者赢)。

```ts
import { compose, direct, NOOP_TAIL, type MiddlewareContext } from "keala";

const chain = compose<MiddlewareContext>([
  async (c, next) => {
    await next(); // 洋葱:下游跑完再继续
  },
  (c) => {
    c.state["ran"] = true; // 返回 void = 不提交
  },
]);
const mc: MiddlewareContext = { state: {}, _res: undefined };
await chain(mc, NOOP_TAIL);
mc._res; // undefined —— 没有人提交 Response

const solo = direct<MiddlewareContext>((c) => new Response("hi"));
await solo(mc, NOOP_TAIL);
mc._res; // Response("hi") —— 返回值被 commit 进槽位
```

### 7.2 Cookie 原语:`signCookie` / `unsignCookie` / `parseCookies` / `serializeCookie`

`c.cookies` 背后的四个纯函数。签名与 Keygrip 格式兼容(`value.signature`,
HMAC-SHA256);`unsignCookie` 恒时比较、任一 key 可验(密钥轮换);
`parseCookies` 返回 null 原型 Map;`serializeCookie` 对名/值做 RFC 6265
校验,违规抛 TypeError(响应拆分防线)。

```ts
import { signCookie, unsignCookie, parseCookies, serializeCookie } from "keala";

const signed = signCookie("session-data", "secret-key"); // "session-data.<b64url-hmac>"
const ok = unsignCookie(signed, ["new-key", "secret-key"]); // "session-data";验签失败 false

const jar = parseCookies('a=1; b="x%20y"'); // null 原型 { a: "1", b: "x y" }

const header = serializeCookie("sid", "v", { httpOnly: true, maxAge: 3600, path: "/" });
// "sid=v; Max-Age=3600; Path=/; HttpOnly"
```

### 7.3 服务器引导:`startBunServer`

`app.listen()` 的底层:为应用启动 `Bun.serve`(fetch/error/websocket/
原生路由表全部在此接线),返回 Bun 的 `Server` 句柄。第 4 参可注入
serve 实现——测试里替换 Bun.serve 而不动应用代码。

```ts
import { Keala, startBunServer } from "keala";

const app = new Keala();
const server = startBunServer(app, { port: 3000, signals: true });
server.stop(); // 与 app.listen() 返回的句柄同型(reload/stopGraceful)
```

### 7.4 准入策略:`failFastAdmission` / `queueAdmission`

`overload.strategy` 的两个内建值,显式注入用。默认选择是隐式的:
`maxQueue > 0` 排队,否则 fail-fast——注入可覆盖(如 maxQueue > 0 时
仍拒绝)。`failFastAdmission` 在到顶瞬间拒绝;`queueAdmission` FIFO
排队至 `maxQueue`,槽位释放时同步转移,等待者超时/断开/排水即离队。

```ts
import { Keala, failFastAdmission } from "keala";

const app = new Keala({
  overload: {
    maxConcurrency: 512,
    maxQueue: 100, // 默认会排队——
    strategy: failFastAdmission, // 注入后显式 fail-fast,忽略队列
  },
});
```

### 7.5 路由编译:`compilePattern`

把路径模式编译为段 IR(静态/参数/通配 + 自定义正则),trie 与快速
matcher 共用;畸形模式在注册前抛 TypeError。`isStatic` 决定是否进
静态 Map,`isSimple` 识别"静态头 + 朴素参数"的快路径形态。

```ts
import { compilePattern } from "keala";

const ir = compilePattern("/users/:id(\\d+)/files/*");
// segments: static "users" → param "id"(regex ^(?:\d+)$) → static "files" → wildcard
ir.isStatic; // false —— 含动态段,不进静态 Map
compilePattern("/x/:bad([unclosed"); // TypeError:畸形模式注册前即失败
```

### 7.6 有界正文读取:`readBodyLimited`

`createBodyParser` 与 `validator` 底下的一次性有界读取:声明长度超限
快败(413),流式读取在边界处中止。自定义读取器(非 JSON/表单的正文
协议)直接用它,不必装插件。

```ts
import { readBodyLimited } from "keala";

app.post("/custom", async (c) => {
  const bytes = await readBodyLimited(c, 1 << 20); // 1MiB 上限
  return c.json({ received: bytes.byteLength });
});
```

### 7.7 HTML 转义:`escapeHtml`

`html` 标签模板使用的同一张转义表(`& < > " '` 五字符),独立导出——
不在标签模板里也要转义时(拼属性、日志脱敏)用它,别手写。

```ts
import { escapeHtml } from "keala";

escapeHtml(`<b>"x"&'y'</b>`);
// "&lt;b&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/b&gt;"
```

### 7.8 空闲超时:`disableIdleTimeout`

对当前请求关闭 Bun 的每请求空闲超时(`server.timeout(req, 0)`)——
`streamSSE`/`streamText` 内建使用;自己手搭长响应时也需要。无 Bun
服务器句柄时(Node、测试)是 no-op。

```ts
import { disableIdleTimeout, streamText } from "keala";

app.get("/tail/:id", (c) => {
  disableIdleTimeout(c); // 否则 Bun 默认 10s 掐断空闲流
  return streamText(c, async (w) => {
    /* 长连接写 */
  });
});
```

### 7.9 密码哈希器:`pbkdf2PasswordHasher`

默认哈希器本体:WebCrypto PBKDF2-SHA-256、600k 轮、16 字节盐、恒时
比较,产物 `pbkdf2$600000$<salt b64>$<key b64>`(Bun/Node 可移植)。
显式传入 `hashPassword`/`verifyPassword` 以固定算法;verify 对轮数
设界(1k-5M)——敌意哈希串不能把校验变成 CPU 炸弹,畸形数据一律
false(失败关闭)。

```ts
import { hashPassword, pbkdf2PasswordHasher, verifyPassword } from "keala";

const hasher = pbkdf2PasswordHasher();
const hash = await hashPassword(pw, hasher); // 算法显式固定
await verifyPassword(hash, pw, hasher); // true/false;坏数据 false
```

### 7.10 状态码工具:`statusMessage` / `isValidErrorStatus`

`statusMessage(code)` 返回 IANA 短语(未知码 `""`);`isValidErrorStatus`
只认 400-599 整数——`c.throw` 的状态校验即它。同族还导出
`isEmptyStatus`(204/205/304,无体无内容头)与 `isRedirectStatus`
(300-303/305/307/308)。

```ts
import { isValidErrorStatus, statusMessage } from "keala";

statusMessage(429); // "Too Many Requests";statusMessage(599) === ""
isValidErrorStatus(302); // false —— 重定向不是错误状态
isValidErrorStatus(429); // true
```
