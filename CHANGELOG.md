# Changelog

> 0.6.x 为 pre-1.0 系列:表面可破坏,破坏性变更在 CHANGELOG 逐条记录。

## Unreleased

keala 原生 API 迁移(去 Koa 形态,docs/KEALA-NATIVE-API-MIGRATION.md);
路由快速层整表化;测试目录按功能重组(详见下)。

### 破坏性变更(keala 原生 API)

- **`c.params("id")` 函数式**取代 `c.params["id"]`:路由产物零拷贝直达
  (table 层 exec 数组+offset、trie 层注册期 matchNames 预挂、fast 层复用
  split 数组),`c.paramNames/paramValues/paramOffset` 三槽;重复名三层统一
  latest-wins;`"toString"`/`"__proto__"` 天然 miss。`paramsRecord(names,
values, offset)` 是"要整个 map"的官方适配器(sink 镜像边界同款)。
  实测同窗口 A/B 全形状反超旧实现 3-7ns(mixed 1.10x→1.01-1.04x vs hono,
  两波测量;收口值见迁移文档 P1)。
- **响应即 return**:`c.body =`/`c.status =`(写)/`c.type`/`c.length`/
  `c.etag`/`c.lastModified`/`c.attachment()`/`c.res` 及读侧 getter 全部
  删除。响应唯一形态 = `return c.text/json/html(body, status?, headers?)`
  或 `return Response`;`c.status` 只读保留(观察槽)。有损映射(§2.2):
  type→`setHeader` 完整 MIME、etag→手动引号、attachment→手写
  Content-Disposition。
- **`return c.redirect(url, code?)`**:纯构造器(校验/URL 归一化/外域中和/
  encodeUrl 原样),不再 mutate、不再 throw-on-commit。同名 Location 优先级
  翻转:先行 staged Location 反杀 redirect 目标(§2.3-1 通用规则方向)。
- **etag/compress 重写为 post-next Response 变换**:资格门槛 = 快照身份
  (sugar 产物;手建/流/SSE/native pass-through——新行为锁);304 干净重建
  (无条件清洗收紧 §2.3-2);compress 替换重品牌 + 原文本 memo——任意中间件
  顺序下 tag 恒为压缩前代表;sugar HEAD 视图品牌化(payload memo),HEAD
  条件协商与 GET 对齐。
- 中间件 return 化:cors(403/204)/auth(401×3)/metrics(page)字节等价迁移
  (Node 适配器 wire 含 CT 完全逐字节等价;Bun CT 显式化为 D1 容差改善)。
- 错误漏斗直构 Response 走 finishCommitted(merge+sanitize+HEAD 共用收尾);
  onStreamError 重挂 committed 路径(dispatchDirect 快路径加门)。
- koa 对齐测试退役(parity/koa\* 差分 33 用例删除;9 项唯一行为锁回迁 keala
  原生断言);koa 仅保留 bench 性能对照选手地位。
- **cookie 插件化**:`c.cookies` 从 core 拆为插件协议——
  `app.use(createCookies({ keys }))` 注册期安装(与 bodyParser 同款:无
  位置依赖、首触惰性),`new Keala()` 的 `keys` 构造选项删除(移入插件
  参数)。类型随 import 到达(插件模块 declaration-merge 进
  ContextExtensions,零 declare 样板)。core 闭包 −4.3KB(94.6→90.4KB
  minified),打包形态 tree-shake 生效(此前原型 getter 砍不动);逐文件
  idle 收益 ≈0(cookies 模块边际成本本来就小——如实记录,本拆分的价值
  是结构性的:core 纯度/可摇/类型诚实)。签名+轮换/fail-closed/secure
  派生/400 天上限等语义逐字不变(83 项 cookie 测试零改写断言)。

### 安全加固（中间件审计 M1-M8）

- **secureHeaders 补 CSP 全套**：CSP/CSP-Report-Only/nonce 回调/
  Permissions-Policy/COOP/COEP/CORP/X-XSS-Protection:0/X-DNS-Prefetch-Control
  - 每头 boolean|string 开关（handler 覆写不被 finally 踩掉）+ timing
    finally 补齐（错误页也带 Server-Timing）
- **JWT 中间件（新）**：HS256/384/512 + RS256/384/512 + ES256/384/512
  全 9 算法；alg 白名单 + 算法混淆防护 + exp/nbf/iss/aud + 常数时间比对；
  c.state.jwt 提取；零依赖全 Web Crypto
- **auth 升级**：timingSafeEqual 导出（常数时间比对）；bearerAuth 加
  token 静态选项（自动 timing-safe）；basicAuth 加 username/password
  静态选项；RFC 6750 三路合规（畸形 → 400 error=invalid_request）
- **etag 304 retained headers**：RFC 9110 §15.4.5 的
  Cache-Control/Expires/Vary 等随行（此前丢失导致共享缓存 TTL 错误）
- **compress 强 ETag 转弱**：gzip 后表示变了，强验证子必须 W/ 前缀化
- **cache 并发记账**：并发捕获同 key 不再 double-count totalBytes
- **cache 命中可变换**：外层 etag/compress 现在对命中响应照常工作
  （brand + memo），热门缓存路径恢复 gzip 和 304
- **cors origin 函数 + ACRH 反射**；**csrf allow 豁免钩子**；
  **rateLimit hit() 原子接口**；**serve-static precompressed + 钩子**
- **metrics 首套单元测试**（19 条——此前零覆盖）

### 新中间件 N1-N7（企业刚需 + 生产运维）

- **combine**：`some(mwA, mwB)` 多认证取其一（拒绝继续尝试，放行短路）、
  `all(...)` 全过——解锁 `some(bearerAuth, apiKeyAuth)` 组合模式
- **apiKeyAuth**：X-API-Key 认证——静态 keys 列表 timing-safe 或 verify
  回调；RFC 6750 三路（缺头 401/畸形 400/验拒 401）；header 名可配
- **webhook 验签**：Stripe/GitHub/Slack/raw 四模式 HMAC-SHA256——
  timing-safe MAC 比对、时间戳容差窗口（默认 300s）、body clone 保护
  （验签后 handler 仍可读）、Stripe 多密钥轮换
- **ipRestriction**：IPv4/IPv6 CIDR 白名单/黑名单——deny 优先、
  `0.0.0.0/0` 全放、IPv6 压缩地址、纯位运算零依赖、畸形规则 setup 期
  TypeError、客户端地址不可解析 fail-closed
- **jwks**：JWKS 远程密钥——kid 索引、TTL 缓存（默认 5min）、
  stale-serving（网络失败用旧缓存）、kid 风暴退避（恶意 kid 不放大
  IdP fetch）、RSA+EC 密钥导入、单飞 refresh
- **healthCheck**：自动注册 /healthz（liveness 永远 200，不查依赖
  防级联重启）+ /readyz（异步谓词决定 200/503，抛错 503 只带 err.name）
- **logger JSON 格式**：`logger({ format: "json", fields: {...} })`——
  输出 {ts, method, path, status, duration_ms, request_id, ...fields}，
  接 ELK/Datadog；text 格式逐字节不变

### 性能

- **整表单 regex 快速层**(router):R413 的 per-bucket regex 升级为
  整表编译——全部 eligible 动态模式进一个 anchored alternation
  (exact 按 trie 优先级排序在前、通配兜底在后),动态匹配省掉首段
  slice 分配、buckets Map 查找、slash 计数与 byCount 二级查找。
  fastDynamic/bucket.fast 合并为 fastIndex 切片数组(≤8 桶启用,宽表
  走整表 regex 防线性 startsWith 退化);通配兜底纯度规则从桶级改为
  首段级。路由隔离实测(Mac / Linux 服务器,vs hono RegExpRouter):
  4 段参数 2.05x/1.94x → **0.90x/0.95x**,mixed 2.23x/1.93x →
  1.09x/1.11x,wildcard 1.94x/1.91x → 1.29x/1.26x;适配层(完整
  serve 路径)全形状 ≥ hono。剩余差为 params Record 构造(公开契约,
  见 docs/SHOOTOUT-LINUX-SERVER-DIAGNOSIS.md 的分层归因)。
- 链装配抽出 `router/chains.ts`,router.ts 521→460 行(修复先在的
  oxlint max-lines 违规)。

### 内部

测试目录整理:按"被测功能"而非"评审轮次"组织(零测试丢失,2658 项与
coverage 95.41/91.06/96.36/97.07 与整理前逐项一致)。

- `test/` 根目录只保留 7 个分类目录:`unit/`(按 src 模块)、`middleware/`
  (每中间件一文件)、`integration/`(生命周期/适配器/sink/commit 契约)、
  `security/`(红队与审计,按攻击面)、`parity/`(koa/hono 对齐)、
  `property/`(属性测试 + `.mts` rig)、`perf/`(时序敏感围栏,独立不合并)。
  171 个轮次命名文件(`agent-r46-`/`redteam-`/`zz-red-`/`coverage-gaps-` 前缀等)
  → 162 个功能命名文件,全部 ≤500 行(oxlint max-lines 门禁)。
- 5 个超限大文件按语义拆分:`agent-r46-review-contract`(1200 行)→
  contracts-{close,admission,deadline,strategy};`agent-r46-review-bugs`(824)→
  review-{signals,adapters};`agent-r46-review-security`(946)→
  admission-review-{rejection,queue,drain};`agent-r46-review-perf`(863)与
  `agent-r46-review-ha`(697)同理。
- 合并规则:顶层 hooks(beforeAll/afterAll)的文件独立成文件不并入他文件,
  避免 hook 泄漏或掩盖;合并最小单位为 describe 块;轮次出处保留在
  describe 标题内。`.mts` rig、`signal-child.ts`、`.deps.d.ts` 随消费方迁移。
- `docs/*.md` 中指向旧测试路径的引用为历史时间点记录,保持原样。

## 0.7.3 (2026-09-05)

R413 动态路由快速层(route-shootout 诊断 → 修复,docs/R412-SHOOTOUT-DIFF-DIAGNOSIS.md
的候选 1+3 实施)。

### 性能

- **bucket-regex 快速层**(`src/router/bucket-regex.ts` + `match.ts`):
  共享基数的多路由桶(`/event/:id` ×3)与参数后静态尾
  (`/map/:x/events`)此前必然落到全 trie 走访(106-130ns/匹配,
  4-5 个临时对象);现在按首段桶把全部合格模式(首段静态 + 纯静态/
  必选无约束参数段)编译成**按段数分组**的锚定 alternation——数斜杠
  选组、单次小 regex 执行、命名组直取,零 splitSegments/Frame/
  ParamLink 分配。**尾部通配**(`/static/*`)编译为桶的独立兜底组
  (`/(.*)`):仅当计数组未命中才执行,严格复刻 trie"通配最低优先"
  的次序,且只在**纯桶**(桶内全部动态模式都已编译)启用——混合桶
  的计数组未命中可能是未编译可选/约束模式的 trie 命中,兜底会让
  通配错误抢先。trie 仍是语义参照与最终兜底(转义路径、可选参数、
  正则约束、参数开头),差分测试逐路径锁死两层恒等。
- **URL 预填单趟化**:`splitPathSearch` 一趟产出 path+search
  (原 getPath+getSearch 两趟)。
- 实测(route-shootout 诊断口径,Bun):
  - 路由器隔离:动态形状 106-130ns → 92-104ns(hono regex 40-51ns);
  - **进程内全管线:动态形状 1.49-1.79x 慢 → 1.09-1.14x 快**(静态
    0.95x)——路由差距被吸收后,keala 的 context/dispatch 机器反而
    快 ~50ns/请求;
  - HTTP 层(autocannon ABAB 安静窗口):mixed 0.97→**1.00x**、
    4-seg 0.98→**1.01x**,且 keala 轮间方差显著收紧(首枪凹陷基本
    消失——每请求分配消失的 GC 红利)。
- **尾部通配进快速层**(后续补丁):`/static/*` 编译为桶的独立兜底组
  (`/(.*)`),仅计数组未命中才执行;安静窗口 HTTP 1.00x(231.0k vs
  231.6k)。两个新增语义边界由锁固化:尾斜杠归一(trie 先剥一个尾
  `/`,通配捕获不含尾斜杠——随机表差分抓获 33 例)、纯桶门(混合桶
  禁用兜底,否则通配遮蔽未编译的可选/约束模式——agent-r5 优先级锁
  抓获);
- **同步结算跳过期限竞赛**(app.ts):同步返回的 Response 不可能
  挂起,`requestTimeout` 配置下也不再 arm/clear 计时器与竞赛闭包
  (每同步请求省 ~5 个分配;异步路径 1:1:1 计时器契约不变,
  REVIEW-PERF-3 栅栏按新契约更新);
- CPU 归位:mixed 场景路由自耗时 54%(splitSegments 20%)→ 41%,
  Response 构造成为第一大头(26%)。

### 内存定性(Bun 腿 steady/peak 比 hono 高 ~11MB,未关闭)

实验排除了三个假设:JS 存量堆(heapUsed 差仅 0.3MB)、期限竞赛
(requestTimeout 默认 0,基准本就未跑;同步跳过后差距不变)、context
分配(pooling 只收回 2.3MB)。idle RSS 持平(27.0 vs 27.4MB),负载
下双方都因 Bun HTTP 栈增长 ~+19MB,keala 的额外 ~11MB 是分配器
arena 随分配率(每请求字符串/Response churn)的增长——soak 证实有界、
非泄漏。Bun 无分配位点采样 profiler,精确归因待工具;候选方向是继续
压每请求分配字节(planned-response 头部复用等)。

### 正确性(快速层五个边界,全部由测试锁死)

- 通配段不得进 regex 层(wildcard 的 optional:false/pattern:null 会
  滑过字段检查,被编译成单段捕获并抢优先——红队随机表差分当场抓获);
- 纯静态模式空泛合格(零捕获组的 groupStart 指向邻路由的组,命中
  扫描错认——同一次红队差分抓获);
- **尾斜杠归一**:trie 先剥一个尾 `/` 再切分,通配捕获不含尾斜杠
  (随机表差分抓到 33 例 `wildcard:"a/b/"` vs `"a/b"`);现在匹配前
  同样归一,空捕获(`/static/` → `""`)落回 trie 的尾斜杠闸;
- **纯桶门**:混合桶(含未编译的可选/约束模式)禁用通配兜底,
  否则计数组未命中时通配抢在 trie 的可选/约束模式之前命中
  (agent-r5 优先级锁当场抓获 `/a/:x?` 被 `/a/*` 遮蔽);
- alternation 排序:首分歧按 static > param > wildcard 秩
  (= trie DFS 弹栈序)+ 静态字面量多者先的 fail-fast 次级键
  (后缀差异对永不共匹配,语义不变)。

### 内部

- router.ts 拆出 `match.ts`(请求侧匹配器,行数预算);
- RouterState 新增 regexIndex/mutations(注册期收集合格模式 + 失效
  纪元),编译产物 memo 在 Bucket 对象上(免二次 Map 查找);
- matchRoute 的 `%` 扫描从两次并为一次。

回归锁:test/router-bucket-regex.test.ts(7 项:差分/覆盖/优先级/
迟到注册/routePath 交互/转义旁路/405)+ 既有 300×200 红队随机表
差分继续全绿。

## 0.7.2 (2026-09-05)

R411 API 人体工学四项(docs/R411-API-ERGONOMICS-PLAN.md v2,含 Hono
官方 Request API 文档全景评审结论)。零兼容层:旧形态全部删除。

### 破坏性变更(0.7.2)

- **`c.get(name)` 退役** → `c.header(name)`。读请求头单入口,与写侧
  `c.setHeader` 严格对偶(0.7.0 只改了写侧,读侧 koa 别名漏了)。TS
  编译期抓出全部调用点。
- **`c.params` 永不为 null**。handler 只在路由匹配后运行——`c.params["id"]`
  与 `const { id } = c.params` 直接写,不再需要可选链;未匹配路由的
  中间件读冻结空对象(EMPTY_PARAMS),可选链读取行为逐字节不变,
  显式 `=== null` 判断需迁移。路由器内部 `matchRoute` 的可空返回值
  不变。

### 新增

- **`bodyOf(c)`**:类型化正文访问器——`await bodyOf(c).json()` 取代
  `(c as ContextWithBody).req.json()` cast(库内唯一 cast);未装
  bodyParser 插件时抛带修复指引的 TypeError(替代无指引的
  `undefined.req` 崩溃)。根入口与 `keala/middleware` 均可导入。
- **`c.routePath` / `c.routeName`**:本次请求命中的注册模式(含 mount
  前缀)与命名路由名;未匹配为 `""`/`undefined`。观测地基——metrics
  标签/span 名用有界模式而非高基数路径;与 params 同族直读槽位,
  注册期一次 pattern 引用赋值(RouteTarget.pattern),请求期命中路径
  +2 属性写,405 路径同样有值。

### 文档

- KEALA-NATIVE-API.md:D13(url 语义分歧:Hono 绝对 vs keala 相对)、
  D14(Hono 三能力配方替代表)、D3 补官方 header() record 小写陷阱
  佐证、§6.1b R411 裁决记录;修正 §3.2 命名路由示例的实参顺序
  (name 在前)。
- MIGRATION-0.7.md §10:两条破坏性变更的迁移写法。

回归锁:test/r411-api-ergonomics.test.ts(10 项:bodyOf 3、params
非空 1、routePath/routeName 6)。

## 0.7.1 (2026-09-04)

R4.10 全面审计修复:四路深读子代理(Node adapter / 生命周期与 ws /
body-static-cache-stream 数据面 / 0.7 提交契约红测)+ CPU profile 归因,
11 项发现全部主会话亲自复现后修复,零误报。

### 正确性(0 bug)

- **提交契约**:提交后 APPEND 并入暂存记录条目(此前被记录合并抹掉,
  静默丢 Vary——缓存投毒面);错误漏斗收割已提交 Response 的头再重建
  (sugar 提交后外层抛错不再丢防护头/cookie,与手建 Response 对称);
  content-describing 头(content-type/length/transfer-encoding/
  content-encoding)不参与镜像重放(不再以陈旧类型/长度覆盖新提交)。
- **responseCache**:只捕获框架快照体——流式提交体在洋葱内消费会死锁
  (无限流永不结算)或双缓冲;无 CT 的手建字节体重放以 U+FFFD 损坏。
  新增 maxBytes(64MiB)/maxEntryBytes(4MiB)字节预算(旧条目数预算
  140×4MB 页驻留 864MB)。
- **Node adapter**:重发已消费的 Response 统一大声——带框架的 500(与
  Bun 一致);旧降级分支发**无框架**响应并杀死 keep-alive 连接、丢弃
  管线化后续请求(wire 实证,违反 R4.5 不变量)。
- **准入**:策略 admit() 后拒绝/抛错/垃圾返回全部经 refuse() 归还槽位
  (此前永久漏槽,流量永久 503、close 拖满排水窗);maxConcurrency 成为
  硬上限(迟到的异步 null 不再超订)。

### 高可用

- **ws 排水**:排水扫描后完成的升级在 finish() 时补扫关闭(此前进程
  挂死、3× SIGTERM 无效);close 完成后的信号直接硬停服务器(不再被
  幂等吞掉)。
- **`app.onShutdown(handler)`**(新):排空后、close() resolve 前按注册
  顺序运行一次;失败包容并记录;thenable 会被 await。
- **Node 选项对齐**:`idleTimeout`(秒→keepAliveTimeout 毫秒)、
  `maxRequestBodySize`(传输级硬上限,插件更宽松限制不能重开);Bun-only
  键给出迁移指引。管线化不再触发 MaxListenersExceededWarning(每 socket
  一个共享 close 监听)。
- **stream/streamText** 关闭 Bun idleTimeout(稀疏流 10s 被杀);
  **serveStatic** dotfiles 默认忽略(.well-known 除外)、Node HEAD 免全量
  读、Node Range 206;**Node soak 腿**(scripts/soak-node.ts)补齐——
  12 轮 × 10k 请求,漂移 ≤30B/req。

### 性能(全部带前后测量)

- **etag() 30k 行 JSON**:Node +3.94ms→+0.11ms,Bun +0.98ms→+0.05ms
  (每请求单次序列化 memo:Bun wyhash 直吃 string、Node 走 lazy
  node:zlib crc32、无原生模块时字级 FNV 兜底;finalizer 非原生对象路径
  改用 memo 文本构造,不再让 undici Response.json 二次 stringify)。
- urlencoded 部件计数 10.6ms→0.17ms(原生 indexOf);
  `writeHeaders` forEach 化 + getSetCookie 门控(~72ns/req);
  `wireForms` 有界 memo(修复过程中一度丢失 encoded 形态,被规范化
  编码污染测试当场抓住——已修)。

### 其他行为变化

- cookies:`Path` 默认 `/`(cookies 包/koa 语义);值校验放宽到仅拒
  CR/LF/NUL/C0(编码器本可安全处理空格/引号/逗号/分号/非 ASCII)。
- `c.req.arrayBuffer()/blob()` 预算归属 jsonLimit→formLimit。
- ETag 算法变更(wyhash string 道/crc32 道)——按部署整体失效,属正确
  行为;CI 的 oxfmt 生成物误报已修(.oxfmtrc 忽略 bench 结果)。

回归锁:test/audit-r410-{contract,cache,node-adapter,lifecycle}.test.ts
(30 项,全部从复现探针移植);全套 2317 测试绿。

## 0.7.0 (2026-09-04)

keala 原生 API:去 koa 化定稿(设计文档 docs/KEALA-NATIVE-API.md,
迁移指南 docs/MIGRATION-0.7.md)。目标是"一页纸可记住"的 API +
更少的 finalize 机器。

### 破坏性变更(0.7.0)

- **提交契约**:Response 提交后,`c.body/c.status/c.redirect` 写入抛
  `TypeError`(要替换正文,构造并返回新 Response);头部写入
  (`c.setHeader/append/remove/type/length/etag/lastModified/attachment`)
  直接写进已提交 Response 的 Headers(与 Hono post-`next()` 语义一致,
  rule-4 重建机器整体删除)。提交后 SET/REMOVE 幂等重放到更新的提交与
  错误漏斗;APPEND/Set-Cookie 直 SET 只作用于当时 Response。
- **`c.set` → `c.setHeader`**(消与 Hono 的同名陷阱;读侧
  `c.header/get` 不变)。
- **请求不可变**:`set url/path/search/querystring` 删除(写入抛
  TypeError);五写入器失效矩阵整条删除。
- **redirect 空体**:`c.redirect(url, code?)`,显式码须 3xx 整数
  (TypeError),Location-only(koa "Redirecting to X." 体删除);
  已 staged 的 3xx 保留。
- **405/501 空体**:Allow 头保留,koa 状态文案体删除(OPTIONS 200
  空体不变;`c.status=4xx` 无 body 回填文案的自有契约不变)。
- **删除 16 项 koa 语义 API**:`c.message`(get/set)、`c.fresh`、
  `c.stale`、`c.vary`、`c.back()`/`c.redirect("back")`、`c.subdomains`、
  `c.ips`、`c.hostname`、`c.charset`、`c.reqType`、`c.acceptsCharsets`、
  `c.acceptsLanguages`、`c.toJSON()`、`c.headerSent`、`c.originalUrl`、
  `c.body = <Response>`。逐项替代见 docs/MIGRATION-0.7.md §5。
- 删除导出:`FLAG_COMMITTED_*` 旗标、`src/core/committed-headers.ts`
  模块;`ResponseBody` 联合移除 `Response` 成员。

### 内部

- respond.ts 约 −40%(rebuildCommitted/flag 合并矩阵/405 体);
  committed-headers.ts(三态守卫探测)整文件删除;
  `messageValue/removedValue/implicitTextResponseValue` 槽位删除。
- keala 中间件全套适配(cors 的 Vary 合并、secureHeaders 的 finally
  防护头经镜像重放、late cookies 经暂存记录连接)。
- 契约测试:test/commit-0-7-contract.test.ts(请求只读、提交契约、
  405/501 空体、context 公共面 = §8 速查表)。

## 0.6.2 (2026-09-04)

生产可用(GA)。相对 0.6.1 的完整变更叙事;测量结论以仓库
docs/HOTPATH-R4.* 与 docs/bench/*.jsonl 原始数据为准。

### 破坏性变更(0.6.2)

- **`c.query` 从 koa 全量 Map 改为定向读方法**(用户裁决 2026-09-04):
  `c.query.name` → `c.query("name")`;重复键 `c.queries("name")`;
  `c.query = {...}` 赋值移除(用 `c.querystring = "..."`);全量枚举移除
  (用 `c.querystring`)。`__proto__` 等危险键的丢弃逻辑随 Map 退役——
  定向读返回字符串,原型污染结构性不可能。动机与语义边界见
  README 与 docs/PARITY.md(0.6.2 targeted query reads 条目)。
- 版本叙事修正:1.0.0 → 0.6.2(pre-1.0 语义,仅一个使用方)。

### 生命周期与过载控制(高可用)

- `app.close({ drain })` 优雅停机:停接 → 排空在途或超时 → 强停,
  返回 `CloseStatus { timedOut, inFlight }`;幂等;`drain: 0` 立即强停。
- `app.isDraining()` / `app.inFlight`(readiness 翻转与观测)。
- `listen({ signals: true })` SIGTERM/SIGINT 信号桥:首信号 drain,
  再信号强停(桥为永久监听器)。
- `new Keala({ overload: { maxConcurrency, maxQueue, queueTimeoutMs,
retryAfterSeconds, handler, strategy } })`:过载准入在 Context 创建
  之前拒绝(默认 fail-fast 503);可插拔策略(`failFastAdmission` /
  `queueAdmission`)。
- `requestTimeout`(期限到点 `c.signal` 以 TimeoutError abort,504 走
  错误漏斗,僵尸迟到结算静默收容)。
- `c.signal`:客户端断开 ∨ 期限的协作式取消,lazy 物化。
- 行为规则、事件时序契约与三轮红队评审见
  docs/HOTPATH-R4-6-LIFECYCLE-*.md。

### 原生路由表下沉(R4.8)

- `app.sink(path, handler)` 函数下沉:handler 收
  `(request, params)` 返回 Response,无中间件/Context/sugar——Bun 侧
  绕过整个 fetch 路径(实测热路由 +7.4% RPS);静态下沉 +10.9%。
- `noOpFor(fn, { methods?, bodyless? })` 中间件透明性声明:声明层允许
  与下沉共存(镜像照常运行,原生表跳过);`bodyLimit` 为内置试点。
- 错误契约:函数下沉与 `app.onError()` 双向拒绝(映射器契约基于
  Context);下沉失败走内置 funnel(exposed 4xx/隐藏 5xx)。
- 下沉是 Bun 原生优化:Node 无原生表,镜像路径较慢,Node 部署不应
  对热路由启用下沉(README/PARITY 已警示)。
- 参数遮蔽/作用域守卫加固(patternsOverlap);对拍差分套件
  (test/native-sink-parity.test.ts + smoke 腿)与分歧台账(PARITY.md)。

### 性能(R4.5–R4.8 系列结论)

- 收官口径(用户裁决):全场景 ≥ Hono + 指定热路由经下沉 ≥10%。
- Bun:六场景全部 ≥ Hono(+0.9~+5.3%),下沉热路由 +6.8%/+9.6%;
  Node:probe/text +10%,middleware +70%,json-body-safe +24%。
- query 场景缺口修复(此前唯一真实落后形态,0.91/0.93 → 修复)。
- pooling 修复与结论:消费包裹缺陷已修(content-type 丢失 + 双运行时
  4.2x/2.4x 塌方),但 pooling 仍为一致净退化(−20~−49pp)——维持
  opt-in,面向分配敏感嵌入场景,不作性能特性(见
  docs/HOTPATH-R4-7-POOLING-AB.md)。

### 可观测与限流(1.0 新增)

- `rateLimit()`:固定窗口 per-key 限流(默认按 `c.ip`),429 +
  Retry-After,可选 RateLimit-* 头与共享 store(多进程部署);
  与 overload 准入分工——后者保护服务器容量(pre-context),
  rateLimit 保护路由公平性(洋葱内)。
- `metrics()`:零依赖请求计数(状态类)+ in-flight gauge + 时延
  分桶,Prometheus 文本 exposition;同步抛错与异步拒绝都按
  HttpError 状态归因。

### 生产硬化(1.0 新增)

- `trustedHosts` 白名单(DESIGN §7.2):伪造 Host 在路由前 403,
  防 origin/href/back 中毒;精确名 + 单标签 `*.suffix` 通配,
  端口不参与比较。
- `unknownMethodAs404`(DESIGN §7.3):非 RFC 9110 文法的未知方法
  从 501 改答 404(opt-in)。
- listen() 配置加固:未知键大声拒绝、数值范围校验、二次 listen
  拒绝;`Runtime.env` 死面移除。
- Node 适配器:onServeError 透出(与 Bun 同契约)、500 类传输/
  写入失败走 console fallback(test 环境静默)。
- Node sink 静态镜像快路径:−35.1% → −13.5%(planned 直写);
  部署文档(docs/DEPLOY.md)与 CI(GitHub Actions)落地。

### 其余变更

- 适配层:Bun fetch 每请求载体与 Promise 包裹移除(R4.7 切片 1)。
- Node 失败信封:头清洗 + 精确 content-length;适配器已发送过的
  Response 复用降级(头保留、body 描述头剥离、空 body)。
- 测试:2341 用例(Node 2332 pass / Bun 2284 pass),含生命周期
  三轮评审、对拍差分、属性栅栏;coverage 97.26/92.52/96.51/98.85。
- 已知限制与分歧台账:docs/PARITY.md(静态 ETag/304、U+FFFD、
  bun#37603 原始字节匹配自愈、maxRequestBodySize 不约束表内路由等)。

### GA 验收(v0.6.2 标签)

- 全门禁绿:Node 143 文件 2349 pass、Bun 143 文件全绿、coverage
  97.12/92.14/96.38/98.69、build(跨平台)/smoke/soak/example:check/
  process:check 通过;npm pack 130 文件、exports 全解析。
- 性能收官口径(用户裁决 2026-09-03):全场景 ≥ Hono + 指定热路由
  经下沉 ≥10%。当前实测:Bun 六场景 +0.9~+5.3%(text 下沉后 +9.6%)、
  Node probe/text +10%、middleware +67%、json-body-safe +15~24%;
  query 场景为已文档化的路由形状残差(Bun ≈0.94 / Node ≈0.86-0.90;
  0.6.2 定向读消除了 ~111ns 建表成本但场景差距未收窄——残差在参数+
  查询路由的整体形状,不在解析本身)。
- 发布:tag v0.6.2;publish 由维护者执行(prepublishOnly 自动构建)。

## 0.6.1

R4.5 运行时引擎线的中途快照(详见 git 历史与 docs/HOTPATH-R4-*.md)。
