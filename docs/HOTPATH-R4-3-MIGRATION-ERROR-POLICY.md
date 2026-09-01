# R4.3 — 错误响应策略迁移文档

> 状态：方案定稿（Phase 0，待实施）
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

| #   | 规则                                                                                                                                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **单槽**：重复注册抛 `TypeError`（与 `app.ws` 重复注册同风格）；多方协作在各自的函数里组合，不靠隐式多播                                                                                                                           |
| 2   | 到达 mapper 的错误**恒为 HttpError**（带合法 `.status`）；非 HttpError 的抛出物在漏斗入口包装为 500（`expose:false`，原始 stack 与 `cause` 保留）                                                                                  |
| 3   | 返回 `Response` → 接管：HEAD 请求剥 body；`error.headers` 与安全 staged 头 **if-absent** 合并（mapper 自设的头永远赢；content 描述头永不补）                                                                                       |
| 4   | 返回 `void` → 内置默认响应（text/plain，非 expose 的 message 永不泄露）                                                                                                                                                            |
| 5   | 返回 thenable → await；mapper 抛错/拒绝 → static 500（HEAD 感知）且**框架 console.error 该错误**——mapper 的 bug 必出声，不再静默                                                                                                   |
| 6   | 未注册 mapper + 5xx + 非 test env → 框架 console.error；注册后日志完全是 mapper 的副作用（想静默就注册一个空函数，显式优于 `silent` 开关）                                                                                         |
| 7   | 覆盖范围 = 错误漏斗全体：chain 抛错（handler/middleware/`c.throw`）、finalize 失败（不可序列化 body 等，koa 中间件结构上永远看不到的路径）、ws upgrade 拒绝；不含路由未中 404（`app.notFound` 管）与响应开始后的流中断（物理限制） |
| 8   | `app.handle` 永不 reject（既有边界不变）                                                                                                                                                                                           |

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

- [ ] §6 六组行为锁全绿；全量 Node/Bun/build/smoke 通过
- [ ] 删除清单落地，无残留死代码
- [ ] 快乐路径零回退；错误路径三方案对拍数字入档
- [ ] 覆盖率不低于 R4.2 基线
- [ ] 文档（README 错误处理章节 + DESIGN §2.2 修订）随实现更新并核销

## 10. 实施记录

（待实施后填写。）
