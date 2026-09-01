# HOTPATH-R3 — 路径作用域中间件与有界 body 热路径方案

> 状态：已核销
> 级别：中
> 范围：仅 keala；Tillgate 是只读验证消费者，不修改其代码。

## 契约

### C1 路径作用域 `app.use(pattern, ...middleware)`

- 保留 `app.use(...middlewareOrPlugin)`；新增 Hono 迁移形态
  `app.use("/v1/*", auth, audit)`。
- pattern 只接受绝对静态路径或末尾独立通配段 `/*`：
  - `/health` 只匹配该路径；
  - `/v1/*` 匹配 `/v1`、`/v1/` 与其全部子路径；
  - `/*` 匹配所有路径；
  - 参数、正则、中段通配及非绝对路径在注册期抛 `TypeError`。
- 作用域中间件保持注册顺序，并位于路由/param/handler 之前。晚注册仍会在
  setup 时重编既有路由链。
- 对已注册路由，适用的作用域层在注册期选出并编进唯一洋葱链；作用域外的已命中
  路由不做前缀判断、不进入空壳 middleware。
- 对作用域内的 404、405、OPTIONS、501，作用域中间件仍执行，再由现有 finalizer
  决定结果；这锁定鉴权、审计等安全 middleware 不因路由未命中而绕过。
- plugin 仍只能走无 pattern 的 setup 形态；`app.use(pattern, plugin)` 拒绝，避免把
  setup 生命周期误解释成请求层。
- native sink 只与实际重叠的 scoped middleware 冲突；全局 middleware 仍与任意 sink
  冲突。冲突在双方任一注册顺序下均立即拒绝。

### C2 body 有界读取与并发单次性

- 所有既有字节与 part 限额、安全错误 code、空体语义保持不变。
- declared-length 快路径由 `Request.arrayBuffer()` + view 改为 Bun 1.4 / Node 22
  均提供的 `Request.bytes()`，直接得到 `Uint8Array`，省去 ArrayBuffer 包装视图。
- `bytes/json/text/blob/formData` 缓存“进行中的 Promise”；同类 reader 并发调用只读、
  解码、解析一次，并拿到同一个对象结果或同一个失败终态。
- 不同 reader 仍共享原始 bytes；后来的更小 limit 必须对缓存 bytes 重新复核并 413。
- chunked/无 Content-Length 继续逐块计数，越界 cancel，不能为性能绕开流式预算。

## 问题域

- 处理：消除无关路径的空 middleware 层税；减少 declared JSON 读侧中间对象与
  Promise 层；修复并发 `json()` 双解析/对象不同一；建立可复现前后基准。
- 不处理：Tillgate 源码；框架级自定义错误响应 hook；组合器重写；取消 413 预算；
  任意参数/正则 middleware pattern；HTTP/2 或外部服务压测。

## 并发/一致性预算

- 每个请求最多一次底层 body 消费；每种派生 reader 最多一次解析。
- declared body 内存上界保持 O(body bytes)，不新增整份复制；chunked 合并仍为
  O(n) 时间/O(n) 空间。multipart boundary 扫描继续调用原生线性搜索。
- 已命中且作用域外的路由：相对无 scoped middleware 的请求路径零新增分配、零
  scope 分支；scope 过滤只发生在 setup。
- 未命中路径：一次 segment 解码 + 对预编译 scope 节点做有界查找，不缓存攻击者
  提供的任意 URL，避免无界 Map。

## 拆分

- `src/core/middleware-stack.ts`：scope 编译、注册顺序、已命中路由层选择、404/405
  fallback 链预编译与 sink 重叠判断；只依赖 compose/context 类型。
- `src/router/router.ts`：从“全局 handler 数组”提升为 middleware stack，bind 时选出
  适用层；路由 trie/matcher 算法不改。
- `src/core/app.ts` / `application.ts` / `dispatch.ts` / `sink.ts`：公共 overload、装配、
  mount/sink 生命周期接线。
- `src/plugins/body-parser.ts`：bytes 快路与 Promise memo；安全预算算法不改。

## 实施顺序

1. 记录 main 基线，补 scoped 语义与并发 body 红灯用例。
2. 完成 body Promise memo + `Request.bytes()`，先跑 parser 全回归。
3. 完成 middleware stack 与注册期编译，先跑 app/router/sink 全回归。
4. 同机同脚本、fresh process 多轮测前后中位数；再跑全门禁与只读消费者测试。

## 裁决

- 用户裁决：允许重构/重写最优算法，但不得修改 Tillgate；必须用前后对比验证真实
  性能与 bug 面。
- 默认裁决：先做已被纳秒分解支持的 C1/C2，不重写 compose；同层数对拍已显示
  compose 不是剩余差距主因。
- 默认裁决：不新增错误响应 hook。本轮数据中它只占约 99ns，且错误语义契约远比
  两项主修复更大，独立设计更安全。

## 测试口径

- 契约：精确/通配/root scope；base/子路径/相邻前缀；注册顺序；晚注册；多 handler；
  非法 pattern/plugin；路由命中、404、405、OPTIONS；动态路由；mount。
- 安全：scope 与 native sink 的双向注册顺序、重叠/不重叠矩阵。
- 并发 bug：`Promise.all(json,json)` 同对象且底层只读一次；text/blob/formData 同类
  Promise 并发同终态；畸形 JSON 并发同为 400；不同 reader 小 limit 复核。
- 回归：现有 bodyParser、app、router、sink、Node/Bun 门全跑。
- 性能：fresh process，固定 warmup/采样；main 与分支交替执行，报告 median 与离散；
  body 测完整 facade echo，scope 测三层 legacy path gate 对比注册期 scoped use。

## 验收清单

- [x] C1 外部契约与 404/405 安全语义逐条通过
- [x] C2 限额、并发单次性、错误 code 逐条通过
- [x] scoped 外路径热路零 scope 层，body 指标有可重复提升
- [x] Tillgate 工作树保持 clean，只读测试不产生文件变更
- [x] fmt/typecheck/lint/build/Node test/Bun test/coverage 全部如实报告
- [x] 覆盖率不低于改前基线

## 核销结果（2026-09-01）

### 性能

所有对比均为同机 fresh process，并以 main / branch 的 A-B-B-A 顺序交替，避免把
JIT、温度和系统漂移误记为优化收益。

| 场景                                  |  main 中位数 | branch 中位数 |              改善 |
| ------------------------------------- | -----------: | ------------: | ----------------: |
| 完整 body facade（最终 6 样本）       | 1511.5 ns/op |    1342 ns/op |        **-11.2%** |
| 三层生产形态 path gate（最终 6 样本） |  548.5 ns/op |     388 ns/op |        **-29.3%** |
| 混合普通路由（10 样本）               |  705.5 ns/op |     691 ns/op | **-2.1%**，无回退 |

此前两组独立 A-B-B-A 复验为 body `-9.7%`、`-11.7%`，scope `-31.3%`、
`-32.5%`；收益方向与量级可重复，不依赖单次最好值。

真实 Bun HTTP + autocannon（3 轮 A-B-B-A、每变体 6 样本、100 connections、10
pipelining、2 秒/样本）：

| 场景               | main RPS 中位数 | branch RPS 中位数 |  RPS 改善 | p99             |
| ------------------ | --------------: | ----------------: | --------: | --------------- |
| `/livez` 三层 gate |          48,280 |            49,680 | **+2.9%** | 39.5 ms → 39 ms |
| JSON echo          |         182,784 |           189,728 | **+3.8%** | 8 ms → 8 ms     |

24 次 HTTP 样本均为 0 error / 0 timeout，且压测前逐端点校验状态码和响应体一致。
HTTP 的端到端收益小于进程内纳秒收益，符合 socket/解析/调度固定成本的摊薄规律。

与仓库锁定的 Hono 4.13.5 做 3 轮 A-B-B-A fresh-process 对拍：

| 同语义场景                         | Hono 中位数 | keala 中位数 |        keala 相对结果 |
| ---------------------------------- | ----------: | -----------: | --------------------: |
| 三个 scoped gate 外的 probe        |   460 ns/op |  381.5 ns/op |            **-17.1%** |
| JSON echo                          |  1023 ns/op |   1319 ns/op |            **+28.9%** |
| 裸 `c.text()`                      | 295.5 ns/op |    311 ns/op |             **+5.2%** |
| post-next header + 正确 text/plain |  1022 ns/op |   1030 ns/op | **+0.8%**，IQR 内平价 |

Hono 的 JSON 路径不执行强制字节预算/流式 413；该行不是同安全语义竞争。Hono 的裸
dirty `c.text()` 在 Bun 1.4 会输出 `application/octet-stream`，所以只把显式补齐
text/plain 后的 Hono 数据列为正确性对等项。

### 正确性与质量门

- 新增 20 个集中回归用例，覆盖 exact/wildcard/root scope、注册顺序、动态路由、两层
  mount、404/405/OPTIONS、native sink 重叠矩阵、fallback trie 与并发 body 单次性。
- Node：94 files，1887 passed / 2 skipped；Bun：94 files，1864 passed / 25 skipped。
- `fmt:check`、`typecheck`、`lint`（0 error，只有仓库既有 warning）、`build`、
  `example:check` 全通过。
- 覆盖率由 main 的 statements/branches/functions/lines
  `96.90/91.74/95.63/98.41%` 提升到 `97.06/91.79/95.93/98.47%`。
- Bun 1.4 文本响应重建后退化为 `application/octet-stream` 的既有问题已修复；
  `smoke` 全部通过。实现用私有 Symbol 标记裸 `c.text()` Response，只在重建且没有
  显式 remove/body replacement 时恢复 text/plain，不给普通响应分配 Headers。
- Tillgate 始终只读，最终 `git status --short --branch` 只有分支行，无文件变化。

### 算法与架构裁决

- 命中的静态路由在 setup 时完成 scope 选择并编成单链；作用域外请求没有 scope
  分支或分配。只有无法静态判定的参数路由才保留条件 wrapper。
- fallback 用 segment trie 选择最深 prefix 或 exact chain，查询为 O(path segments)，
  不建立按任意 URL 增长的缓存；在当前路径 scope 契约下达到渐近最优。
- body declared 快路为一次原生 `bytes()` + 一次解码/解析，O(n) 时间、O(n) 必要结果
  空间；Promise memo 消除同 reader 并发重复消费与解析，同时不削弱 413 预算。
- 没有重写 compose：同层数对拍否定了“组合器是主因”的原猜想，继续改它会扩大
  正确性风险，却没有数据支持。
