# bun-koa — 审计裁决记录（2026-08-30）

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
