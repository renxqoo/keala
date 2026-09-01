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
| Hono onError 信封           |    833 | keala 与其 IQR 重叠，带内平价                                 |

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

### 10.4 行为增量声明

除返回 Response 接管外，仅一处行为增量：mapper 抛错/拒绝时框架
console.error 该错误（原先完全静默）。此外 koa 的 `onerror` 方法、事件面、
`silent`、`statusCode` 别名按用户裁决直接删除，未保留过渡期。
