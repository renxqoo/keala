# keala 0.6.2 深度审查报告

- **审查对象**：`aacc945`（0.6.2 分支顶端，66 个 src 文件 / 约 13.5k 行；Bun + Node 双运行时）
- **审查日期**：2026-09-05
- **方法**：6 个并行专项审查（Bug / 性能 / 安全 / 易用性+可扩展性 / 死代码 / 高可用），每个专项要求「红测或测量证据」，主会话对全部 critical/high 发现逐一独立复跑复核。**本阶段未修改任何框架代码**（`git diff` 为空；仅新增未跟踪的复现产物，见 §6）。
- **基线**：`tsc --noEmit` 通过；vitest 全量 **150 文件 / 2326 用例通过、10 跳过**（exit 0）——以下所有发现均建立在全绿基线之上。
- **事件记录**：worktree 最初基于 `origin/main`（051724a，旧树），02:21:18 被切到 `aacc945` 后完成基线重跑与全量审查；所有结论均对当前树验证。

## 0. 总览

| 维度         | critical   | high       | medium      | low      | 合计   |
| ------------ | ---------- | ---------- | ----------- | -------- | ------ |
| 高可用 HA    | 1 (HA-1)   | 2 (HA-2/3) | 1 (HA-4)    | 1 (HA-5) | 5      |
| 性能 PERF    | 1 (PERF-1) | 1 (PERF-2) | 1 (PERF-3)  | 5        | 8      |
| 安全 SEC     | —          | 1 (SEC-1)  | 1 (SEC-2)   | 3        | 5      |
| Bug          | —          | —          | 2 (BUG-1/2) | 4        | 6      |
| 易用性 UX    | —          | 2 (UX-1/2) | 5           | 4        | 11     |
| 可扩展性 EXT | —          | 1 (EXT-1)  | 1 (EXT-2)   | 2        | 4      |
| 死代码 DEAD  | —          | 1 (DEAD-1) | 11          | 16       | 28     |
| **合计**     | **3**      | **7**      | **23**      | **34**   | **67** |

其中 **CONFIRMED 55 条**（红测/端到端/CPU profile 级证据，主会话已独立复核全部 critical/high 与抽查 medium），PLAUSIBLE 12 条（精确代码路径推理，动态复现不可行或属文档化裁决）。

**跨维度关联**（修复时应合并考虑）：

- **HA-1 × PERF-1**：`pooling: true` 同时存在正确性洞（跨请求污染）与净劣化（-11%~-38%）——先修 HA-1，再决定 PERF-1 的回收路径重构是否值得。
- **UX-7 × BUG-1**：同一族「status 校验缺口」——`c.throw(302)` 静默变 500，`app.redirect(…, 306)` 静默变 302，方向相反。
- **HA-2 × PERF-7**：同一根因「早应答后未消费/未断开源 body」在 Node 腿的两个表现（无界缓冲驻留 / 未消费 Response 保留）。
- **SEC-1 × PARITY.md**：双运行时分歧账本不完整（见 SEC-1、SEC-2）。

---

## 1. Critical（3 条）

### HA-1【主会话已独立复核】pooling 下 async 中间件浮动 `next()` 未登记分支 → 跨请求响应体/状态泄漏

- **位置**：`src/core/compose.ts:115-119`（async 分支不 `registerBranch`，对照 :124 同步路径）；`src/core/branches.ts:10-12`；`src/core/context/pool.ts:139-148`
- **机制**：compose 只在「同步 return 前已调 next()」形态登记浮动分支；async handler 调 `next()` 不 await 且自身先 settle 时分支不登记 → `drainBranches` 返回 null → 上下文立即归还池。晚到写入恰好落在该上下文被下一请求**重新取活**的窗口时，prototype 写守卫失效（对象已复活，与新属主写入不可区分）。
- **后果**：受害者请求收到上一请求的响应体（实测 `"A-SECRET-RESPONSE"`）或读到上一用户的 `c.state.user`。Koa 语义下「不 await 的 next()」是合法惯用法，pool.ts 头注释宣称的保障恰在此形态被打破。
- **证据**：`node --experimental-strip-types /tmp/ha-probe-pool.mjs`（3/3 复现）；红测 `npx vitest run test/zz-red-ha-2.test.ts`（2 用例均红）。主会话已复跑：`expected 'A-SECRET-RESPONSE' to be 'VICTIM-RESPONSE'`、`expected 'alice-secret' not to be 'alice-secret'`。
- **方向**：makeLevel 的 async 分支在 `floated !== undefined` 时同样 `registerBranch(c, floated)`；或上下文加代数计数，晚到写入校验代数。

### SEC-1【主会话已独立复核】`app.sink(path, {dir})` Bun 原生腿泄露 dotfile 并跟随 symlink 逃逸根目录，与自身 JS mirror 安全默认分歧

- **位置**：`src/core/sink.ts:223-234`（mirror 用 serveStatic 默认安全策略）、`:357-369`（`{dir}` 原样下发原生表）；`src/adapters/bun.ts:114-116`；分歧未记入 `docs/PARITY.md:77-82`
- **机制**：`{dir}` sink 双轨——JS mirror 继承 `dotfiles:"ignore"` 与 symlink 拒绝（403）；而 `listen()` 默认把 `{dir}` 塞进 Bun 原生路由表，由 Bun 原生静态服务接管。
- **实测（主会话已复跑）**：`GET /assets/.env` → **200 SECRET_DOTFILE**；symlink 文件/目录逃逸 → **200 TOP_SECRET**；同一注册走 JS mirror 则 404/403。
- **场景**：开发者下沉 `{dir:"./public"}`（或项目根）后，Node/测试环境与文档语义都说拒绝，而每个 Bun 生产部署都在原样输出 `.env`、`.git/config`；被投毒的 symlink（受损依赖/构建产物）可读根外任意文件。
- **方向**：`buildNativeRoutes` 拒绝下发 `{dir}`（JS mirror 独占），或注册期对 dir 做 dotfile/symlink 扫描；把两条安全分歧写进 PARITY.md 与 `sink()` 文档。

### PERF-1【主会话复核 content-type 缺陷】pooling 当前实现为净劣化：每请求 +1.44µs CPU，端到端 -11%~-38%

- **位置**：`src/core/context/pool.ts:94-112,139-210`、`src/core/context/context.ts:170-192`
- **数据**（预热 + 9 样本中位数 / 9 轮×5s 交错配对中位数）：CPU 归因（300k 请求 profile）——`sweepForeignKeys`（Reflect.ownKeys 全扫）641ns/请求（29.1%）、`setPrototypeOf`×2 422ns（19.1%）、`clearRequestSlots`（24 槽逐个重赋值）398ns（18.1%）。微基准：sugar 201→1517ns、state 215→1699ns、raw 183→1891ns（放大 7.4~10.3 倍）。e2e：sugar c=1 **-13.0%**、c=200 -10.6%、raw-Response c=1 **-37.8%**。GC 收益不成立：非池化 300k 仅 ~765B/请求垃圾，未池化腿 c=200 仍 190k rps。
- **附带缺陷（主会话已复跑 `bun bench-zz/ct-check.ts`）**：池化 + 手写 `new Response(string)` 在 Bun 上 `content-type: null`（包装流破坏 serve 期 MIME 推断）。
- **方向**：污染位跳过全扫；世代计数替代双 setPrototypeOf；位图化槽重置；commit 期记录 directBody 事实覆盖手写 Response 常见形态。不改则文档明示 pooling 仅极高分配率可能回本。

---

## 2. High（7 条）

### HA-2 Node 适配器：504 早应答后 keep-alive 连接的无计量内存驻留（每连接最多插件上限字节，`inFlight=0`）

- **位置**：`src/adapters/node-source.ts:192-235`、`src/adapters/node.ts:417-419`、根因联动 `src/core/lifecycle-deadline.ts:49-67`
- handler `await bodyOf(c).arrayBuffer()` 挂起时 504 早应答：容量槽即刻释放，但 `cleanupUnread()` 因 `_bodyOwned=true` 直接 return，`#readIncoming` 监听器与 `chunks[]` 闭包继续存活，攻击者在**同一连接**继续滴正文全被缓冲。实测 8 连接 × 7MB：RSS 117→169MB，全程 `inFlight=0`。Bun 侧干净。DoS 放大面（1000 连接 × 8MB × 300s）。
- **方向**：早应答时源仍持有 owned 未完成读取 → 置 `connection: close` 并 flush 后销毁 socket，或对 source 调 `disconnect()`。

### HA-3 Node 适配器：双次 `listen()`/`startNodeServer()` 静默孤儿化第一个服务器，孤儿端口永久答 503

- **位置**：`src/adapters/node.ts:221`（无双启守卫）、`:471`（attachServer 覆写）；对照 `src/core/app.ts:379`（Bun 侧已有守卫）
- Bun 路径二次 listen 抛错（该 bug 修过），Node 路径完全没守卫：第二次覆盖 server-slot，`app.close()` 只停第二个句柄。实测 close() 后第一端口仍 accept 且**永远 503**（draining 恒 true）、进程无法退出；k8s 下就绪探针摘流但优雅关闭永不完成。
- **方向**：`startNodeServer` 入口检查 server-slot 已注册即抛（与 app.listen 对齐）。

### SEC-2 WebSocket 升级游离于 `csrf()` Origin 防护之外——CSWSH 面

- **位置**：`src/middleware/cors.ts:135`、`src/core/registration.ts:94-110`（`wsUpgradeHandler` 无 Origin 校验）
- WS 握手是 GET，`csrf()` 对 SAFE 方法直通；升级处理器从不读 Origin。实测：`Origin: https://evil.example.com` 握手收到 **101** 且 `open` 触发；同源 POST 被 csrf() 正确 403。受害者恶意页面 `new WebSocket("ws://target/chat")` 可劫持已认证 socket。
- **方向**：`app.ws()` 增加 `origin` 选项在升级前校验；至少在 csrf()/ws 文档显著声明缺口。

### PERF-2 serveStatic 每请求 stat + 逐段 lstat 巡检，静态吞吐只有 raw Bun.file 的 54%

- **位置**：`src/middleware/serve-static.ts:139-165`、`src/utils/path-safety.ts:65-76`
- e2e 配对比值中位数 **0.538**（14873 vs 27608 rps，9 轮×5s 交错）；去掉 lstat 巡检回升 ~0.638——symlink 审计约占 10 个百分点，其余来自 stat/etag/mtime/头组装。JS mirror 是可移植默认值，损失落在默认用户头上。
- **方向**：Bun 上无协商头时直接 `new Response(Bun.file(path))`；或干净目录前缀的 lstat 结果缓存（TTL/失效钩子）。

### UX-1 中文 README 仍大面积宣传已退役的 `c.get`（4 处，含会抛错的完整示例）

`README.zh-CN.md:217,242,305,326`。217 行示例运行即 `c.get is not a function`（进错误漏斗变 500）；305/326 迁移表把 koa/hono 写法映射到 `c.get`。英文版已正确（zh 漏改）。**方向**：统一改 `c.header(name)`；CI 抽 README 代码块 typecheck 防漂移。

### UX-2 README/API 参考的旗舰示例无法通过项目自己的严格 tsc

`README.md:144`、`README.zh-CN.md:135`、`docs/KEALA-NATIVE-API.md:85-86`。`c.valid`/`c.state.timingMark`/`Middleware<MyContext>` 全部编译失败（TS2339/TS18046/TS2769，连 `examples/app.ts:83` 都要写 cast）；两份 README 的中间件示例块使用未 import 的 `metrics()`/`rateLimit()`，整块复制即 ReferenceError。**方向**：示例纳入编译验证；validator 加泛型工厂。

### EXT-1 无任何类型化 context 扩展点——decorate/state/中间件作者全被迫写 cast

`src/core/app.ts:306-314`、`src/core/context/context.ts:35` vs `docs/KEALA-NATIVE-API.md:573-584`（D7 承诺「强类型走 decorate」）。`decorate(key: string, value: unknown)` 无泛型、Context 是 type alias 无法 declaration merging、无 `createMiddleware<C>` 工厂——四个自然写法全部编译失败，是与 Hono 对标文档里唯一直接不成立的承诺。**方向**：`decorate<K,V>` + 可合并 ContextExtensions 接口或 Hono 式 `createMiddleware<C>()`；短期 D7 改口并给官方 cast 配方。

---

## 3. Medium（23 条）

### Bug

- **BUG-1**【已复核】`app.redirect()/Router.redirect()` 注册校验收 300-399，但 304/306/309+ 请求时被静默改写成 302（处理器 `c.redirect(target)` 不带 code，`isRedirectStatus` 只认 {300-303,305,307,308}）。`src/core/registration.ts:64-81`、`src/router/group.ts:166-185`。eager 校验注释明言要防"silently coerce to 302"，恰好落回自己的坑。→ 处理器改 `c.redirect(target, code)` 或收窄校验集。
- **BUG-2**【已复核】onError 接管 Response 自带 Set-Cookie 时，中间件已暂存的 Set-Cookie **整组丢弃**（`applyAbsentHeaders` 的 has() 短路），与 builtin 路径的「Set-Cookie 连接」语义和自家文档矛盾。`src/core/error-response.ts:227-247`。错误页丢会话 cookie。→ set-cookie 从短路中豁免（无条件 append）。

### 安全

- **SEC-2**（见 §2）。

### 性能

- **PERF-3** compress() 在「从不压缩」的请求上仍付 ~470ns/请求（`splitHeader` 逐字符拼串解析 accept-encoding + 无条件 `Vary` append 的形态降级），e2e -7.1%。`src/negotiation/accepts.ts:28-88`、`src/middleware/etag.ts:200-231`。→ 无 `;` 快速路径 + 常见 AE 头 memo；Vary 改共享 Headers 形态。

### 高可用

- **HA-4** 挂死的 `app.onShutdown()` handler 使 `close()` 永不 resolve：finish 先清 `escalate` 再 await hooks（无超时），二次 `close({drain:0})` 与信号桥升级路径全部失灵，后续 hook 永不执行。`src/core/lifecycle.ts:260-270,197-218`。→ 每个/整组 hooks 施加上限，超时记日志继续。

### 易用性

- **UX-3** 生命周期/过载/停机整块（`close/onShutdown/isDraining/inFlight/pooling/requestTimeout/trustedHosts/overload/…`）两份 README **零命中**；README 引用的 `docs/MIGRATION-0.7.md` 不随 npm 发布（package.json files 不含 docs/）；Application options 表只列 5/11 个键。
- **UX-4** 英文 README：447 行残留已退役的 `get`；269/270 行整行重复；「Migrating from hono」段落被 `## Error handling` 标题拦腰截断（370 vs 403-404），zh 同病。
- **UX-5** zh README 仍指导 `c.req.json()/text()/formData()`（已被 `bodyOf` 取代，直接照抄是编译错误）——`README.zh-CN.md:197-199,327`。
- **UX-6** 自称「完整 API 参考」的 KEALA-NATIVE-API.md 对约 20 个根导出（compose/direct/NOOP_TAIL、signCookie/unsignCookie/parseCookies、startBunServer、failFastAdmission/queueAdmission、readBodyLimited、escapeHtml、pbkdf2PasswordHasher 等）零覆盖。
- **UX-7** `c.throw(302, "see /new")` 静默变 500、无 Location、连用户消息都消失（`createError` 非 400-599 静默 coerce）。`src/http/errors.ts:92`。→ 非 error-status 大声失败或 dev 警告。

### 可扩展性

- **EXT-2** 公开类型 `Plugin.install(app: unknown)`——第三方插件作者第一步就写 cast（`app.decorate(...)` 即 TS18046）。`src/types.ts:39-42`。→ 改为 `install(app: import("./core/app.ts").Application)`。

### 死代码（未使用导出/类型）

- **DEAD-1** `src/utils/text.ts:14` `escapeHtml` 第二份实现**零引用**（与 helpers/html.ts 逐字符相同，是已移除的 redirect 回退 body 的遗留）。
- **DEAD-2/3** `src/utils/text.ts:39,26` `isStatusText`/`isLatin1` 死导出（消费者 `c.message` 已于 0.7 删除）。
- **DEAD-4** `src/types.ts:27` 死类型 `ResponseInitLike`（全仓 0 引用）。
- **DEAD-5** `src/negotiation/accepts.ts:270,276` `acceptsCharset`/`acceptsLanguage` 从未接入 RequestApi，docstring 还引用不存在的 `ctx.acceptsCharsets()`；仅测试引用。
- **DEAD-6** `src/utils/url.ts:50` `parseHostHeader` 死导出，同等逻辑以私有拷贝存在于 trusted-hosts.ts:12 与 request.ts:83（三份 host:port 剥离）。
- **DEAD-7** `src/index.ts:41` `signCookie`/`unsignCookie` 别名再导出：0 文档 0 使用，仅 export-surface 测试断言存在。
- **DEAD-12** `src/core/context/pool.ts:110` `...(app ? {} : {})` 无操作 spread + 误导注释（app 实际未用）。
- **DEAD-17** `startsWithSegments` 双胞胎定义（middleware-stack.ts:62 与 router.ts:377 逐字符相同）。
- **DEAD-18** 尾斜杠 strip 惯用式 **6 处拷贝**（pattern.ts:25 导出的 normalizePath 无人复用，router.ts:357 私有副本逐字相同，另有 4 处内联变体）。
- **DEAD-19** `buildFromState` 四段式重复的响应构造块（~60 行，差异仅 init 字面量；headers 分支已现 content-type 补默认的漂移面）。`src/core/respond.ts:301-381`。
- **DEAD-20** 「re-pump ReadableStream + 完成回调」骨架三份（pool.ts:187 / lifecycle.ts:164 / respond.ts:198，各 ~25 行，连"Evolving let reader"注释都有两份）。
- **DEAD-21** 限流读流→Uint8Array 循环双份（body-parser.ts:316 与 node-source.ts:237 逐行同构，diff 仅错误构造器）。

---

## 4. Low（34 条，摘要）

**Bug**

- **BUG-3**【已复核】`c.body = <Response>` 通过类型检查（`ResponseBody` 的 `object` 分支）但运行时静默产出 `200 {}`，原 status/headers/body 全丢（`src/core/context/response.ts:144-186`）。→ setter 对 Response 抛 TypeError。
- **BUG-4** 单 handler 路由的 `direct()` 快速链缺 double-next() 守卫（组合链 500、direct 链静默放行，`src/core/compose.ts:152-171`）。
- **BUG-5**（PLAUSIBLE）后注册的静态路由按全方法遮蔽先注册的动态路由：`GET /users/7` 从 200 翻转为 405，无告警（`src/router/router.ts:451-488`）。属设计分歧，供裁决。
- **BUG-6**（PLAUSIBLE，仅 Bun 可达）提交 bodied 204/304 时 sanitize 分支提前 return，跳过 staged 头合并（`src/core/respond.ts:417-419`）。

**性能**

- **PERF-4** JSON 快路径用 record init（175ns）而自注释称 Headers init 快 60ns（115ns）——三处改模块级共享 `Headers`。`src/core/respond.ts:310,334,368`。
- **PERF-5** matchPattern 对「静态+param 同级兄弟」对抗表呈 ≈O(depth²) 回溯（depth 20→2.6µs）；正常表 1000 路由平坦（161ns）。实际风险低。`src/router/trie.ts:138-228`。
- **PERF-6** cookie 解析 640~780ns/请求（`tryDecode` 无 `%` 早退缺失；`trimHeaderWs` 双正则）；Bun `Request.method` 惰性访问器每请求 ≥2 次穿透（38ns）。`src/context/cookies.ts:65-91`。
- **PERF-7** Node/undici 保留未消费 Response（实测 200 万次 `new Response("x")` 2GB OOM）；deadline 僵尸分支丢弃迟到 Response 不消费——高频 504 的 Node 负载累积。`src/core/lifecycle-deadline.ts:44-47`。
- **PERF-8** 基线画像：Bun e2e 为 raw 95.1%、Node 95.6%（健康）；单条 staged 头把糖响应从 3.4ns 拖入 ~250ns init 形态（`/search` 677ns 中 ~380ns 是形态税）。

**安全（均 PLAUSIBLE）**

- **SEC-3** `c.query(name)` 定向扫描对非规范编码键名（`?%70age=1`）不可见——PARITY.md 已声明有意，迁移应用有参数级混淆落差。
- **SEC-4** serveStatic 的 lstat 审计与后续 stat/readFile 之间 TOCTOU 窗口（前提：攻击者已能写目标目录）。
- **SEC-5** basicAuth/bearerAuth realm 只剥 `"` 不处理 `\`，尾反斜杠 realm 产出未闭合 quoted-string。

**易用性**

- **UX-8** 文档小面积漂移一组：不存在的 `runtime.env?` 键、zh 语法错误示例（`"\"`）、API 参考乱码（`/head/inoopst/`）、三处测试统计互相矛盾、zh 结构图列已删除的 `core/emitter`。
- **UX-9** 「notFound 必须返回 Response」的文档与官方示例（状态式）自相矛盾。
- **UX-10** 参数形状（对象 vs 位置）与时间单位（秒 vs 毫秒）在相邻配置混排（`rateLimit({windowMs, retryAfterSeconds})` 同对象两种单位）。
- **UX-11**（PLAUSIBLE）`c.setHeader("X-A", undefined)` 静默丢弃，与全库「大声失败」哲学不一致。

**可扩展性**

- **EXT-3** 唯一运行时 import 环（lifecycle ↔ lifecycle-admission）+ core/app.ts 值依赖 adapters/bun.ts（Bun 适配器焊死在 app 类里，与「核心不绑定运行时」叙述相悖）；类型层 SCC 27 文件全连通。
- **EXT-4**（PLAUSIBLE）validator 在**请求期**首次 `app.decorateLazy("valid")`，违背「decorate 仅安装期」契约，与用户自装饰撞车时每请求 500。

**死代码**

- **DEAD-8** `waiterPoolStats` 调试导出（仅测试引用，建议 `@internal`）。
- **DEAD-9/10/11**（PLAUSIBLE）`ContextWithValid` 仅测试 cast；`ContextWithBody` 是被 bodyOf 取代的旧模式（标 `@deprecated`）；`parseQuery` 框架内部 0 使用（有 2026-09-04 用户保留裁决在案）。
- **DEAD-13** rate-limit 恒真条件：`bucket.resetAt <= now || toDrop > 0` 左操作数不可达（实际纯插入序驱逐，与注释语义有温差）。`src/middleware/rate-limit.ts:78`。
- **DEAD-14** `normalizeOverload` 友好类型检查放在 `Object.keys` 之后，对 null/undefined 不可达。`src/core/lifecycle-admission.ts:333`。
- **DEAD-15** `c.params ?? {}` 死回退（R411 后 params 恒非空）。`src/router/group.ts:179`。
- **DEAD-16** 微冗余防御三处（csrf-token.ts:142 恒假判定、lifecycle.ts:244、body-parser.ts:251 无意义别名）。
- **DEAD-22** bun.ts 首轮 ws 清扫与 `sweepLateSockets` 逐行重复。
- **DEAD-23** "Internal Server Error" 纯文本 500 信封 3 处内联拷贝（error-response.ts 已有共享版）。
- **DEAD-24** 「decodeURIComponent 失败原样返回」三份实现（cookies/pattern/query）。
- **DEAD-25** `dispatchDirect` 的 finish 闭包体与同步内联版 ~30 行逐行相同（有意的 perf 拷贝，需锚注释钉死双写）。
- **DEAD-26** `EMPTY_PARAMS` 冻结哨兵双份定义。
- **DEAD-27** URL authority 提取双实现且已有细微语义分歧（lastIndexOf vs indexOf 定位 userinfo）——正是该文件注释声称要避免的 drift。
- **DEAD-28** serve-static.ts:47 孤儿 doc 注释（描述已内联的 helper）。

**高可用**

- **HA-5** 能力缺口组：默认无请求截止（requestTimeout=0，Bun 侧完全无界）；Node 传输层正文上限默认 MAX_SAFE_INTEGER（与 Bun 128MB 不对称）；`bodyLimit` 只查声明值不校验实际字节；无重试/熔断原语（定位上放中间件层合理，如实记录）。

---

## 5. 验证为安全的面（负结果，供后续审查免重查）

- **路径穿越全家族**（`..%2f`/`%252e`/反斜杠/`%00`/绝对路径/Unicode/空段/Range/dotfile 编码变体）：serve-static 与 Bun 原生 `{dir}` 表（404 面）全部有效拦截。
- **Response statusText CRLF 响应分裂**：undici 构造期拒绝；Bun wire 层丢弃 CRLF 后内容。两运行时都防住。
- **multipart 重复 `boundary=` 绕过 formPartLimit**：解析器与 scanner 一致取第一个，fail-closed。
- **Host 头 `/` 注入路由**：路由用 request-target 不受影响，仅 c.host/c.URL 被污染，cache key 无法碰撞。
- **cache() 无限流捕获**：当前树已有 directBodyResponseValue 身份检查。
- **主干防御**：cookie HMAC + timingSafeEqual、CRLF 校验、原型污染、错误信息收敛、CORS/Vary、body 双重预算、SSE 心跳清理、WS drain 1001、overload 队列断连驱逐、deadline 僵尸收容、pool 128 上限——当前树上全部有效。
- **被测量否掉的性能候选**：validateHeaderValue(3-10ns)、getSearch 拼接(4ns)、handle() Promise 包装(+8ns)、toUpperCase(1-2ns)、路由表规模退化(平坦)、Node 适配器 vs raw node:http(-4.4%)。
- **框架基线**：Bun e2e 为 raw 的 95.1%、Node 95.6%——基线健康。

## 6. 复现材料索引

**全部为未跟踪新文件/脚本，未触碰任何现有文件。审查后清理：`rm -rf test/zz-red-*.test.ts bench-zz/`（/tmp 下的脚本随系统清理）。**

| 类别     | 位置                                                     | 说明                                                                                        |
| -------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Bug 红测 | `test/zz-red-bugs-1..7.test.ts`                          | 137 用例：128 绿（行为锁定探针）、9 红（BUG-1/2/3，主会话已复核）                           |
| HA 红测  | `test/zz-red-ha-2.test.ts`                               | HA-1 跨请求污染（2 红，主会话已复核）                                                       |
| HA 红测  | `test/zz-red-ha-1.test.ts`                               | HA-2/3/4（含内存/孤儿/挂死用例；注意 172 行引用了已退役的 `c.req`，属探针笔误，不影响断言） |
| UX 红测  | `test/zz-red-ux-1/2.test.ts`                             | UX-1/UX-7 行为断言（绿）                                                                    |
| 性能     | `bench-zz/`（server-*/run-e2e/ct-check）                 | e2e 配对基准 + content-type 缺陷检查（主会话已复核）                                        |
| 性能     | `/tmp/zbench/micro1-4.ts、prof-pooled.ts、oom-probe.mjs` | 微基准 / CPU profile / OOM 探针                                                             |
| 安全     | `/tmp/red-sec-3-keala.mjs`（资产重建见脚本头注释）       | SEC-1（主会话已复核）；`/tmp/red-sec-4c-bun.mjs` SEC-2；`/tmp/red-sec-1/2/3-bun.mjs` 负结果 |
| HA 探针  | `/tmp/ha-probe-{pool,zombie,double,shutdown}.mjs`        | HA-1/2/3/4 稳定复现脚本                                                                     |

⚠️ **已知副作用**：红测文件存在期间 `npx tsc --noEmit` 会报 21 个错误（探针的未用变量/已退役 API 引用，全部位于 zz-red-* 内，src 零错误）；`vitest run` 会因故意保留的红色用例失败——删除上述文件即完全恢复。

## 7. 建议修复优先级

1. **立即**：HA-1（数据面跨请求泄漏，pooling 用户）、SEC-1（生产 Bun 部署的 dotfile/symlink 泄露）、HA-3（Node 双启动孤儿）、HA-2（Node 内存驻留 DoS 面）。
2. **随后**：BUG-2（错误页丢会话 cookie）、SEC-2（CSWSH 选项）、BUG-1/UX-7（status 校验族）、BUG-3、HA-4；UX-1/UX-5（zh README 退役 API，误导真实用户）。
3. **规划**：PERF-1（pooling 重构或降级文档）、PERF-2/3、EXT-1/EXT-2（类型化扩展点，与 Hono 对标的硬差距）、UX-2/3/4/6（文档系统性同步）、DEAD-1..7 与重复代码收敛（DEAD-17/18/19/20/21 收益最大）。
4. **裁决类**：BUG-5（静态遮蔽动态是否告警）、SEC-3/SEC-4、HA-5（默认值取向）、DEAD-9/10/11（保留裁决复核）。

---

## 8. 主会话逐条复核记录（2026-09-05，二次独立验证）

对全部 67 项发现逐条重验（不依赖首轮 agent 结论）：动态项亲自复跑红测/探针/基准/tsc，静态项亲自 grep/读码核对。**结论：67/67 成立，0 误报**；发现 3 处轻微不精确（见末尾）。

### 8.1 动态复跑（全部通过）

| 证据           | 命令                                                             | 复跑结果                                                                                                                    |
| -------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Bug 红测       | `vitest run test/zz-red-bugs-1..7`                               | 137 用例 = 128 绿 / 9 红；红色用例精确对应 BUG-1(×5)/BUG-2(×2)/BUG-3(×1)+Router 变体；BUG-4/5 差分探针（绿）复现当前行为 ✓  |
| HA-1           | `node /tmp/ha-probe-pool.mjs` + `vitest run test/zz-red-ha-2`    | `/victim` 收到 `"A-SECRET-RESPONSE"`；state 泄漏用例红 ✓（两轮独立复现）                                                    |
| HA-2           | `node --expose-gc /tmp/ha-probe-zombie.mjs`                      | 8 连接×7MB：RSS 117→169MB（≈打入的 56MB），全程 `inFlight=0` ✓                                                              |
| HA-3           | `node /tmp/ha-probe-double.mjs`                                  | close() 后 8910 端口仍答 `503`、8911 `ECONNREFUSED` ✓                                                                       |
| HA-4           | `node /tmp/ha-probe-shutdown.mjs`                                | close() 挂起、escalation 失灵、第二个 handler 不执行（手动释放前）✓                                                         |
| HA-2/3/4 红测  | `vitest run test/zz-red-ha-1`                                    | 4 红（双启×2/僵尸内存/挂死 close）+ 2 绿 ✓                                                                                  |
| SEC-1          | `bun /tmp/red-sec-3-keala.mjs`（资产本人重建）                   | `/assets/.env`→200 `SECRET_DOTFILE`；symlink 文件/目录逃逸→200 `TOP_SECRET`；JS mirror 404/403 ✓                            |
| SEC-2          | `bun /tmp/red-sec-4c-bun.mjs`                                    | 恶意 Origin 握手 `101 Switching Protocols` + open 触发 ✓                                                                    |
| UX-1/2/7 红测  | `vitest run test/zz-red-ux-1/2`                                  | 5 用例通过（断言当前错误行为）✓                                                                                             |
| 类型红测       | `tsc -p /tmp/ux-type-red`（项目同款 strict 选项）                | 5 错误精确复现：`c.valid`/`c.db` TS2339、`Plugin unknown` TS18046、`c.state.timingMark` TS18046、`Middleware<C>` TS2769 ✓   |
| PERF-1 微基准  | `bun /tmp/zbench/micro2.ts`                                      | 池化 sugar/state/raw 1560/1649/1384ns（未池化 ~200ns，7-10×）✓                                                              |
| PERF-1 e2e     | `node bench-zz/run-e2e.mjs pooling / poolingRaw`（5 轮×5s 交错） | 配对比值中位 1.149（池化 -13.0%）/ 1.613（raw -38.1%）——与首轮 1.150/1.609 几乎逐位一致 ✓                                   |
| PERF-1 ct 缺陷 | `bun bench-zz/ct-check.ts`                                       | 池化+手写 Response → `content-type=null` ✓                                                                                  |
| PERF-2 e2e     | `run-e2e.mjs staticFile`                                         | 配对比值中位 0.557（serveStatic -44.3%）✓                                                                                   |
| PERF-3         | `micro3/micro4` + `run-e2e.mjs compressDecline`                  | 微基准 decline 税 +509ns（781 vs 272ns）、Vary append +197ns ✓；e2e 本轮 -4.1%（噪声 0.90-1.12，弱于首轮 -7.1%，方向一致）△ |
| PERF-4         | `bun /tmp/zbench/micro3.ts`                                      | record init 189ns vs 共享 Headers 127ns（+62ns）✓                                                                           |
| PERF-5         | `micro1/micro2`                                                  | 对抗表 depth 6→18: 328→1039ns（超线性）✓；正常表 10→1000 路由平坦（31→31.7ns 静态）✓                                        |
| PERF-7         | `node --expose-gc /tmp/zbench/oom-probe-light.mjs`（本人轻量版） | 30 万个已丢弃未消费 Response：RSS 52→940MB，**GC 后 944MB 不回落** ✓                                                        |
| 负结果抽测     | micro1/3/4                                                       | toUpperCase 1-2ns、getSearch 4ns、handle() 包装 +4ns ✓                                                                      |

### 8.2 静态核对（grep/读码，全部命中）

- **文档类**：UX-1（zh:217/242/305/326 四处 `c.get(` 精确命中）；UX-3（`onShutdown|isDraining|requestTimeout|trustedHosts` 双 README 0 命中；`files` 不含 docs/）；UX-4（269/270 重复行、370↔403 断头句、447 行 `get` 残留）；UX-5（zh:198-199 `c.req.json()` 等）；UX-6（compose/NOOP_TAIL/signCookie/startBunServer/failFastAdmission/escapeHtml/pbkdf2 七符号在 KEALA-NATIVE-API.md 全部 0 命中）；UX-8（:432 `env?` 假键、zh:211 `"\`、:301 `/head/inoopst/`、「1800+/90 个文件」vs 实际 150 个原有 .test.ts）；UX-9（README:368 "must return a Response" vs examples/app.ts:113-117 状态式）；UX-10（types.ts:136 ms 与 :141 s 相邻混排）。
- **死代码**：DEAD-1..28 逐项核对——DEAD-1（text.ts 版 escapeHtml 0 个 import 者）、DEAD-2/3/4/11（定义行唯一命中）、DEAD-5（request.ts 0 命中）、DEAD-6（stripHostPort/stripPort 两份私有等价 + 孤儿导出）、DEAD-7（仅 index.ts 别名）、DEAD-8（仅 3 个测试文件）、DEAD-9/10（定义+再导出+注释）、DEAD-12（`...(app?{}:{})` 原文）、DEAD-13（break 前置使左操作数不可达，控制流亲证）、DEAD-14（Object.keys 先于类型检查）、DEAD-15（`c.params ?? {}`）、DEAD-16（四处微冗余原文）、DEAD-17（双胞胎逐字符相同）、DEAD-18（8 处变体命中）、DEAD-19（respond.ts 四段构造块本人通读确认）、DEAD-20（lifecycle.ts:164 同骨架）、DEAD-21（两函数仅错误构造器不同）、DEAD-22（首轮清扫与函数体相同）、DEAD-23（3 处 500 信封）、DEAD-24（三份 decode 回退）、DEAD-25（finish 闭包与内联版相同）、DEAD-26（sink.ts:93 与 router.ts 双定义）、DEAD-27（lastIndexOf@/indexOf@ 三处分歧原文）、DEAD-28（孤儿注释原文）。
- **类型/接口**：BUG-3（`ResponseBody` 含 `object` 分支、其上注释自称 "NOT assignable"——types.ts:20-25 原文）；EXT-2（`Plugin.install(app: unknown)` 原文）。
- **代码路径（PLAUSIBLE 项）**：BUG-5（matchRoute staticMap 恒先于 trie + 差分探针）；BUG-6（respond.ts:417 早 return 先于 :423 staged 合并——本人读码确认，仅 Bun 可达）；SEC-3（wireForms 仅 raw/canonical/plus 三形态）；SEC-4（findSymlink 逐段 lstat 后由调用方另行 stat/read——TOCTOU 窗口结构成立）；SEC-5（realm `replaceAll('"',"")` 不处理 `\`）；UX-11（`value === undefined || null` 静默 return，实际在 :77 非 :69）；EXT-3（lifecycle.ts:15 ↔ lifecycle-admission.ts:14 双向值导入 + app.ts:57 值依赖 adapters/bun）；EXT-4（ensureGetter 在请求路径调 decorateLazy 原文）；HA-5（normalizeRequestTimeout undefined→0、node-source.ts:51 `bodyCap = MAX_SAFE_INTEGER`、src 无 circuit/retry 命中）；PERF-6（tryDecode 无 `%` 早退原文；decodeSegment 反而有——对照成立）。
- **首轮 CPU profile 归因（PERF-1 的 29.1%/19.1%/18.1% 与 PERF-8 画像）**：未整段重跑（300k profile 耗时）；其构成原语（Response 构造成本、handle 开销、路由成本）已在本人 micro 复测中独立再现，回归总量已由 e2e 双场景锁定。此项标「首轮测量 + 本人原语级复核」。

### 8.3 复核中发现的轻微不精确（不影响结论）

1. **UX-2 第 (c) 子项**：英文 README 的 import 列表**实际已含** `rateLimit`（仅缺 `metrics`）；中文版确实两者皆缺。首报告对英文侧略有过度表述。
2. **UX-11 行号**：undefined 静默丢弃在 headers.ts:**77**（非 :69，:69 是函数签名行）。实质完全成立。
3. **PERF-3 e2e 量级**：本轮复测 -4.1%（轮间 0.90-1.12 高噪声）vs 首轮 -7.1%。进程内机制（+509ns decline 税）稳定复现，e2e 量级应视为「-4%~-7%，随机器状态波动」。

---

## 9. 变基到最新 0.6.2 后的复核（2026-09-05 04:25）

0.6.2 分支新增两条提交：`97d9fef`（R413 bucket-regex 路由快层）、`1fd7b53`（清理误提交产物）。审查产物已提交为 `review-0.6.2` 分支（= `1fd7b53` + 产物提交，零 src 改动）并在新基线上复验：

- **基线**：`tsc --noEmit` src 零错误（19 个错误全部位于红测探针内）；vitest（排除 zz-red）**2333 通过 / 10 跳过，exit 0**（含新增 router-bucket-regex 测试）。
- **发现存活性**：11 条关键红色用例在新基线**全部仍复现**——BUG-1(×3)/BUG-2/BUG-3/HA-1(×2)/HA-2/HA-3(×2)/HA-4；BUG-4/5 差分探针仍复现当前行为。**两条新提交未修复 67 项中的任何一项**（符合预期：R413 是路由性能工作）。
- **受 R413 影响需更新的测量**（发现本身不变，数字更新）：
  - **PERF-8 基线画像**：matchRoute 动态命中实测 223-253ns → **108-123ns**（10/100/1000 路由三点，约 2× 提速且更平坦）——R413 的快层有效；报告 §4 PERF-8 中「matchRoute 32ns 自时间」等 profile 数字以首轮为准，动态路由成本已显著下降。
  - **PERF-5**：对抗表（静态+param 同级兄弟）**仍超线性**——depth 6/10/14：387/549/858ns（R413 前 328/519/804ns；常数略增、形状不变，对抗形态仍逃出快层走 trie 回溯）。结论维持 CONFIRMED、实际风险 LOW。
- **修复优先级建议（§7）不变**。

---

## 10. 修复状态（2026-09-05 05:2x，分支 fix-0.6.2-review）

6 个并行修复域 + 主会话第二波收尾。全量门禁：oxfmt/oxlint/tsc 绿，**2624 用例全绿**（15 条故意红色用例全部转绿），覆盖率 95.4%/91.1%/96.0%/97.0%（全部门槛之上）。

### 已修复（代码，45 项）

| 发现 | 修复方式 | 验证 |
|---|---|---|
| **HA-1** | compose.ts branchLive 标志：真浮动分支（handler 先 settle、next() 仍在跑）登记；`return next()` 惯用形态不登记（不输掉 retire 竞态） | zz-red-ha-2 2/2 绿 + victim 探针 CLEAN + 8 用例回归 |
| **HA-2** | answer() 检测**在途读取**（_pendingRead）→ `connection: close` + flush 后 disconnect+destroy；主会话修正：仅物化未读（`void c.raw`）不误杀，R4.5 排水契约保持 | zz-red-ha-1 僵尸用例绿（RSS≈0）+ r4-5-runtime-engine 57/57 |
| **HA-3** | startNodeServer 双启守卫（对齐 app.listen 文案） | 探针亲证二次 listen 抛 TypeError |
| **HA-4** | shutdown hooks 每 hook 超时（`shutdownTimeout` 默认 10s、0=无限），超时记日志继续；升级路径保留 | zz-red-ha-1 + agent-ha-fixes 3 用例 |
| **PERF-7** | 僵尸分支对迟到 Response `body.cancel()` | observable-cancel 回归测试 |
| **BUG-1** | redirect 处理器显式传 code（注册意图原样保留，304/306/309+ 不再静默 302） | 5 条红用例转绿 |
| **BUG-2** | applyAbsentHeaders 豁免 set-cookie（staged 无条件 append） | 2 条红用例转绿 |
| **BUG-3** | `c.body = <Response>` 抛 TypeError | 红用例转绿 |
| **BUG-4** | direct() 编译期 guarded tail（含 DIRECT_HANDLER），二次 next() 抛同款错误 | agent-ha-fixes 精确消息断言 |
| **BUG-6** | bodied 204/304 先合并 staged 头再 sanitize | Node 单元 + Bun e2e 10/10 |
| **UX-7** | `c.throw` 对 1xx-3xx 抛 TypeError（createError 兜底保留） | zz-red-ux-2 重写断言绿 |
| **SEC-1** | `assertSunkDirSafe` 扫描-拒绝（dotfile/.well-known 豁免/symlink，10000 项/64 深预算），listen/reload 每次构建原生表前重扫；PARITY.md 记录残余 TOCTOU | 原攻击资产 listen() 拒绝（主会话亲证）+ 24/24 Bun e2e |
| **SEC-2** | `app.ws(path, { origin: string[] | (c)=>boolean })` 升级前校验，缺失 Origin fail-closed 403 | 6 用例含 mount 前缀 |
| **SEC-5** | realm 剥 `"` 与 `\` 两类，剥空构造期报错 | 6 用例 |
| **PERF-2** | serveStatic lean 路径（Bun、GET/HEAD、无协商头）：保留 stat+lstat 正确性，statSync 直读（async stat 23.5µs→1.07µs） | e2e **0.557→0.868**（c=1）/ 0.713（c=64） |
| **PERF-3** | acceptsGzip 三层快速路径（lone-token charCode 零分配 + 64 memo + parser 兜底）+ Vary setHeader 形态 | 门 286→12.7ns；decline 税 670→512ns（进程内）；43 对抗头等价锁 |
| **PERF-4** | JSON_HEADERS 共享实例两处快路径 | 双运行时构造隔离断言 |
| **PERF-6** | tryDecode `%` 早退 + trimHeaderWs charCode | parseCookies Bun 605→341ns / Node 840→325ns |
| **EXT-1** | `ContextExtensions` 空开接口（declare module 合并，穿透 barrel 再导出实测成立）+ `createMiddleware<C>()` 工厂 | 可证伪类型测试（改名即 7 处报错）+ 8/8 |
| **EXT-2** | `Plugin.install(app: Application)`（惰性类型导入） | TS18046 消除 |
| **UX-2a/DEAD-9** | `validOf<T>(c)` 官方访问器 + ContextWithValid @deprecated | 3 用例 |
| **DEAD-1/2/3** | utils/text.ts 的 escapeHtml 副本、isStatusText、isLatin1 删除 | grep 0 残留 |
| **DEAD-4** | ResponseInitLike 删除 | tsc 无隐藏引用 |
| **DEAD-12/13/14/15/16** | 全部清理（rate-limit 裁决为插入序驱逐） | 各域回归 |
| **DEAD-17/18/26** | startsWithSegments 单一定义导出；normalizePath 收敛 4 处；EMPTY_PARAMS 单源 | 133 router 域用例 |
| **DEAD-22/23/25/28** | sweep 复用；500 信封本地去重（core 方向不倒置）；双写锚注释；孤儿注释删除 | 各域回归 |
| **DEAD-6/27** | 零风险方案：三处 host:port 剥离与两处 authority 提取加交叉引用注释（安全边界差异显式化，不做会引入每请求分配的统一） | 注释级 |

### 已修复（文档，14 项）

UX-1/2/3/4/5/6/8/9/10（双 README + API 参考全面对齐，`c.get` 0 残留、底层原语第七部分、生命周期整节、11 键 options 表、断头句/乱码/假键订正）；HA-5（DEPLOY.md 生产清单：requestTimeout/overload 建议、Node-Bun 传输层上限不对称、无内建重试熔断说明、pooling 成本画像）；SEC-3（koa 迁移安全提示）；SEC-4（PARITY + path-safety 威胁模型边界）；PERF-1（无安全微优化空间——sweepForeignKeys 的 own-key 不可拦截、双 setPrototypeOf 即写守卫——pool.ts 头注释如实记录成本画像 + DEPLOY.md 谨慎开启提示）；UX-11（行为被 r4-5-core-contracts/anomalies 锁定，维持静默忽略 + API 参考 §2.2 文档化）；redirect code 口径统一为「任意 3xx 保留」（4 处）。

### 维持裁决 / 待裁决（8 项）

- **SEC-3**、**DEAD-11**：PARITY.md 2026-09-04 用户裁决维持。
- **DEAD-5**：0.7 契约（commit-0-7-contract 锁定移除）维持，docstring 已修。
- **BUG-5**：静态遮蔽动态的设计分歧——建议 dev 警告，未实现，待维护者裁决。
- **DEAD-7/8**：保留（API 参考已补文档/建议 @internal）。
- **PERF-5**：对抗表 O(depth²) 剪枝未做（需应用作者自注册对抗表才触发，正常表平坦）。

### 明确推迟（2 项）

- **DEAD-20/21**（流泵/读循环骨架三份去重）：涉及本轮刚修过的热代码（pool/lifecycle/body-parser/node-source），为避免回归风险推迟到独立轮次。
- **PERF-8**：画像型发现，其构成原语已在 PERF-3/4/6 中改善。

### 修复后基准（同机同口径配对中位数）

| 场景 | 修复前 | 修复后 |
|---|---|---|
| serveStatic vs raw Bun.file（c=1） | 0.557 | **0.868** |
| compress decline 税（进程内） | +670ns | **+512ns**（门 286→12.7ns） |
| parseCookies 4-cookie（Bun/Node） | 605/840ns | **341/325ns** |
| pooling sugar / raw（c=1） | 1.149 / 1.613 | 1.145 / 1.628（HA-1 安全修复零代价） |
