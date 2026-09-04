# keala 原生 API 设计(0.7.0 候选)

> 状态:**已裁决定稿**(2026-09-04),实施目标 0.7.0(一次性)。全部
> 悬项已决:redirect 空体;请求 setter 全删(只读);c.hostname 删;
> `c.set` → **`c.setHeader`**(消同名陷阱);一次性 0.7.0。本文是去
> koa 化的独立设计文档:逐项删留清单、新契约、错误模型、迁移与验收。
> 依据:本仓库全部实测(进程内 ABAB 微基准、R4.6 协议矩阵、四路红测
> review)。用户裁决方向:**不守 koa 兼容;API 要简单、直观、高性能、好记**。

## 0. 设计目标与原则

1. **一页纸可记住**:整个 context API 用一个速查表写得完(见 §8)。
2. **实测快的留下**:双态响应(138 vs Hono 197ns)、`c.set`(24 vs 33ns)、
   洋葱(205 vs 602ns)、定向 query 读——这些是 keala 自己的赢法,不是
   koa 的,全部保留。
3. **纯 koa 语义仿真删除**:凡是"为了和 koa 行为一致"而非正确性必需的
   分支/状态机/表面,一律出。
4. **已提交即不可变**:Response 一旦提交,再写就大声报错——删除 rule-4
   重建机器(这是 finalize 复杂度的主体,也是 query/param wire 差距的
   归因点之一)。
5. **请求是客户端的事实**:删请求改写(url/path/search/querystring
   setter)与五写入器失效矩阵。要改,写响应,不改请求。

## 1. 定位重述

```
keala = 洋葱模型 + 双态响应 + Bun 原生快路径
```

- 双态:handler 返回 Response(`c.text/c.json/c.html/自建`)或
  状态式写(`c.body/c.status`)。两态语义统一:**最后提交者赢,
  提交后再写 = TypeError**。
- 中间件洋葱不变(`await next()` 前后可写响应状态)。
- 生命周期/过载/下沉/trustedHosts/noOpFor(keala 原有资产)不动。

## 2. Context API——逐项清单

### 2.1 保留(实测赢或核心)

| API                                                         | 依据                                             |
| ----------------------------------------------------------- | ------------------------------------------------ |
| `c.params`                                                  | 核心                                             |
| `c.query(name)` / `c.queries(name)`                         | 0.6.2 已裁决的定向读                             |
| `c.querystring` / `c.search`(只读)                          | 定向读的原料,枚举需求出口                        |
| `c.url`(只读)                                               | memo 化(dispatch 传入)                           |
| `c.path`(只读)                                              | 同上                                             |
| `c.method` / `c.headers` / `c.header(name)` / `c.get(name)` | 核心                                             |
| `c.raw` / `c.signal`                                        | 懒物化/协作取消(R4.6)                            |
| `c.ip`                                                      | 限流/日志必需                                    |
| `c.setHeader / append / remove`                             | 头暂存,实测快(0.7 起 c.set 更名)                 |
| `c.body / c.status / c.type`                                | 状态模式,实测快                                  |
| `c.text / c.json / c.html`                                  | sugar,与 Hono 同签名                             |
| `c.throw / c.assert`                                        | 错误流                                           |
| `c.state`                                                   | 中间件传值(保留,koa/hono 皆惯用)                 |
| `c.cookies`                                                 | 签名/轮换,keala 强项                             |
| `c.is / c.accepts / c.acceptsEncodings`                     | content-nego(compress 内部依赖 acceptsEncodings) |
| `c.redirect(url, code?)`                                    | 显式 URL + 显式码,拒绝相对推断                   |
| `c.etag / c.lastModified / c.length`                        | 响应描述                                         |
| `c.attachment`                                              | 下载必需                                         |
| `c.runtime`                                                 | ip 解析通道                                      |

### 2.2 删除(纯 koa 语义税)

| API                                                 | 删除理由                                    | 迁移替代                                      |
| --------------------------------------------------- | ------------------------------------------- | --------------------------------------------- |
| `c.message`(get/set)                                | 状态行短语,近乎无人用;finalizer 分支        | 无(如需,sugar 加 statusText 参数)             |
| `c.fresh / c.etagMatches`(request.ts 私有副本)      | 与 conditional.ts 两套判定漂移(review C5)   | `etag` 中间件 / conditional.ts 单一实现       |
| `c.redirect("back") / c.back()`                     | 开放重定向面 + Referrer 门控复杂度          | 调用方自己读 `c.header("referrer")` 判断      |
| `c.subdomains`                                      | koa 遗产,低使用                             | `c.host.split(".")` 自取                      |
| `c.ips`(链表)                                       | proxy 语义边缘                              | `c.ip` + 显式读 `x-forwarded-for`             |
| `c.hostname`                                        | host 去端口即得                             | `(await)`:从 `c.host` 剥端口;若高频诉求后期补 |
| `c.vary`                                            | koa 工具                                    | `c.append("Vary", …)`                         |
| `c.charset / c.reqType`                             | 低频缩写                                    | `c.header("content-type")` 自解析             |
| `c.acceptsCharsets / acceptsLanguages`              | 低频                                        | parse 自取                                    |
| `c.toJSON()`                                        | 调试遗产                                    | 无                                            |
| `c.originalUrl`                                     | 只在请求可变时有意义;请求不可变后 ≡ `c.url` | `c.url`                                       |
| `set url / set path / set search / set querystring` | 五写入器失效矩阵整条删除                    | 不改请求(§0.5)                                |
| `c.body = <Response>`(存 value.body 的 koa 怪癖)    | 语义陷阱                                    | 直接 `return response`                        |
| koa 405 消息体                                      | parity 负担                                 | 405 + `Allow` 头,空体                         |
| redirect 的 "Redirecting to X" HTML/文本体          | parity 负担                                 | 空体 + Location(见 §7 裁决)                   |

### 2.3 变更(行为契约)

| 项                                | 旧(koa)                            | 新(keala 原生)                              |
| --------------------------------- | ---------------------------------- | ------------------------------------------- |
| 提交后再写                        | rule-4 重建(五类旗标合并机器)      | **TypeError("response already committed")** |
| 请求改写                          | url/path/search/querystring setter | 全部移除                                    |
| `c.status = 4xx/5xx` 且 body 未设 | koa 消息体回填                     | 保持现状(这是自有契约,非 koa 税)            |

## 3. 响应契约(新,一节讲完)

1. **未提交**:`c.body/c.status/c.type/c.setHeader/…` 暂存;任一 sugar
   (`c.text/json/html`)或 handler 返回 Response 即**提交**。
2. **已提交**(2026-09-04 实施修订,更精确的最终契约):
   - `c.body/c.status/c.redirect` 写入 → **TypeError**——要改正文,
     在中间件里自己构造新 Response 返回覆盖。
   - **头部写入不抛**:`c.setHeader/append/remove/type/length/etag/
lastModified/attachment` 直接写进已提交 Response 的 `Headers`
     (与 Hono 对 post-`next()` `c.header()` 的语义一致)。洋葱模型的
     核心习惯用法(timing/secureHeaders/Vary/post-next 头装饰)因此
     全部保留,而且比 rule-4 更便宜——零重建。
   - 提交后的 SET/REMOVE 会幂等镜像进暂存记录:外层中间件事后抛错
     时错误漏斗从头重建,防护头不丢;更新的提交(外层返回新
     Response)也会重放这些 SET。APPEND 与 Set-Cookie 的直接 SET
     只作用于当时那个 Response(重放会重复它们);late cookie 走
     cookies 门面,天然写记录、不受影响。
   - 不可变守卫(handler 返回了 fetch 来的 Response)上写入 →
     TypeError(本地构造 Response 再返回)。
   - 中间件在 `await next()` 后仍可读(`c.status/c.type/c.length/
c.has/c.resHeader` 读提交值)。
3. HEAD / 204 / 304 的线缆正确性(CL 回填、空体净化)保留——这是
   HTTP 正确性,不是 koa 税。
4. `redirect(url, code?)`:code 缺省 302,显式传入须为 3xx 整数
   (急切校验);已 staged 的 3xx 保留。设置 Location 后提交。无
   body(裁决项)。

**删除的机器**:`rebuildCommitted`、flags 32/64/128/2048/4096/8192
的合并矩阵、`removedValue`、`messageValue`、`implicitTextResponseValue`、
`committed-headers.ts` 三态守卫探测、对应 parity 测试(respond.ts
约 −40%,committed-headers.ts 整文件删除)。

## 4. 错误模型(保留,微调)

- `c.throw(status, message?, props?)` / `c.assert`:`expose`/`code`/
  `headers` 不变;prod 隐藏 5xx 消息、4xx expose 默认——自有契约。
- `app.onError(mapper)` 单槽不变;与 fn sink 的互斥不变。
- 合成响应(404/405/501/OPTIONS)走同一 finalize;405/501 体为空。
- onStreamError/onServeError 包含语义(review 修复)不变。

## 5. 中间件 / 路由 / 生命周期(全部保留)

- `app.use(pattern?, fn)` 洋葱、条件包装、`noOpFor` 透明声明——不动。
- 路由动词/get/post/…、`app.sink`(静态/dir/fn)、nativeRoutes、
  `patternsOverlap` 守卫——不动。
- 生命周期组(`app.close(drain)/isDraining/inFlight/signals/
overload/requestTimeout/c.signal`)——keala 自有,不动。
- `decorate/decorateLazy` + Plugin `{name, install}`——不动。
- Router/mount 保留(结构性,非 koa 税)。

## 6. 代码库影响清单

**删除**:

- respond.ts:rebuildCommitted + flag 矩阵 + 405/501 koa 体(~40% 文件)
- request.ts:五 setter、fresh/etagMatches、message/back/subdomains/
  ips/hostname/vary/charset/reqType/toJSON/originalUrl
- context/state.ts:`messageValue/removedValue` 槽、相关旗标
- 测试:koa parity 锁(rule-4 合并、五写入器、fresh、back、405 体…
  预估 −25~40% 测试量);`.parity/` 语料依赖退役
- docs/PARITY.md koa 对照大表(保留 deliberate-divergence 记录)

**新增**:

- 提交后写入的 TypeError 契约测试;只读请求访问器测试
- docs/MIGRATION-0.7.md(koa→keala、0.6→0.7 双向清单)

**不动**:adapters(bun/node)、lifecycle、sink、middleware 资产、
ws、cookies、密码/CSRF/CORS。

## 7. 裁决记录(2026-09-04,全部已决)

1. **redirect body**:**空体**(仅 Location;删 koa 文本体渲染)。
2. **请求不可变**:**全删四个 setter**(url/path/search/querystring),
   请求只读;五写入器失效矩阵整条删除。
3. **`c.hostname`**:**删**(host 剥端口一行即得)。
4. **版本/节奏**:**一次性 0.7.0**(避免中间态双契约与双重迁移文档)。
5. **`c.set` → `c.setHeader`**(消与 Hono 的同名陷阱);读侧
   `c.header(name)`/`c.get(name)` 不变;状态是 `c.state`(与
   `c.set/c.get` 无关)。
6. **README 重定位**:"洋葱 + 双态 + Bun 原生快路径"。

## 8. 速查表(目标:这一节就是全部 API)

```ts
// 请求(全部只读)
c.method  c.url  c.path  c.query("q")  c.queries("q")  c.querystring  c.search
c.header("x")  c.headers  c.params  c.ip  c.raw  c.signal  c.runtime

// 响应——提交前可写,提交后写入抛 TypeError
c.body  c.status  c.type  c.length  c.etag  c.lastModified  c.attachment
c.setHeader(k, v)  c.append(k, v)  c.remove(k)  c.has(k)  c.resHeader(k)
c.text(s, status?, headers?)  c.json(x, status?, headers?)  c.html(s, …)
c.redirect(url, code = 302)

// 错误 / 中间件 / 状态
c.throw(status, msg?, props?)  c.assert(cond, status, msg?)
c.state  c.cookies  await next()

// 应用
new Keala({ env, keys, proxy, pooling, overload, requestTimeout, trustedHosts })
app.get/post/put/patch/delete/head/options/on/all/use/ws/sink/mount
app.listen(port, { signals, nativeRoutes, idleTimeout, … })
app.close({ drain })  app.isDraining()  app.inFlight
app.onError(fn)  app.onShutdown(fn)  app.notFound(fn)  app.decorate(k, v)
```

## 9. 性能预期(诚实口径)——已实测定论(2026-09-04)

- **机制级(可测)**:finalize 分支面收敛;respond/sugar 的
  isNativeRequestSplit 13 处分支随规则简化而减;querystring/头失效
  链删除。预期 context+finalize 合计省几十~百余 ns/请求——正是
  query/param wire 差距的归因面。
- **wire 级实测**(R4.6 协议,200conn×4s×4 轮 ABAB,K/基线配对中位数,
  基线=2760ef4 即 0.6.2;原始样本 docs/bench/0-7-*.jsonl):

  | 场景         | 运行时   | K/Hono      | K/0.6.2 基线         |
  | ------------ | -------- | ----------- | -------------------- |
  | query        | Bun      | 0.960       | **+2.4%**(min +1.0%) |
  | query        | Node     | 0.852       | **+2.3%**(min +0.8%) |
  | text         | Node     | 1.035       | +1.3%                |
  | text         | Bun      | 0.972-0.981 | −2.0~2.4%(两腿复现)  |
  | param        | Bun/Node | 1.000/1.041 | 0.994 / 0.994(带内)  |
  | middleware-3 | Bun/Node | 1.024/1.580 | 0.993 / 1.003(带内)  |

  结论:**query 双运行时 +2.3~2.4%,机制级预测兑现**(query Bun K/H
  0.94→0.96);text-Node/带内场景不回归。唯一例外 text-Bun −2%:两腿
  复现但无代码路径可归因(该场景执行面——dispatchDirect 裸快路径 +
  createPlannedResponse——0.7 与 0.6.2 语义相同且只减不增;Node 同路径
  +1.3% 反向佐证),判定为代码布局/环境敏感带,按"无投机复杂度"纪律
  记录不追。

- **复杂度**:净 −919 行(119 文件,+1784/−2703),respond.ts 约 −40%,
  committed-headers.ts(三态守卫探测)整文件删除,finalize 可读性显著
  上升。

## 10. 验收

1. 速查表即全 API:entry-surface 测试锁定的公共面 ≤ §8 清单。
2. 全门禁绿(双运行时、coverage≥90 底线、smoke/soak/example/process)。
3. 契约测试:提交后写入抛、请求只读、redirect 码校验、405/501 空体。
4. R4.6 协议矩阵 7 场景 × 双运行时,与 0.6.2 带内对照不回归;
   query/param 单独出表。
5. docs/MIGRATION-0.7.md 覆盖每个删除项的替代写法。
