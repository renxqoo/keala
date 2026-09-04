# 迁移指南:0.6 → 0.7(keala 原生 API)

0.7 一次性完成去 koa 化(设计文档:`docs/KEALA-NATIVE-API.md`)。本文
给出**每一个**破坏项的旧写法 → 新写法。0.6 → 0.7 是 pre-1.0 语义破坏:
TypeScript 会在编译期抓出绝大多数调用点。

## 1. 一句话心智模型

```
请求是客户端的事实(只读);响应在提交前是暂存、提交后头部仍可装饰、
正文/状态冻结(写入抛 TypeError)。
```

## 2. 头部:`c.set` → `c.setHeader`

```ts
// 0.6                              // 0.7
c.set("X-A", "1");
c.setHeader("X-A", "1");
c.set({ "X-A": "1", "X-B": 2 });
c.setHeader({ "X-A": "1", "X-B": 2 });
c.vary("Origin");
c.append("Vary", "Origin");
```

读侧不变:`c.header(name)` / `c.get(name)`(请求头)、`c.resHeader(name)`、
`c.has(name)`。状态是 `c.state`,与 `c.setHeader/c.get` 无关(这正是改名
的理由:0.6 的 `c.set` 与 Hono 的 `c.header` 同义不同名,是移植陷阱)。

## 3. 提交契约(最大的行为变化)

一个 Response 提交(handler `return` 了 Response,或 `return c.text()/
c.json()/c.html()`)之后:

| 写入                                                                 | 0.6          | 0.7                                    |
| -------------------------------------------------------------------- | ------------ | -------------------------------------- |
| `c.body = …` / `c.status = …` / `c.redirect(...)`                    | rule-4 重建  | **TypeError**                          |
| `c.setHeader/append/remove/type/length/etag/lastModified/attachment` | rule-4 重建  | **直接写进已提交 Response 的 Headers** |
| 不可变 Response(fetch 来的)上写头                                    | 语义重建回退 | **TypeError**                          |

```ts
// 0.6:提交后改正文(静默重建)
app.use(async (c, next) => {
  await next();
  c.status = 500; // 0.7: throws TypeError
  c.body = "wrapped"; // 0.7: throws TypeError
});

// 0.7:要替换已提交的正文,构造并返回新 Response
app.use(async (c, next) => {
  await next();
  const inner = c.res;
  if (inner === undefined || inner.status !== 200) return;
  return new Response(`wrapped(${await inner.text()})`, inner);
});

// 0.7:装饰头部仍然直写(洋葱习惯用法全部保留)
app.use(async (c, next) => {
  await next();
  c.setHeader("X-Response-Time", "12ms"); // ✓ 写在已提交 Response 上
  c.append("Vary", "Origin"); // ✓
});
```

细则:

- 提交后的 SET/REMOVE 会幂等重放到**更新的提交**与错误漏斗重建的响应
  (secureHeaders 在外层抛错后仍然覆盖错误页)。
- 提交后的 APPEND 与 `c.setHeader("Set-Cookie", …)` 只作用于当时的
  Response;late cookie 请走 `c.cookies.set`(写暂存记录,提交合并时
  与已有 cookie 连接,不替换)。
- 洋葱中间件返回的新 Response **整体获胜**:它未引用旧 Response 的
  头部时,旧 Response 上的 append/set-cookie 不会带过去——要保留就
  从 `c.res` 读出来构造。

## 4. 请求不可变

```ts
// 0.6                              // 0.7
c.url = "/rewritten"; // 删除——写入抛 TypeError
c.path = "/new"; // 删除
c.search = "?a=1"; // 删除
c.querystring = "a=1"; // 删除
const full = c.originalUrl;
const full = c.url; // 请求不可变后恒等
```

要"改写请求"的效果,在中间件里把派生值放进 `c.state`,下游读它。

## 5. 已删除的 koa 语义 API → 替代

| 删除                              | 替代                                                       |
| --------------------------------- | ---------------------------------------------------------- |
| `c.message` / statusText 自定义   | 无(sugar/finalizer 用标准 reason phrase)                   |
| `c.fresh` / `c.stale`             | `etag()` 中间件 / `http/conditional.ts` 的 `isNotModified` |
| `c.redirect("back")` / `c.back()` | 自己读 `c.get("referrer")` 判断后 `c.redirect(target)`     |
| `c.subdomains`                    | `c.host.split(".")` 自取                                   |
| `c.ips`                           | `c.ip` + 显式读 `c.get("x-forwarded-for")`                 |
| `c.hostname`                      | 从 `c.host` 剥端口:`c.host.replace(/:\d+$/, "")`           |
| `c.vary(field)`                   | `c.append("Vary", field)`                                  |
| `c.charset` / `c.reqType`         | `c.header("content-type")` 自解析(`c.is(...)` 仍在)        |
| `c.acceptsCharsets/Languages`     | 读 `accept-charset` / `accept-language` 头自解析           |
| `c.toJSON()`                      | 无(调试遗产)                                               |
| `c.headerSent`                    | 无(恒为 false 的 koa 兼容桩)                               |
| `c.body = someResponse`           | `return someResponse`                                      |

## 6. redirect:空体 + 显式码

```ts
// 0.6:koa 文本体
c.redirect("/target"); // 302 + "Redirecting to /target." 文本/HTML 体
c.redirect("back", "/alt"); // Referrer 门控跳回

// 0.7:Location-only
c.redirect("/target"); // 302, Location, 空 body
c.redirect("/gone", 301); // 显式码必须 3xx 整数,否则 TypeError
c.status = 308;
c.redirect(u); // 已 staged 的 3xx 保留
```

断言迁移:0.6 测试读 redirect body 的,0.7 一律期望 `""` 且无
content-type。开放重定向防护(`//evil.com`、`https:/evil.com` 的中和)
不变。

## 7. 合成响应:405/501 空体

```ts
// 0.6:405 + "Method Not Allowed" 文本体;501 同理
// 0.7:405/501 + Allow 头 + 空 body(OPTIONS 200 空体不变)
```

`c.status = 4xx/5xx` 且 body 未设时回填状态文案的自有契约**不变**
(那是 keala 契约,不是 koa 税)。

## 8. 中间件作者速查

- 在 `await next()` **前**写 `c.body/c.status`:与 0.6 相同(暂存)。
- 在 `await next()` **后**:
  - 只装饰头部 → 照旧写 `c.setHeader/append/remove`(现在更便宜)。
  - 要改状态/正文/重定向 → `return new Response(...)`。
- `c.cookies.set` 任何时刻可用(提交后经暂存记录合并,连接不替换)。
- `secureHeaders/requestId/timing/cors/csrf/etag/compress` 已全部适配。

## 9. R4.10 审计修复带来的行为变化(0.7.1)

**响应/中间件**:

- **提交后 APPEND 合并语义**:提交后 `c.append` 会并入暂存记录的既有条目
  (此前会被记录合并静默抹掉——丢 Vary)。
- **错误漏斗收割已提交 Response 的头**:sugar 提交后外层抛错,错误页现在
  保留防护头与 cookie(此前 sugar 提交路径会丢)。
- **content-describing 头不再镜像重放**:提交后 `c.type/c.length` 只作用于
  当前 Response,不再覆盖新提交自己的 content-type/length。
- **共享 Response 警告**:不要返回模块级共享的 Response 对象——提交后的
  头部写入是**就地**的,会跨请求累积污染(Vary 变长等);Bun 侧重发已消
  费的 Response 是 500,Node 侧现在同样是**带框架的 500**(旧版发无框
  架空响应并杀死连接)。

**cookies**:

- **`Path` 默认 `/`**(与 `cookies` 包/koa 一致):此前不写 Path 的 cookie
  按 RFC 6265 默认路径收窄(在 `POST /api/auth/login` 设置的 cookie 不再
  发给 `/api/*`),静默破会话。显式 `path` 永远生效。
- **值校验放宽**:仅拒绝 CR/LF/NUL/C0 控制符——对称编解码器会把空格、
  引号、逗号、分号、非 ASCII 百分号编码为 wire 安全形式(旧校验把编码器
  本可安全处理的都拒了)。

**bodyParser**:`c.req.arrayBuffer()/blob()` 的预算归属从 `jsonLimit` 改为
`formLimit`(原始字节读取是上传形态;只调了 formLimit 的用户此前会收到
点名 jsonLimit 的 413)。

**responseCache**:只捕获框架快照体(sugar/状态模式字符串与 JSON 文本);
流式与手建 Response 一律不捕获(消费未知流会在洋葱内死锁/双缓冲,无 CT
字节体会以 U+FFFD 损坏重放)。新增 `maxBytes`(默认 64MiB,LRU)与
`maxEntryBytes`(默认 4MiB)字节预算。

**serveStatic**:dotfiles 默认忽略(`.well-known` 除外;`dotfiles: "allow"`
恢复);Node 侧 HEAD 不再全量读文件;Node 侧 GET 支持单区间 Range(206)。

**准入(overload)**:`maxConcurrency` 是**硬上限**——迟到的异步策略 null
在容量被重新占满时按 503 拒绝,不再超订;策略 `admit()` 后拒绝/抛错会正确
归还槽位。

**Node adapter**:接受 Bun 对齐键 `idleTimeout`(秒→keepAliveTimeout 毫秒)
与 `maxRequestBodySize`(传输级硬上限,插件更宽松的限制不能重开);
Bun-only 键(reusePort/nativeRoutes/websocket/development)给出迁移指引
而非裸 unknown-option。新增 `app.onShutdown(handler)`:排空完成后、close()
resolve 前按注册顺序运行一次(刷日志/指标、关连接池),失败被包容。

## 10. 0.7 → 0.6 反向(降级)注意

无官方降级路径。若必须:恢复 `c.set` 改名、重新引入 rule-4
(`src/core/respond.ts` 的 git 历史)、恢复 0.6 的 request setter 与
koa 语义 API。不建议。
