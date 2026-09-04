# R411 API 人体工学修复方案 v2(已实施,0.7.2)

> 状态:2026-09-05 评审通过并实施——Fix 1-4 全量落地,零兼容层(旧形态
> 全部删除),回归锁 test/r411-api-ergonomics.test.ts(10 项)。

> 目标:消除 keala 请求侧 API 的"规则例外"与观测盲点,把开发者使用成本
> 压到与理论最优持平——**不换结构**(扁平 context、属性/方法规则、
> 已锁性能全部不动),四处外科手术 + 一组纯文档动作。
>
> **v2 变更**(相对 v1,2026-09-05):
>
> - Fix 1-3 实质不变,各补一条 Hono 官方文档的佐证;
> - **新增 Fix 4**:`c.routePath` / `c.routeName` 运行时匹配模式(源自
>   hono.dev/docs/api/request 全景评审的"学 1",强推项);
> - 文档同步清单扩充(D13 url 语义分歧、D3 佐证、三则配方);
> - "不做清单"扩充四项新裁决(validator 多目标/queryAll/parseBody/
>   cloneRawRequest)。
>
> 依据:`docs/KEALA-NATIVE-API.md` D1-D12 + 开发者成本分析 +
> Hono 官方 Request API 文档 13 项全景对照(2026-09-05)。事实核查:
> body cast 全库 74 处;`c.get(` 内部 18 处(7 文件)/测试 19 处;
> `c.params?.[` 测试 118 处;RouteTarget 形状与赋位点见 Fix 4。

---

## Fix 1 —— 正文读取:`bodyOf(c)` 取代 cast 仪式

### 问题

```ts
// 现状:每个读正文的 handler 都要 cast + 手写门面类型
import { createBodyParser, type ContextWithBody } from "keala";
app.use(createBodyParser({ jsonLimit: 1 << 20 }));
app.post("/users", async (c) => {
  const body = await (c as ContextWithBody).req.json(); // ← 32 字符 + cast
});
```

cast 是插件化正文架构缺"类型携带"配套的结果,按 handler 计是全 API
最大的固定类型税;且插件未安装时是 `undefined.req` 的**静默运行时崩溃**,
没有修复指引。

### 方案:导出一个带类型的访问器 `bodyOf(c)`

```ts
// src/plugins/body-parser.ts 新增(运行时 ~8 行,cast 只存在于库内这一处)
import { createBodyParser, bodyOf } from "keala"; // 或 keala/middleware
app.use(createBodyParser({ jsonLimit: 1 << 20 }));
app.post("/users", async (c) => {
  const body = await bodyOf(c).json(); // ← 22 字符,零 cast
});
// 门面全部方法直达:bodyOf(c).text() / .arrayBuffer() / .blob() / .formData()
```

**未安装插件时的行为**(优于现状):`bodyOf` 抛出带修复指引的
TypeError——

```
bodyOf(c): body readers require the bodyParser plugin —
app.use(createBodyParser({ jsonLimit, formLimit, … })) first
```

(现状是 `Cannot read properties of undefined (reading 'json')`,
零指引。)

**Hono 佐证**(官方 Request 文档):Hono 的五个 body reader
(`json/text/arrayBuffer/blob/formData`)与 keala 门面一一对应——keala
缺的从来不是能力而是类型携带,`bodyOf` 正是只补这一块。Hono 另有的
`parseBody()`/`cloneRawRequest()` 明确不学,见"不做清单"与配方。

### 为什么不用 declaration merging(评审要点)

TS 的 `declare module` 增强**不允许相对路径**,而包名增强(`declare
module "keala"`)只能合并"声明在该入口模块里"的接口——keala 的
`Context` 声明在内部模块、由根入口**再导出**,不满足合并条件
(Fastify/Express 能用此法是因为类型就声明在入口模块)。hono 的
`Hono<Env>` 泛型方案则要给整套 app/handler 类型加参数,破坏扁平
简洁性,收益不成比例。**`bodyOf` 访问器是零风险、零类型体操、一次
cast 进库的方案**;`ContextWithBody` 类型保留(存量代码可继续用,
不再需要出现在新代码里)。

### 影响面

- 导出:根入口 + `keala/middleware` 各加 `bodyOf`(entry-surface 测试
  更新);
- 文档:KEALA-NATIVE-API.md 第四部分示例、README、MIGRATION;
- 测试:新增 3 项(正常读取、未装插件时错误消息、门面全方法直达);
  全库 74 处 `ContextWithBody` cast 迁移到 `bodyOf`(机械替换);
- 性能:一次函数调用 + 一次 undefined 检查(~2ns),不在热路径度量
  噪声内(POST 正文读取本身是微秒级)。

---

## Fix 2 —— `c.get(name)` 别名退役:`c.header` / `c.setHeader` 严格对偶

### 问题

```ts
// 现状:两个名字做同一件事(读请求头),且与写侧不成对
const token = c.get("authorization"); // ← koa 遗产别名
const token = c.header("authorization"); // ← 与 c.setHeader 构成对偶
```

双别名 = 多背一个名字 + "用哪个"的犹豫;更糟的是 `c.get` 让新手
默认 `c.get`/`c.setHeader` 操作同一个存储(get/set 对),实际一个读
请求、一个写响应——当前 API 里最名不副实的一处(0.7.0 改名时只改了
写侧,读侧别名漏了)。

### 方案:删除 `c.get`,读请求头只有 `c.header(name)`

```ts
// 修改前                      // 修改后
c.get("origin")               c.header("origin")
c.get("referer")              c.header("referer")   // referrer 拼写互换不变
```

读写从此严格对偶、单向、无歧义:

```ts
c.header("x-token"); // 读请求
c.setHeader("X-Trace", "1"); // 写响应
```

**Hono 佐证**:Hono 读请求头只有一个入口 `c.req.header(name)`
(写侧 `c.header(name, value)` 同名双向,是 D3 已记录的迁移陷阱);
单入口是两框架共识,keala 现状的双别名是孤例。

### 影响面(全库盘点已完成)

- src 内部 18 处迁移(7 文件:cors 4、serve-static 3、cache 3、
  etag 2、auth 2、headers 1、csrf-token 1、request.ts 内部互调 2);
- 测试 19 处 + `commit-0-7-contract` 表面锁删除 `get` 行 +
  KEALA-NATIVE-API.md §2.1/§2.3 更新;
- **破坏性变更**(0.x 允许):CHANGELOG + MIGRATION-0.7 §9 记一条
  "c.get(name) → c.header(name)",TS 编译期抓出全部调用点
  (0.7.0 改名同款体验);
- koa 迁移者影响:koa 的 `ctx.get` 语义相同,改名即可(文档给对照)。

---

## Fix 3 —— `c.params` 永不为 null:handler 里直接 `c.params["id"]`

### 问题

```ts
// 现状:类型是 Record | null,handler 里要可选链
app.get("/users/:id", (c) => c.text(`user ${c.params?.["id"]}`));
//                                            ↑ 防御性噪声:路由匹配了它就不可能是 null
```

事实:handler 只在**路由匹配后**运行,`params` 恒为对象;null 只出现在
未匹配路径的**中间件**里(404 兜底链)。类型系统让最常见场景为最
罕见场景买单——测试里 118 处 `params?.[`。

### 方案:空对象语义(EMPTY_PARAMS 作缺省),类型收窄为非空

```ts
// 运行时:CONTEXT_DEFAULTS.params 从 null 改为 EMPTY_PARAMS
//        (已存在的冻结空对象,dispatch 匹配路径的赋值不变)
// 类型:params: Record<string, string>   ← 不再 | null

// 修改前                              // 修改后
c.params?.["id"]                      c.params["id"]
const { id } = c.params ?? {}         const { id } = c.params
```

**Hono 佐证**(官方 Request 文档):Hono 的全量解构
`const { id, commentId } = c.req.param()` 不付任何 null 税——解构
形态下 keala 今天要 `?? {}`,Fix 3 对齐到零税。

**行为对照**(唯一语义变化点 = 未匹配路径的中间件读 params):

| 场景                           | 现状               | 修改后                        |
| ------------------------------ | ------------------ | ----------------------------- |
| 路由 handler                   | `{ id: "7" }`      | `{ id: "7" }`(不变)           |
| 匹配路径、无参数段的路由       | `{}`(EMPTY_PARAMS) | `{}`(不变)                    |
| 未匹配路径的中间件             | `null`             | `{}`(空对象)                  |
| `c.params["id"]`(未匹配中间件) | 运行时错误(null)   | `undefined`(与 `?.` 现状一致) |

即:**所有现存的属性读取行为逐字节不变**(可选链读空对象 = 读 null
= undefined)。需要迁移的只有对 `c.params` 的显式 null 判断——全库
盘点 **src 0 处、test 2 处**(`agent-r6-prop-invariants-3` 的池回收
泄漏检查改为 `Object.keys(c.params).length !== 0`;`agent-r6-diff-hono`
那处是路由器返回值、不是 `c.params`,不受影响)。**边界澄清**:本项
只改 context 槽位缺省;`matchRoute/matchPattern` 的可空返回值
(`RouteMatch | null`)是路由器内部 API,保持不变。

### 影响面

- src:`CONTEXT_DEFAULTS.params = EMPTY_PARAMS`(context.ts 1 行)+
  3 处 `c.params ?? {}`/`?? EMPTY_PARAMS` 冗余合并顺势简化
  (registration.ts ×2、sink.ts ×1;行为不变);pool 回收已覆盖
  (params 在 CONTEXT_SLOT_KEYS 内,每请求重赋值,共享冻结对象
  无污染风险);
- 类型:`ContextState.params: Record<string, string>`;
- 测试:118 处 `params?.[` 机械迁移为 `params[`(`?.` 在非空类型上
  仍合法,迁移只为示例正确性;lint 顺带验证);
- 文档:KEALA-NATIVE-API.md §2.1/§2.3、README、bench fixtures
  (`server-keala.ts` 2 处)、MIGRATION-0.7;
- 风险评估:未匹配中间件的 `for (const k in c.params)` 从不迭代变为
  迭代零次——等价;`=== null` 分支 4 处已盘点;无其他消费者
  (grep 全库核实)。

---

## Fix 4(新增)—— `c.routePath` / `c.routeName`:运行时匹配模式

### 问题

context 里有这次请求的一切事实,唯独没有"**这次请求命中的是哪条
路由模式**"。Hono v4.8 把 `c.req.routePath` 属性弃用、换成 Route
Helper 的 `routePath()`——弃用的是挂载点,**能力本身是生产刚需**:

- **metrics 路径标签**:`metrics()` 今天没有任何路径标签
  (`src/middleware/metrics.ts:77` 只有 `le`)。想加 per-route 指标,
  用 `c.path` 是高基数炸弹(`/users/1`、`/users/2`… 各一个序列);
  用匹配模式做标签是有界的(= 路由表条数)。这是**解锁项**,不是
  修复项;
- **日志/tracing**:span 名应该是路由模板(`/users/:id`)而不是原始
  路径——没有它,APM 面板被动态路径撕碎;
- 全局中间件想知道"下游命中了哪条路由"只能比对 `c.path` 前缀——
  脆弱且无法区分模式。

keala 的 dispatch **本来就持有匹配结果**(`RouteMatch.target`),
不暴露纯属缺口;keala 还有 Hono 没有的命名路由,名字也已在
target 上。

### 方案:两个只读属性,dispatch 匹配处一行赋值

```ts
// 用法(全局 metrics 中间件示例)
app.use(async (c, next) => {
  await next();
  if (c.routePath !== "") bumpCounter(c.routePath, c.res?.status ?? 200);
});

// 类型
c.routePath; // string —— 命中的注册模式,含 mount 前缀,如 "/users/:id"
//           未匹配(404/501 兜底链)为 ""
c.routeName; // string | undefined —— 命中命名路由时的名字,未命名/未匹配 undefined
```

规则符合性:"无键事实→属性",与 `c.params`/`c.path` 同族。

**实现锚点(已核实到行)**:

1. `src/router/trie.ts:26-43` `RouteTarget` 加 `pattern: string` 字段
   ——target 与 pattern 是 1:1(静态桶:canonical key 即路径;动态:
   `indexPattern(state, ir, fullPath)` 的 `fullPath` 在手,
   `router.ts:147`)。**注册期一次字符串引用赋值,零新分配**
   (字符串已存在);`name?: string` 已在(`router.ts:273` 挂上),
   零改动;
2. `src/core/dispatch.ts:312` `c.params = …` 旁加两行
   `c.routePathValue = match.target.pattern;
c.routeNameValue = match.target.name;`——匹配在链执行**之前**
   (`dispatch.ts:310`),所以全局中间件、路由 handler、405 路径
   (`dispatch.ts:334`,命中目标但方法不允许)全部看得到;HEAD→GET
   回落取的就是 GET 模式的 pattern(正确:那就是命中的路由);
3. `src/core/context/context.ts:105` `CONTEXT_DEFAULTS` 加两个槽
   (`routePathValue: ""`、`routeNameValue: undefined`)——
   CONTEXT_SLOT_KEYS 池回收自动覆盖(与 Fix 3 同机制);
4. `c.routePath/c.routeName` getter 挂 request.ts(与 params 同款,
   直读槽位)。

**行为对照**:

| 场景                    | c.routePath                                    | c.routeName |
| ----------------------- | ---------------------------------------------- | ----------- |
| 命中 `/users/:id`(命名) | `"/users/:id"`                                 | 该路由名    |
| 命中 mount 前缀         | 全前缀 `"/api/u/:id"`                          | 同左        |
| 命中目标但 405          | 该模式(有值)                                   | 该路由名    |
| 未匹配(404/501 兜底链)  | `""`                                           | `undefined` |
| 原生 sink(Bun)          | 不适用(无 context)                             | 不适用      |
| ws 升级                 | 与 c.params 同源同位点,params 到得了它就到得了 | 同左        |

**成本**:注册期每路由 +1 字段引用;请求期命中路径 +2 属性写
(与 params 赋值同量级,亚纳秒),未匹配零成本;不在任何已锁性能
度量的噪声内(仍会在 param 场景配对矩阵里复测一遍,见验收)。

**明确不在本项内**:`metrics()` 增加路径标签是后续可选集成
(opt-in `routeLabel: true` 之类),产品决策独立于槽位暴露,
另行裁决;本项只交付地基。

### 影响面

- src:trie.ts(字段)、router.ts 注册点(pattern 赋值)、dispatch.ts
  (+2 行)、context.ts(2 槽)、request.ts(2 getter)、state.ts
  (2 槽声明);
- 测试:新增 6 项(命中/未匹配/405/mount 全前缀/命名路由/池回收后
  槽位复位)+ 表面锁与速查表加两行;
- 文档:KEALA-NATIVE-API.md §2.1/§2.3、README 观测一节、MIGRATION
  (新增项,非破坏);
- 破坏性:无(纯新增)。

---

## 文档同步(纯文档,零代码,随本批一起出)

1. **D13(新):url 语义分歧**——Hono `c.req.url` 是**绝对 URL**
   (`http://localhost:8787/about/me`),keala `c.url` 是相对
   (path+search),绝对形态是 `c.href`/`c.origin`。Hono 迁移者写
   `c.url` 期待绝对的会静默拿到相对串——D 系列补一条,给对照表;
2. **D3 补佐证**:Hono 官方文档自己给 `header()` 无参 record 挂
   ❌/✅ 警告(键全小写,`headerRecord['X-Foo']` 静默 undefined)——
   keala 原生 `c.headers`(大小写不敏感)结构性免疫,写进 D3 作为
   keala 设计的第三方证据;
3. **三则配方**(收进 KEALA-NATIVE-API 附录,替代三个不做的 API):
   - 全量 query 枚举:`c.querystring` 自解析(或 `c.URL.searchParams`);
   - 表单记录化:`for (const [k, v] of formData.entries())` 十行循环
     (Hono `parseBody` 的 `all` 语义);
   - 转发已读请求:`new Request(url, { body: await bodyOf(c).arrayBuffer() })`
     从 memo 值重建(Hono `cloneRawRequest` 的场景);
4. **文档惯例**:陷阱处系统化使用 ❌/✅ 对照块(Hono 文档风格,
   keala 已部分使用)。

---

## 执行顺序与验收(评审通过后)

1. **Fix 1**(bodyOf)→ 测试 3 项新增 + 74 处 cast 迁移;
2. **Fix 2**(c.get 退役)→ src 18 + test 19 迁移 + 表面锁更新 +
   破坏性变更记录;
3. **Fix 3 + Fix 4**(同触 dispatch.ts/context.ts,合并一批)→
   src 迁移 + test 118 处 + 新增 6 项路由模式测试 + fixtures;
4. 文档四件套:CHANGELOG / MIGRATION-0.7 §9(记两条破坏性变更:
   c.get 退役、params 非空)/ KEALA-NATIVE-API(D13 + 附录配方 +
   全文示例迁移)/ README;
5. 全门禁:verify(Node 全套 + coverage ≥90)/ test:bun / build /
   smoke / soak×2 / process:check;
6. 抽查:param 场景双运行时 R4.6 配对矩阵带内(Fix 4 在命中路径
   +2 属性写,预期零位移;若有位移,getter 化兜底);
7. 版本 0.7.2。

## 明确不做(与本方案互补的"不做清单",含 2026-09-05 新裁决)

- **不引入 `c.req` 门面**:补全分桶的收益 < 一跳委托 + 全生态 breaking
  的代价(D2 已裁);
- **不做 app 级泛型**(`new Keala<Ext>`):hono 式方案,破坏扁平
  简洁性;
- **正文机器不进核心运行时**:插件隔离、预算策略、惰性加载纪律保持
  (bodyOf 只补类型携带,不动运行时归属);
- **不动属性/方法规则**:带键→方法、无键→属性,双框架同构,不碰;
- **validator 多目标不在本批**(Hono `valid()` 有 form/json/query/
  header/cookie/param 六目标,keala 只有 body):真 DX 缺口,但
  query/param 全量化要重新面对原型污染面(null-proto + 危险键丢弃)
  与类型流设计——**独立出 0.7.3 方案文档评审后再动**,不搭车;
- **`queryAll()` 全量形态不做**:枚举场景罕见,`c.querystring` 配方
  覆盖;给罕见场景加公共面违反"一页纸"纪律,有真实用例再议;
- **`parseBody({all, dot})` 不做**:`dot` 点号嵌套是原型污染教科书
  (`obj.__proto__.x`),`all` 用配方十行覆盖;keala 目标用户 JSON 为主,
  HTML 表单场景真出现再议(届时放 `keala/middleware`,不进核心);
- **`cloneRawRequest()` 不做**:它存在的原因(validator 消费掉 raw
  body 后还要转发)在 keala 被 memo 化读取结构性消解——同一 reader
  重复读安全,转发用重建配方;
- **`matchedRoutes`/`routeIndex` 不做**:Hono 自己 v4.8 已弃用,
  keala 的 dev-trace 覆盖调试诉求。
