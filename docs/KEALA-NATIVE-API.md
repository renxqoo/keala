# keala 原生 API 参考(0.7.x)

> 状态:0.7.0 已裁决定稿并实施(2026-09-04),R4.10 审计修订(同日)。
> 本文是 keala 的**完整 API 参考**:每个 API 的签名、用法,以及与 Hono
> 的逐项差异与**为什么**。设计史(裁决记录、性能实测、验收)保留在
> 第六部分。对照源:keala `src/`(0.7.1)与 Hono 4.13.5
> (`.parity/hono/src/`,逐条核对)。

---

## 第一部分 设计原则与定位

### 0. 五条原则

1. **一页纸可记住**:context 公共面就是 §2.3 的速查表——多一项少一项
   都会被测试锁死(`test/commit-0-7-contract.test.ts` 的表面锁)。
2. **实测快的留下**:双态响应(138 vs Hono 197ns)、洋葱
   (205 vs 602ns)、定向 query 读(~2ns)——keala 自己的赢法。
3. **纯 koa 语义仿真删除**:为"与 koa 一致"而非正确性必需的分支一律
   不存在(0.7.0 已删 16 项,见第六部分 §6.2)。
4. **已提交即冻结**:Response 提交后 `c.body/c.status/c.redirect` 写入
   抛 `TypeError`;头部写入直写已提交 Response 的 `Headers`。零重建机器。
5. **请求是客户端的事实**:请求侧全部只读;要改派生值,放 `c.state`。

### 1. 定位

```
keala = 洋葱模型 + 双态响应 + Bun 原生快路径(+ Node 官方适配器)
```

- 双态:handler **返回** Response(`c.text/c.json/c.html` 或自建),
  或**状态式**写(`c.body/c.status`)。两态统一为"最后提交者赢"。
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

app.get("/hello/:name", (c) => c.text(`hello ${c.params?.["name"]}`));

const server = app.listen(3000, "127.0.0.1");
// 优雅停机:SIGTERM → 排空在途 → 关连接池 → 退出
process.on("SIGTERM", () => {
  void app.close({ drain: 10_000 }).then(() => flushLogs());
});
```

---

## 第二部分 Context 完整参考

一个请求一个扁平 context 对象——请求侧、响应侧、糖共用一个原型,
没有 `c.req` 门面(Hono 有;为什么见第五部分 D2)。

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

c.params; // 路由参数:{ id: "12345" };未匹配路由时 null
// 访问:c.params?.["id"](可能为 null,用可选链)

c.header("x-token"); // 请求头,缺失 ""(注意:不是 undefined)
c.get("referer"); // 同 c.header;"referrer"/"referer" 可互换
c.headers; // 原生 Headers 对象(需要遍历时用)

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

**未提交**(暂存,零分配直到首次写):

```ts
c.status = 201; // 200-599 整数,否则 TypeError
c.body = "hello"; // string | Uint8Array | ReadableStream | Blob | 对象 | null
c.body = { ok: true }; // 对象 → JSON 序列化
c.body = null; // null → 204(未显式设状态时)
c.type = "json"; // 简写自动展开("json" → application/json; charset=utf-8)
c.length = 42; // content-length(与 transfer-encoding 互斥时忽略)
c.etag = "v1"; // 自动加引号:'"v1"'(已带 " 或 W/ 则原样)
c.lastModified = new Date(); // Date 或可解析字符串,否则 TypeError

c.setHeader("X-Trace", "abc"); // 单值;对象形式 c.setHeader({ A: "1", B: 2 })
c.append("Vary", "Origin"); // 多值追加
c.remove("X-Unwanted"); // 删除
c.has("X-Trace"); // boolean(提交后读穿到已提交 Response)
c.resHeader("X-Trace"); // string;缺失 ""
c.attachment("report.pdf"); // Content-Disposition + 按扩展名推断类型
c.attachment("报表.bin", { fallback: "report.bin", type: "inline" });

c.redirect("/login"); // 302 + Location,空体
c.redirect("/gone", 301); // 显式码必须 3xx 整数,否则 TypeError
// 开放重定向防护:`//evil.com`、`https:/evil.com` 会被中和为同源路径
// c.redirect 之前已 staged 的 3xx(如 c.status=308)保留,不降级 302
```

**提交**(任一糖返回,或 handler `return new Response(...)`)之后:

```ts
// 抛 TypeError("response already committed"):
c.body = "x";
c.status = 500;
c.redirect("/y");
// 要替换已提交响应:构造新 Response 返回覆盖
app.use(async (c, next) => {
  await next();
  const inner = c.res;
  if (inner !== undefined && inner.status === 200) {
    return new Response(`wrapped(${await inner.text()})`, inner);
  }
});

// 头部写入【不抛】——直写已提交 Response 的 Headers(与 Hono 同语义):
c.setHeader("X-Late", "1");
c.append("Vary", "Origin");
c.type = "text/csv";
// 读取:c.status / c.type / c.length / c.has / c.resHeader 读提交值

// c.res:已提交的 Response 对象(状态式下 undefined)
c.res?.status;
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
c.query(name)  c.queries(name)  c.params  c.ip  c.host  c.protocol  c.secure
c.origin  c.href  c.idempotent  c.reqLength  c.URL
c.headers  c.header(name)  c.get(name)  c.raw  c.signal  c.runtime
c.is()  c.accepts()  c.acceptsEncodings()

// 响应(提交前暂存;提交后头部可写、body/status/redirect 抛)
c.body  c.status  c.type  c.length  c.etag  c.lastModified  c.attachment
c.setHeader(k, v)  c.append(k, v)  c.remove(k)  c.has(k)  c.resHeader(k)
c.redirect(url, code?)  c.res
c.text(s, status?, headers?)  c.json(x, status?, headers?)  c.html(s, …)

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
```

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
  onStreamError: (err, c) => log(err), // 状态式流体错误观察
});
```

### 3.2 路由与中间件

```ts
app.get("/users/:id", handler); // 路径参数;?x? 可选段;* 通配
app.get("/files/*", handler); // 前缀通配
app.get("/report", "named-route", handler); // 命名路由(第二参为名)
app.post / put / patch / delete /head/inoopst / all("/x", ...handlers);
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
  open(ws, c) {
    broadcast(c.params?.["room"], "joined");
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

await app.close({ drain: 10_000 }); // → { timedOut: false, inFlight: 0 }
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
timing()                            // Server-Timing 总时延;c.state.timingMark(n) 记段
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
validator(schema)                   // Standard Schema(zod4/valibot/typebox)→ c.valid
```

```ts
// 正文读取(createBodyParser 插件:jsonLimit/textLimit/formLimit/formPartLimit)
app.use(createBodyParser({ jsonLimit: 1 << 20, formLimit: 10 << 20 }));
app.post("/echo", async (c) => {
  const body = await (c as ContextWithBody).req.json(); // memo 化,重复读安全
  return c.json(body);
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

### D1. 参数:`c.params?.["id"]` vs `c.req.param("id")`

```ts
// Hono                              // keala
const id = c.req.param("id");
const id = c.params?.["id"];
```

**为什么**:路由匹配时 keala 把参数作为普通对象预填进 context 槽位
(dispatch 一次物化),读取是纯属性访问——零函数调用、零分配。Hono 的
`c.req.param()` 每次调用走 HonoRequest 门面再进 `#cachedParamData`。
千路由规模实测 keala 匹配快 6-81x(见 §9.2);读取侧差距是同一来源。

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
迁移成本一次性付清,陷阱永久消失。读侧缺失返回 `""`(falsy 但可判),
Hono 返回 `undefined`——统一 falsy 判断,代价是区分"缺失"与"空值"
需 `c.headers.get()`(返回 null)。

### D4. 响应:双态(状态式 + 返回式)vs 仅返回式

```ts
// Hono(只有返回)                   // keala(两态并存)
return c.text("hi");
return c.text("hi"); // 糖,Hono 同签名
return c.body("hi");
c.body = "hi"; // 状态式,写完即走
return c.json({ a: 1 });
c.body = { a: 1 }; // 对象 → JSON
c.status = 201;
c.body = "created";
```

**为什么**:状态式(直接槽位写)是 keala 实测最快路径(138ns vs Hono
糖 197ns)——省掉糖函数调用与 Response 构造包装。Hono 的 `c.body()`
本质也是"构造并返回",只是强制走返回。keala 两态统一在"最后提交者赢":
中间件短路(状态式)与 handler 返回(糖)平权。**已删除**:`c.body =
someResponse` 的 koa 怪癖(0.7.0)——语义陷阱(取 `.body` 存储而非
对象本身),直接 `return` 即可。

### D5. 提交契约:冻结 + 就地装饰 vs 静默覆盖

```ts
// Hono:handler 返回后仍可整体替换   // keala:提交后
c.res = newResponse;                 c.body = "x";    // ← TypeError!
const res = c.res;                   c.status = 500;  // ← TypeError!
c.res = new Response(res.body, …);   c.setHeader("X-Late", "1"); // ✓ 直写已提交 Headers
                                     return new Response(…);     // ✓ 返回覆盖
```

**为什么**:Hono 允许 `c.res =` 整体替换,响应在链上流动时身份可变,
推理成本高;keala 0.7.0 删除了整类 rule-4 重建机器(旗标合并矩阵、
`rebuildCommitted`),换成两条硬规则——**body/status 冻结**(写即抛,
要换就显式构造新 Response 返回)、**头部就地写**(与 Hono 的
post-`next()` `c.header()` 同语义)。错误漏斗会收割已提交 Response 的
头重建错误页,防护头不丢(R4.10)。这是可预测性换灵活性的裁决。

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

**为什么**:功能等价(单槽 onError、5xx 默认隐藏)。`c.throw` 沿用
koa 的人体工学(状态优先、props 收拢 expose/code/headers),少一个
导出类;`c.assert` 是 Hono 没有的便捷面。

### D7. 中间件状态:`c.state` vs `c.set()/c.var`

```ts
// Hono                              // keala
c.set("message", "hi");              c.state.message = "hi";
const m = c.get("message");          const m = c.state.message;
// 类型化工厂:                       // 类型化扩展:
const mw = createMiddleware<         app.decorate("db", pool);
  { Variables: { msg: string } }>(…) c.db.query(…);   // 每个 context 固定成员
const m = c.var.msg;
```

**为什么**:Hono 需要字符串键 + 泛型工厂给中间件变量上类型,读侧分
`c.get`(写读)与 `c.var`(只读)两套。keala:`c.state` 是 null 原型
普通对象(首次触碰才分配,零状态请求零成本),类型自然推导;跨中间件
的**强类型**服务走 `decorate`(app 级一次声明)。Hono 的 `c.env`(
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
**同一个 context**(连接生命周期内可读 `c.params/c.state`)。代价:
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

### 6.2 删除的 koa 语义面(0.7.0)

`c.message`(get/set)、`c.fresh`、`c.stale`、`c.vary`、`c.back()`/
`c.redirect("back")`、`c.subdomains`、`c.ips`、`c.hostname`、
`c.charset`、`c.reqType`、`c.acceptsCharsets`、`c.acceptsLanguages`、
`c.toJSON()`、`c.headerSent`、`c.originalUrl`、`c.body = <Response>`、
koa 405/501 消息体、redirect 文本体。逐项替代写法:
`docs/MIGRATION-0.7.md` §5。

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

1. 速查表即全 API:表面锁测试通过(§2.3)。
2. 全门禁绿:Node 2317 / Bun 2261 测试、coverage ≥90 底线、build、
   smoke/soak(双运行时)/example/process:check;CI 绿。
3. 契约测试:提交后写入抛、请求只读、redirect 码校验、405/501 空体、
   错误漏斗防护头收割(R4.10 审计 30 项回归锁)。
4. `docs/MIGRATION-0.7.md` 覆盖每个删除项的替代写法。
