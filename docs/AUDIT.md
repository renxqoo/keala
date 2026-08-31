# eleu — 审计裁决记录（2026-08-30）

四路子代理并行审计（性能/安全/功能/迁移，全部只读）+ 两项关键结论主 agent 亲手复验。本文件是 DESIGN.md 修订的依据留痕。

## 亲手复验项

1. **Response 实例复用不可行**：同一 Response 发第二个 HTTP 请求 → Bun 1.4.0 返回 500 `ERR_BODY_ALREADY_USED`（string body 同样触发）。推翻原方案 D；改为状态重建式缓存组件。
2. **`server.update()` 不存在**：Bun 实际 API 为 `server.reload()`（`typeof update === "undefined"`）。旧实现 `src/adapters/bun.ts:18` 声明的是虚构 API。
3. `Bun.serve({ routes })` 可用：静态 Response 直出 + `:param` handler 均工作，静态命中不进 fetch（Bun 1.4.0）。

## 性能审计裁决

- 五项结构性税 4.5 项属实；"无单 handler 直调"为误诊（router.ts:201-204 路由级直调已存在），真税是路由作为洋葱层（76~170ns）。
- 杠杆重排（实测）：respond init 路径（110~~170ns，Headers 实例比 record 快 60ns，`Response.json` 省 74ns）＞ 路由层移除 ＞ matchPattern 闭包化（单路由 32.6→3.1ns）＞ 三件套扁平化（仅 10~~25ns，收益被高估）。
- text 门禁与 content-type 语义强耦合：保留 koa 自动 CT 上限 3.03M，裸 Response 3.55M（hono 即裸返，HTTP 层自动补 CT 无空格变体）→ 用户裁决 D1 与 hono 一致。
- 分桶方案共享首段 1000 路由 128x 退化（6142ns vs trie 47.7ns）→ 自动按桶回退 trie（>8 模式）。
- `observeStream` 每流响应 567ns + 背压断裂 → opt-in。
- hono 数字跨口径摆动 ~30%（顺序 2.88M vs ABAB 3.9M）→ 门禁全部改相对比值 + ABAB 纪律。
- 1000 路由优势复测 6.26x（更高 than 4.57x 记录值）。

## 安全审计裁决

- P0：11 条隐性安全契约在"重写"文件中（详见 MIGRATION §3 绑定表）；pooling 转默认 = 跨请求污染（保持 opt-in + guarded）；body 解析默认 128MB DoS（框架默认 1MB/10MB）；koa-parity 归档须先做安全断言普查（redirect 同源/头合并/etag/GHSA/404）。
- P1：responseCache 投毒面（命中条件硬编码）；Bun routes 双语义绕过（bun#37603：literal 按原始字节 vs param 解码；鉴权前缀禁沉 + 对拍；hono serveStatic CVE-2026-29045 前车之鉴）；serveStatic decode→normalize→realpath 顺序；SSE idleTimeout 10s + 背压；cors 凭据/Vary 默认值；trustedHosts。
- P2：501 vs 404 开关；onerror 日志 URL；错误路径保留 set-cookie 的已锁偏差不要"顺手改"。
- 勘误：安全测试实际例数 17/30/25（非 78/69/175），门禁按文件+describe 记账。

## 功能审计裁决

- 原方案覆盖 hono ~40% 功能面。纳入：WebSocket（Bun 原生直通，P2）、validator（Standard Schema，P2）、stream/streamText、c.runtime 注入、路由类型累积（P1 留门）、body-limit/csrf/request-id/timeout。
- Bun 差异化：`routes {dir}` 静态目录（内核 openat2 防穿越）、Bun.file 流式、Bun.hash.wyhash ETag、Bun.password auth 地基、bun --hot、Bun.inspect。
- 砍：JSX 体系（保留 html``/raw 转义协议）、SSG、9 个 adapter、preset、method-override、powered-by、pretty-json、combine、context-storage。
- compress 用 gzipSync 是错的（同步阻塞）→ Bun.gzip + CompressionStream。
- 双模四歧义 → 六条语义规则（DESIGN §4）。
- koa 砍除审查：三件套/router-as-middleware 砍对；ctx.state/throw/assert/cookies 必须保留；decorate 必须有泛型故事。

## 迁移审计裁决

- P0：目录非 git 仓库（已 `git init` 快照 `dd44353`）；四门禁原为红（已修复提交 `502f594`）；性能门禁绝对值失效（改相对比值）；P2"≥600 例"允许净删 389（改 ≥900+150）。
- 测试资产实为 35 文件 1000 例；量化迁移 A87/B590/C200/D32-60（见 MIGRATION §2）。
- body 消费契约与 nativeRoutes 语义上提 P1 设计；matcher 双发射 IR；漏项补入：双运行时裁决（D3）、bench 基建重建、包发布面 1.0.0、PARITY.md 再生。
- 红队账本制 + 写入白名单（仅 test/redteam/）。
- 时间量级：P1 3-5 天、P2 3-5 天、P3 2-4 天、P4 2-3 天。

## 红队第 3 轮加固裁决（2026-08-31，33 缺陷全治本）

- **裁决推翻先例（P2 勘误）**：原 P2 条目"错误路径保留 set-cookie 的已锁偏差不要顺手改"经实测推翻——koa 3.2.1 的错误响应**保留** handler 已 staged 的全部头（本仓原实现是清空，属背离 koa 且挡住安全头覆盖错误页）。改为：错误路径仅剥离 content 描述头（描述失败 body），5xx 消息隐藏与 expose 门不变。
- **cookie 对称编解码**：serializeCookie 值改 `encodeURIComponent` 上线（parse 侧解码不变，即 cookies 包契约）。修复：`%xx` 样值的 round-trip 损坏、签名 cookie HMAC 与校验字符串不一致导致的会话静默丢失；兼容 koa/cookies 包互读。parseCookies 的解码语义未变。
- **协商器对齐 negotiator（实测仲裁）**：pickPreference 改"每个 provided 的质量 = 其最特异匹配范围的 q"（RFC 7231 §5.3.2）；q=0 条目保留供拒绝判定（isIdentityRefused 数值化）；两处旧矩阵期望按 negotiator 实测值修正（B 例 text/html、C 例 zh）。
- **trie 可选参数治理**：可选性从共享节点属性改为专属 `skipNode` 子树（只有声明 optional 的模式可注入）——根除跨路由污染（`/a/:x?/b` 使 `/a/:x/c` 在缺参时可服务）。insertPattern 返回全部终端（可选模式多条 skip/consume 组合共享一个 target）。静态子查找统一规范键空间（含 % 段仅按解码比较）；fastMatch 对含 % 路径让位 trie。
- **csrf 全源比对**：Origin/Referer 与 `c.protocol+c.host` 比完整 origin（scheme 参与）。
- **cache 三面**：主键加请求 authority；`no-cache`/`max-age=0` 响应不入缓存；请求侧 `no-store` 不播种、`no-cache` 绕过命中。
- **ws 与 pooling/sink 契约**：mount 携 ws 进 pooling 父应用拒绝（与 app.ws 同门）；websocket handlers 无条件装配（活表分发，晚注册 ws 生效——优于拒载）；sink 拒绝已消费 body（bodyUsed 为唯一可同步证明的不可重放态；fetch 下一切 body 均表现为流，类型不可判别）。
- **杂项**：redirect Location 编码反斜杠（WHATWG 视作分隔符的开放重定向）；multipart boundary 引号感知解析（复用 contentTypeParameters，堵 part 预算解除武装）；serveStatic 符号链接步进覆盖最终 filePath（目录 index 分支曾绕过）；错误响应保留 secureHeaders/requestId（finally 写入）；message 控制字符改为 statusText 资格制（不炸响应）；group 路径/前缀注册期校验；redirect 目标缺参注册期抛错；mount 后 param 中间件序修正（use > param，@koa/router 实测）；重复参数名 last-wins 统一两层；Node 适配器 OPTIONS * 映射 "/"；createError 未命名状态回退 String(status)；maxAge/expires 校验收紧。
- **性能门禁**：进程内 A/B（以 hono 为对照消除机器漂移）eleu/hono 比值 HEAD 1.014-1.022 → 修复后 1.000-1.004，无回归；1422 Node 门 + 1403 Bun 门全绿；四门（fmt/lint/tsc/vitest）全绿。
