# R4.3 — 错误响应策略迁移文档

> 状态：已核销
> 设计基线：[HOTPATH-R4-DESIGN.md](./HOTPATH-R4-DESIGN.md) §2.2（已按本轮裁决修订）
> 基线提交：`241a1ca`（R4.2 已核销）
> 工作分支：`codex/hotpath-r4-3-error-policy`
> 用户裁决：项目无存量用户，**不保留任何兼容逻辑**；生产可用优先——高性能、
> 高可用、未来扩展无副作用。凡是纯为兼容旧代码/旧生态存在的机制一律删除。

## 1. 目标

给应用一个单点错误映射器：错误响应形状（企业信封、错误码、日志分级）在
`app.onError` 一个函数里集中完成，取代 koa 时代的全局 try/catch 中间件。
正常请求零新增成本（错误路径单函数调用，快乐路径代码不变），错误路径语义
无死角（含 finalize 失败）、无静默失败。

## 2. 新契约（外部行为规格）

### 2.1 API

```ts
type ErrorMapper = (error: HttpError, c: Context) => Response | Promise<Response> | void;

app.onError(mapper): Application;
```

### 2.2 规则（每条一句话，无例外分支）

| #   | 规则                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **单槽**：重复注册抛 `TypeError`（与 `app.ws` 重复注册同风格）；多方协作在各自的函数里组合，不靠隐式多播                                                                                                                              |
| 2   | 到达 mapper 的错误**恒为 HttpError**（带合法 `.status`）；非 HttpError 的抛出物在漏斗入口**原地分类**为 500（`expose:false`）——真实 Error 保持自身对象/名字/栈（零新增栈捕获），非 Error 抛出物经 `normalizeError` 归一并携带 `cause` |
| 3   | 返回 `Response` → 接管：HEAD 请求剥 body；`error.headers` 与安全 staged 头 **if-absent** 合并（mapper 自设的头永远赢；content 描述头永不补）                                                                                          |
| 4   | 返回 `void` → 内置默认响应（text/plain，非 expose 的 message 永不泄露）                                                                                                                                                               |
| 5   | 返回 thenable → await；mapper 抛错/拒绝 → static 500（HEAD 感知）且**框架 console.error 该错误**——mapper 的 bug 必出声，不再静默                                                                                                      |
| 6   | 未注册 mapper + 5xx + 非 test env → 框架 console.error；注册后日志完全是 mapper 的副作用（想静默就注册一个空函数，显式优于 `silent` 开关）                                                                                            |
| 7   | 覆盖范围 = 错误漏斗全体：chain 抛错（handler/middleware/`c.throw`）、finalize 失败（不可序列化 body 等，koa 中间件结构上永远看不到的路径）、ws upgrade 拒绝；不含路由未中 404（`app.notFound` 管）与响应开始后的流中断（物理限制）    |
| 8   | `app.handle` 永不 reject（既有边界不变）                                                                                                                                                                                              |

### 2.3 不变式（与 R4.1 前一致的健壮性，非兼容逻辑）

- 非 Error 抛出物（字符串/对象/BigInt/循环结构）安全归一，漏斗永不因归一失败而炸；
- 错误响应清空 stale `_res`、剥 content 描述 staged 头、重置 flags（安全头保留）；
- 终结兜底 static 500 防递归：内置路径永不重入 mapper。

## 3. 删除清单（纯兼容机制，全部移除）

| 删除项                                                       | 理由                                                                                                                                 |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `src/core/emitter.ts` 整个多播模块                           | 唯一事件是 `"error"`，只服务 onError 多播；单槽后无用                                                                                |
| `app.off` / `app.emit` / `app.listenerCount` 公开方法        | Node EventEmitter 生态形状，无内部消费者                                                                                             |
| `KealaOptions.silent`                                        | 用「注册空 mapper」显式表达静默，删除布尔开关                                                                                        |
| `HttpError.statusCode` 别名字段                              | http-errors 生态兼容字段                                                                                                             |
| `errorStatusCode` 的 `.statusCode`/第三方 `.status` 回退链   | 状态只认 HttpError（`isHttpError` 鸭子判定：Error 且 `.status` 为合法状态码）；第三方错误带语义必须显式 `c.throw`/`createError` 包装 |
| onAppError 的 clientError/expose 分类日志豁免与 `heard` 判据 | console 兜底简化为规则 6 的单一条件                                                                                                  |

注：`src/adapters/node.ts` 的 `res.statusCode` 是 Node http.ServerResponse 适配契约，与错误兼容无关，保留。

## 4. 逐模块裁决表

| 文件                      | 裁决 | 动作                                                                                                                         |
| ------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------- |
| `src/core/dispatch.ts`    | 重构 | `buildErrorResponse` 插入单槽 mapper 分支；`onAppError` 简化为规则 6 的兜底；删除 `errorStatusCode` 回退链；包装非 HttpError |
| `src/core/app.ts`         | 小改 | onError 单槽存储（二次注册抛错）；删除 `#emitter`、`off/emit/listenerCount`、`silent` 装配                                   |
| `src/core/application.ts` | 小改 | 类型更新（`ErrorMapper`）、删除 emitter 相关签名                                                                             |
| `src/core/emitter.ts`     | 删除 | 整文件                                                                                                                       |
| `src/http/errors.ts`      | 小改 | 删除 `statusCode` 别名；新增 `toHttpError` 包装（或放 dispatch，以依赖方向定）                                               |
| `src/adapters/*`          | 不动 | 通过集成测试回归                                                                                                             |
| `test/*`                  | 更新 | 引用 emitter/silent/statusCode 的既有用例改写为断言新契约；新增行为锁见 §6                                                   |

## 5. API 对照表

| 旧                                              | 新                             | 变化               |
| ----------------------------------------------- | ------------------------------ | ------------------ |
| `onError(handler: (e, c) => void): Application` | `onError(mapper): Application` | 返回值可接管；单槽 |
| `off/emit/listenerCount`                        | 删除                           | 无事件面           |
| `KealaOptions.silent`                           | 删除                           | 空 mapper 显式静默 |
| `HttpError.statusCode`                          | 删除                           | 只读 `.status`     |
| 内置 text/plain 错误响应                        | 不变                           | decline 时的默认   |

## 6. 测试迁移矩阵（只为新行为写新锁，存量行为靠存量锁）

1. on/off 差分：未注册 / decline(void) / 接管三形态，decline 与未注册的内置输出逐字节等价；
2. 单槽：第二次 `onError` 注册抛 `TypeError`；
3. 异步：thenable 被 await；mapper 拒绝 → static 500 且 reject 不逃出 `app.handle`；
4. mapper 抛错（sync/async）→ static 500 + 框架 console.error 该错误；
5. 合并：`error.headers`/安全 staged 头 if-absent、自设头优先、content 头永不补、HEAD 剥体；
6. 覆盖：`c.throw` 4xx、意外 5xx、finalize 失败、ws upgrade 拒绝均到达 mapper；
   非 HttpError（`throw "boom"`、`throw {a:1}`）包装为 500 HttpError（stack/cause 保留，expose:false）。

既有用例更新：emitter/silent/statusCode/多播相关断言改写；onError 观察语义类用例
迁移为「mapper 副作用」形态。全量 Node/Bun 回归绿为准。

## 7. 性能预算

- 快乐路径：`buildErrorResponse` 之外的代码路径零变化；probe/dirty-text/bare-text/
  JSON 对 R4.2 后基线 ABBA **零回退**；
- 错误路径：新增 `compare-hono-hotpaths` 的 error case——keala+mapper 信封 vs
  keala+try/catch 中间件信封（koa 形态）vs Hono+onError 信封；目标是显著快于
  中间件形态（少一层洋葱 + 一层 Promise 守卫），对 Hono 不慢；
- 错误路径自身：单函数调用、无循环无扫描（单槽比多播更简）。

## 8. 回滚

单一提交可 revert；revert 后回到现网行为（onError 观察 + 内置响应 + emitter）。

## 9. 验收

- [x] §6 六组行为锁全绿；全量 Node（1904 passed）/ Bun（1880 passed）/ build / smoke / example 通过
- [x] 删除清单落地（emitter 模块、off/emit/listenerCount、silent、statusCode 别名、第三方回退链、onAppError 分类豁免），无残留死代码
- [x] 快乐路径零回退（ABBA 四案例 IQR 带内平价）；错误路径对拍数字入档（§10.2）
- [x] 覆盖率 97.25/92.04/96.13/98.55，四项均高于 R4.2 基线 97.15/91.89/96.03/98.53
- [x] README 错误处理章节重写、DESIGN §2.2 已随方案修订

## 10. 实施记录

### 10.1 实现与结构

- `dispatch.ts`：漏斗重构为 `toHttpError → 共享 reset → mapper 分支 →
builtinErrorResponse / finalizeMapperResponse(HEAD 剥体 + if-absent 合并) →
fail(console.error + static 500)`；`onAppError`/`errorStatusCode`/`isErrorLike`
  删除，替换为单条件 `consoleFallback`（未注册 mapper + 5xx + 非 test env）。
  `parseListenArgs` 移出到新的 `core/listen.ts`（dispatch 500 行预算）。
- `app.ts`/`application.ts`：单槽 `#errorMapper` + `onError`（非函数/重复注册
  均抛 TypeError）；删除 emitter 装配与 `onerror/off/emit/listenerCount/silent`。
- `errors.ts`：删除 `statusCode` 别名；新增 `toHttpError`；`normalizeError`
  补跨 realm error-like 判定（健壮性，非兼容）。
- `adapters/bun.ts`：serve/ws 运行时错误（无请求上下文，不适用 mapper 契约）
  改走 `consoleFallback`。
- 新增 `bench/error-path.ts`（5 变体 fresh-process）与 `compare-hono-hotpaths`
  的 error/error-mw 案例；新增 `test/r4-error-policy.test.ts` 14 组行为锁；
  存量引用删除面的用例改写/删除（emitter 专测随模块移除）。

### 10.2 性能（Apple M4，Bun 1.4.0，fresh-process，每变体独立进程）

错误路径（意外 5xx + JSON 信封，4 轮旋转中位数，`bench/error-path.ts`）：

| 变体                        | ns/req | 说明                                                          |
| --------------------------- | -----: | ------------------------------------------------------------- |
| keala onError mapper 信封   |    897 | IQR 842–1014                                                  |
| koa 式 try/catch 中间件信封 |   1088 | 错误路径本身慢 18%，且每个健康请求另付洋葱层 + Promise 守卫税 |
| Hono onError 信封           |    833 | IQR 相接；中位数差 8%（机器相关，另台机器测得 8–12%）         |

快乐路径 ABBA（R4.3 vs R4.2 基线，两轮交替）：probe 427/380 vs 497/383、
裸 text 320/371 vs 364/314、正确 dirty text 766/754 vs 779/755、有界 JSON
1286/1332 vs 1311/1326——全部 IQR 带内平价，零回退（快乐路径代码未变）。

### 10.3 实施期裁决：toHttpError 的一次返工

初版按 §2 规则 2 的"包装"实现（新建 500 HttpError + 拷贝原始 stack），基准
立刻暴露错误路径 5332ns——比 koa 式中间件慢 5 倍，深栈下 JSC 的栈物化是
主因。两次修正：惰性 stack getter（5332→3583）仍不够；最终改为**原地分类**
（在原错误对象上写 `status=500/expose=false`，真实 Error 零新建零栈捕获，
非 Error 才经 normalizeError 归一），降到 ~890ns。教训已写入 §2 规则 2：
错误路径的每微秒都要过基准，"看起来等价"的包装成本在深栈下不成比例。

### 10.4 多角度 review 轮（4 子代理 + 人工交叉裁决）

四个只写红测的 review 代理（bug/性能/安全/契约高可用）产出 **1 P0 + 7 P1 +
4 P2**，全部经人工复核实锤并修复；review 红测保留为回归锁
（`test/agent-review-*.test.ts` 六个文件）：

| 级别 | 问题                                                                                                         | 修复                                                                              |
| ---- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| P0   | 手写 thenable 返回值穿透 never-reject 边界（`out.then` 直连，非原生 Promise 时泄漏 undefined/同步抛/拒绝）   | `Promise.resolve(out)` 采用                                                       |
| P1   | `error.headers` 的 content-length/type/transfer-encoding 合并上接管响应——Node 适配器 wire 级错帧（响应走私） | 合并排除 content 描述头（含 content-encoding，两来源一致；reset 同步剥离）        |
| P1   | 一个非法头中止整个合并——安全头与 WWW-Authenticate 同时丢失                                                   | per-entry try/catch（Bun 的 `Headers.has` 对非法名也抛，须一并入护栏）            |
| P1   | 冻结 Error 绕过 mapper 且无日志（原地分类写入抛错被吞）                                                      | `toHttpError` 冻结回退为包装（罕见路径，额外栈捕获可接受）                        |
| P1   | 复用/已消费/锁定的接管 Response 损坏后续请求（wire 或静默降级）                                              | 不可用 Response 响亮失败（console + static 500）；`retireWithBody` 静默交换改响亮 |
| P1   | ws 容错自身在冻结 Error 上变成 unhandledRejection                                                            | 容错体自带 try/catch                                                              |
| P2   | `Response.error()`（type error）接管直达 wire                                                                | 同"不可用 Response"守卫                                                           |
| P2   | 带体 204/304 接管未消毒                                                                                      | 与 committed 路径共享 `sanitizeEmptyStatus`                                       |
| P2   | Set-Cookie 数组 `", "` 拼接 / staged 多值只留首值                                                            | append 语义（按名 if-absent、按值 append）                                        |
| P2   | `__proto__` 等禁用头名绕过合并路径                                                                           | 合并遵守同一禁用名单                                                              |
| P2   | 文档措辞：错误路径对 Hono "带内平价"实为机器相关（另一机器 8–12% 慢）                                        | §10.2 已修订                                                                      |

性能复核（性能代理）：快乐路径注册 mapper 零成本 ✓、零内存泄漏 ✓、无 deopt ✓。
守卫代价（如实记录）：错误路径 897 → ~1120ns（+~230ns 的可用性检查与合并护栏），
仍与 koa 式中间件相当（后者继续为每个健康请求付洋葱税）；对 Hono 错误路径
在本机慢 ~25%。快乐路径零回退保持（probe 402 / dirty 814，带内）。

附带结构清理：错误漏斗抽为 `core/error-response.ts`（dispatch 500 行预算）；
`finalizeGuarded` 删除运行时不可达的 Promise 分支；`sanitizeEmptyStatus` 去重。

### 10.5 性能轮：错误路径成本解剖与三项优化

`bench/error-profile.ts`（a–h 变体分解，fresh-process）定位差距构成：

| 层                                | keala | Hono |        差 |
| --------------------------------- | ----: | ---: | --------: |
| 快乐路径机器底座（预构建响应）    |   198 |  185 |      平价 |
| 错误路径 + 预构建响应（纯漏斗差） |  ~577 | ~486 | **+91ns** |
| 错误路径 + 构建信封（c.json）     | ~1000 | ~790 |    +210ns |

据此实施三项优化（全量 1957/1936 用例与 review 锁保护下）：

1. **takeover 跳过 context reset**——reset 只服务内置路径（从状态构造），
   接管路径的 Response 已建成，合并按名排除 content 头，池化回收自带
   重置；reset 移入 `builtinErrorResponse`。
2. **`mapperFailed` 提升为模块级**——去掉每错误一次的闭包分配。
3. **decline 快速路径**——无 staged 头/无 error.headers/非 HEAD/带体状态
   时直接构造逐字节相同的内置响应，绕过 staged-state + finalize 全套机器
   （decline 1040 → ~915ns，从最慢形态变为与接管持平）。

**剩余差距的诚实归因**（~91ns 漏斗 + ~50ns 糖前奏）：买的是 Hono 没有的
保证——恒为 HttpError 的契约、不可用 Response 守卫（review 轮修复的三类
P1 wire 损坏正是 Hono 会直接放行的形态）、staged 头合并语义、响亮失败。
错误路径本身是冷路径（业务 4xx 走 `c.throw` 直通，无分类成本）；快乐路径
keala 持续快于 Hono（427 vs 516 / 320 vs 346）。带 body 读取与每请求分配
的完整基准会把 ~150ns 的契约成本放大成 ~25–30% 的表观差距——数字入档，
不做进一步的守卫裁剪换取纳秒。

### 10.6 行为增量声明

除返回 Response 接管外，仅一处行为增量：mapper 抛错/拒绝时框架
console.error 该错误（原先完全静默）。此外 koa 的 `onerror` 方法、事件面、
`silent`、`statusCode` 别名按用户裁决直接删除，未保留过渡期。
