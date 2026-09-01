# HOTPATH-R4.4 — 探针与安全 JSON 核心热路径迁移单元

> 状态：设计/审计/测试计划已定稿；实施中
> 分支：`codex/hotpath-r4-4-core-rewrite`
> 范围：仅 keala；Tillgate 只读验证，不修改其源码、测试或生成物。

## 1. 目标与非目标

本单元解决两个仍可复现的固定成本：生产形态的全局 `app.use` 洋葱链探针，以及强制
413 预算的 JSON reader。目标是在相同响应、洋葱、错误、内存和 body 安全语义下缩短
热路径；允许内部重写，不以兼容层或公开开关维持双实现。

明确不做：不改错误 mapper/错误漏斗安全守卫，不重写已在 R4.2 证明优势的 router，
不加入裸 `Request.json()`，不移除 lying Content-Length 复核，不修改 Tillgate，不把
生命周期/过载/可观测性夹入本单元。

## 2. 基线与问题复现

当前分支 8 个交替 fresh-process 样本中：三个不适用 scope gate 的 `/livez` 为 keala
410ns、Hono 485ns，中位数快约 15.5%；该 case 没有执行全局 middleware，不能代表
生产缺口。外部同刻 HTTP 证据中的全局链形态为 Hono 162.3k RPS、keala 148.4k RPS，
差约 580ns/请求。Phase 1 必须新增全局 0/1/3/6 层矩阵，避免优化错误 case。

严格安全 `body-safe` 对拍（declared 预检、实际 UTF-8 字节复核、malformed 处理）中，
keala 约 1402ns、Hono 约 1141ns，慢约 22.9%；两端对 lying-length 与 UTF-8 oversized
均返回 413。该结果确认 body reader 是当前首要确定缺口。

## 3. 旧实现逐模块审计与裁决

| 文件/模块 | 现状与成本 | 裁决 |
| --- | --- | --- |
| `src/core/app.ts` | 每请求创建 `dispatchOf` 闭包；路由匹配后再交给 dispatcher | 重构为参数化内部函数/内联同步路径，删除无条件闭包 |
| `src/core/dispatch.ts` | 同步链也先创建 `finish` 闭包；公开 Promise 包装与 pooling 混合 | 分离同步 finish 与仅异步回调；保持 never-reject/pool retire |
| `src/core/compose.ts` | 每个适用 middleware 每请求一个 guarded `next` 闭包 | 先测层数曲线；仅在等价性可证明时替换链执行器 |
| `src/router/router.ts` | 注册期合并 global + route；静态 Map 已优于 Hono | 保留路由/匹配算法，只允许改变 chain 编译产物 |
| `src/core/context/context.ts` | 固定形状单 context；完整 Koa 状态槽每请求重置 | 暂保留；只有分配剖析证明主导且 pooling/自定义属性等价时再改 |
| `src/plugins/body-parser.ts` | cache 对象、facade、局部 `read`、五个箭头方法；JSON 两级 continuation | 重写为单一固定形状 facade/state，方法放 prototype；合并可合并的 continuation |
| `src/middleware/validator.ts` | 依赖 `readBodyLimited` 和 `bodyJsonLimit` | 保留调用契约，加入交叉回归 |
| `src/core/error-response.ts` | 正确/错误路径最终安全兜底 | 保留，不以削弱错误守卫换数字 |

审计结论：router 不是当前问题；context 延迟拆分风险高且证据不足；第一批实现应只删除
可证明冗余的请求级闭包/continuation，并将 body 状态合并为单一所有者。

## 4. 目标结构与算法不变量

### 4.1 Probe / 洋葱链

- 注册期仍生成 route chain，匹配仍为静态 Map O(1) / 动态 trie O(path segments)。
- 同步 direct 或同步 middleware 链在内部保持同步，`app.handle()` 边界只包装一次 Promise。
- 每层 `next()` 最多一次；外层 post-next 必须严格逆序；没有静态推断 handler 是否同步。
- async rejection、同步 throw、finalize throw 全部进入现有 error funnel；公开 handle 不 reject。
- 浮动 `next()` 仍被观察并阻止 pooled context 提前回收。
- 若通用 JS 函数调用模型无法在保留这些语义时消除每层 closure，则保留 compose，只合并
  上下游固定税；不引入共享可变 dispatch index，避免并发串请求。

### 4.2 安全 JSON reader

- 首次 reader 取得 body 所有权；原始 bytes Promise 只创建一次并立即 memo。
- declared length 大于 reader 限额时读前 413；声明未超时读后仍以实际 byteLength 复核。
- 无声明流按 chunk 累加，超限取消 reader；单 chunk 零拷贝，多 chunk 一次 O(n) 合并。
- 较大限额先读后，较小 reader 仍执行限额复检；被拒绝的首次读取对后续 reader 保持拒绝。
- `json/text/arrayBuffer/blob/formData` 各自 memo in-flight Promise；同 reader 并发调用返回
  同一 Promise，JSON 返回同一对象或同一 rejection reason。
- JSON happy path 只允许一次 native body read、一次实际字节检查、一次 UTF-8 decode、一次
  `JSON.parse`；不额外复制 bytes，不产生每方法 closure。
- 算法时间为 O(body bytes)，附加空间为流式多 chunk 的 O(body bytes)；限额使其有界。

## 5. 测试计划（实现前锁定）

### 5.1 Probe/compose 行为矩阵

0/1/3/6 层 global middleware × sync/async handler；前序/后序；middleware 短路；返回式
Response 与 state-style body；双 next；sync throw/async reject；未 await 的浮动 next；
404/405/HEAD/OPTIONS；pooling on/off 并发隔离；late header/status/body rule-4。

### 5.2 Body 安全与并发矩阵

declared empty/正常/恰好 limit/超限；lying small length；truncated declared；无声明
single/multi/empty chunk；流式超限取消；UTF-8 多字节超限；malformed JSON 400；JSON
primitive/null；并发同 reader Promise/对象/reason 同一性；json→text 与 form→smaller bytes；
validator 先读/handler 后读；pooling 复用不得泄露 bytes/facade/parsed object。

### 5.3 性能矩阵

每个 case 独立 fresh Bun process，至少 8 样本交替顺序，固定 warmup/batch，报告 median、
IQR 与全部样本；计时前断言 status/body/header。比较项：probe global 0/1/3/6、bare text、
dirty text、body-safe、body reader only、malformed/413（只作回归，不以削安全守卫为目标）。

Hono 对照必须显式执行实际字节复核；官方 `bodyLimit` 因信任 declared length，只列非等价
参考，不用于“超过”结论。

## 6. 性能与内存预算

- probe global 目标：相对本分支基线至少改善 10%，并将相同层数/行为的 Hono 中位数作为
  竞争线；若仍落后，继续 profile，不能只凭一个微优化宣称完成。
- body-safe 目标：相对约 1402ns 基线至少改善 15%；同安全 Hono 约 1141ns 是竞争线。
- probe 0 层、bare text、dirty text 不得稳定回退超过 3%；p99、error/timeout 不恶化。
- 每请求不新增全局 Map/WeakMap 项，不建立无界缓存；body 状态随 context/pool reset 清空。
- live HTTP 同时报告 RPS、p50/p99、错误、timeout、RSS；微基准优势不能代替 wire 结果。

## 7. 实施与提交边界

1. 文档定稿；
2. benchmark 与行为锁提交；
3. probe 固定税重写、局部门禁、fresh-process 裁决并提交；
4. body 状态机重写、局部门禁、fresh-process 裁决并提交；
5. 双运行时全量、coverage、build、smoke、example、soak、live HTTP；
6. Tillgate 只读消费验证、文档核销、最终提交。

## 8. 停止/回退条件

- 任何洋葱顺序、双 next、浮动分支、never-reject、pool isolation 行为变化；
- 任何 declared/actual/chunked 限额、取消、memo、malformed 400 行为变化；
- 目标收益低于预算且 IQR 高度重叠；
- 非目标热路径稳定回退超过 3%；
- 需要新增公开 API、关闭安全检查或修改 Tillgate 才能获得优势。

## 9. 完成定义

只有两条目标热路径均给出前后与 Hono 同语义 fresh-process 数据，所有功能/安全/并发
矩阵通过，四项覆盖率不下降，双运行时与进程门禁全绿，Tillgate 工作树保持原样，本文档
记录最终提交与数字后，R4.4 才能核销。
