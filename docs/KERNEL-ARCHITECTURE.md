# 独立 Kernel 原型：把成本放在需要能力的请求上

这是一套新 API 的可运行实验，入口在 `experimental/kernel`，尚未加入发布包。正式实现和 Keala 对外 API 仍在 `src`。Hello World 与十二路由只覆盖小路由表的同步文本性能，不能代替通用框架的功能验收。

[当前源码的远端复测](../bench/framework-compare/kernel-recheck-2026-11-02/README.md)显示：默认 trie Kernel 的十二路由综合性能与 Keala 接近持平；显式 RegExp 方案在 Node/Bun 下分别提高约 3.82%/5.52% 吞吐，CPU/请求降低约 4.02%/5.89%。这些观测值限于报告中的共享主机、配额和文本场景，不能推导完整应用的迁移收益。

```ts
import { Kernel, json } from "../experimental/kernel/kernel.ts";
import { listenNode } from "../experimental/kernel/node.ts";

const app = new Kernel()
  .text("GET", "/", () => "Hello World")
  .text("GET", "/user/:id", (params) => params.id!)
  .route("POST", "/echo/:id", async (request, params) =>
    json({ id: params.id, body: await request.text() }),
  )
  .use("/private", async (request, next) => {
    if (!request.headers.has("authorization")) return new Response("denied", { status: 403 });
    return await next();
  });
const server = await listenNode(app, { port: 3000 });
// Bun 对应 listenBun(app, options)，不依赖 srvx。
await server.close(5000);
```

小表的另一种编译策略可显式选择 `new Kernel({ router: "regexp" })`。它保留同一 API 和 trie 降级路径；默认仍为 trie。RegExp 的文本场景收益已有上述复测数据，Fetch、中间件、JSON/body、异步任务与流处理的性能仍需分别测量。

## 选择的架构

构建器拥有注册记录；`build()` 生成封闭的执行计划。执行计划拥有路由表、处理器引用、中间件及错误映射。连接和输出队列由适配器拥有。每个动态匹配的参数袋由该请求独占，不跨请求回收，不把保留的参数指向可复用数组。

路由采用 method → 静态 Map / 分段 trie。静态命中复用固定的匹配结果和只读空参数；动态路径才创建参数对象。trie 优先尝试静态分支，失败后回退参数和末尾通配。选择它是因为模式有限、冲突可检查、无需生成运行时代码。大路由表或复杂表达式是否需要另一种算法，必须另测；本轮只有 1/12 条注册路由。

RegExp 候选把有限模式按路径段的静态、参数、通配优先级合并，减少动态命中的 split/map 和递归分配。它不分析处理器，不使用 eval；HEAD/ALL/Allow 和 miss 仍由原 trie 处理。动态定义超过 64 条或正则源累计超过 16 KiB 时回退；执行阶段出现引擎 SyntaxError/RangeError 也永久退役该方法快表。Node/Bun 各有 48,000 次与原 trie 的选择差分，并检查编码、空通配、末尾换行及参数独占性。

端点显式声明能力，编译器不分析 `handler.toString()`，也不把看起来恒定的处理器替换成缓存响应。每个请求都会调用处理器：

| 能力                                          | Node                                                                                       | Bun                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `text(method,path,params=>string)`            | 原生 IncomingMessage/ServerResponse，直接写字符串；不创建 Fetch Request、Response、Context | 使用原生 Request，仅在输出时创建 Response；不添加 srvx 扩展 |
| `route(method,path,(Request,params)=>Result)` | 按需构造标准 Fetch Request，包括请求体流和断连 signal                                      | 使用原生 Fetch Request                                      |
| 命中 `.use(prefix, middleware)`               | 提升到 Fetch 执行路径                                                                      | 执行 Fetch 中间件链                                         |

中间件按注册顺序执行，字面前缀具有路径段边界；同一作用域的 404/405 也经过中间件。`next()` 必须 await 或 return；重复调用失败，未观察的分支失败，并等待已启动的分支结束。响应可以是字符串、标准 Response，或者保存状态和响应头快照的 Reply。错误映射失败时回退到固定 500。

Node 执行器把连接、请求体和响应流的善后放在冷支路；纯文本同步请求不安装每请求完成监听器。连接级记录在关闭阶段跟踪物理输出完成，处理排队的 HTTP/1 响应及强制关闭期限。Fetch 流遵守背压，在断连时取消 reader；未读取的上传需排空或结束连接，不能阻塞后续请求。Bun 使用原生服务器的停止和强制停止能力。

## 已比较的方向

| 方向                           | 收益与代价                                                             | 本轮处理                                          |
| ------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------- |
| 继续优化旧 Context/srvx 链     | 兼容现有行为，但原始 Request 扩展、Context、响应兼容等仍是基准路径成本 | 保留旧入口作对照                                  |
| 所有平台统一 Fetch 调度        | API 一致、适配简单；Node 纯文本也需对象转换和 Web 流桥接               | 用于显式 Fetch 能力                               |
| 封闭路由计划 + 分平台执行器    | 纯文本省掉不需要的通用层；代价是维护两种 transport 行为                | 本轮候选                                          |
| Bun 原生 routes                | 可省去 Core 匹配，但需要参数、方法和特殊 URL 回退                      | 小范围四轮 A/B 未见收益，候选撤回，源码和数据归档 |
| 处理器源码代码生成、静态包缓存 | 存在动态处理器副作用、响应所有权和输出生命周期风险                     | 未采用，不计入已实现收益                          |

## Node HTTP 执行引擎隔离

`bench/framework-compare/native-text.mjs` 注入同一份编译 Kernel，仍执行相同路由选择、处理器和参数读取，仅用 uWebSockets.js 替换 node:http。官方固定版本 [v20.67.0](https://github.com/uNetworking/uWebSockets.js/releases/tag/v20.67.0) 提供 Node 26 ABI 147，插件在本地准备、固定摘要后打包，wr 不构建、不安装系统包。实际 Linux 加载及 HTTP 校验已完成。

这个探针只支持同步文本和框架内部 Reply；Fetch、中间件和异步结果明确返回 501，停止仅提供 force。原生 Request/Response 不会跨回调保存；不存在跳过处理器、静态替换函数或 DeclarativeResponse。它证明整条 HTTP 执行链的差别，不能把收益单独归因于某一个 parser，也不能把这一列称为旧 API 或通用框架的等价加速。通用 Node 原型仍使用实现了 Fetch 流、断连、pipeline 和有期限 drain 的 node:http 执行器。

该边界来源于原生平台的所有权与生命周期：[uWebSockets.js 固定版本类型契约](https://github.com/uNetworking/uWebSockets.js/blob/v20.67.0/index.d.ts)。若后续迁移通用 Node 后端，需要另外完成 Fetch 桥接、背压、取消和关闭合同矩阵。

## 未采用的 Response 复用

Bun 原生 static routes 的 Response 优化不能直接套用到普通 fetch 回调。本机 Bun 1.4.4 合同探针中，直接重复返回同一字符串 Response 在首请求后变为 bodyUsed，随后进入 500，HEAD 也会消耗共享正文。实现没有采用这种缓存。[Bun 1.4 行为说明](https://bun.sh/blog/bun-v1.4)、[原生路由说明](https://bun.sh/docs/runtime/http/routing)

私有字符串模板逐请求 clone 在 13 个连续、并发及 HEAD 合同请求中正确，尚无吞吐或 CPU 收益证据，因此也未加入执行器。对应本地合同探针保存在本轮实验目录；这些检查不属于 wr 的框架性能排名。

## 与旧 Keala 的有意差异

- 所有注册需在首次 `build`、`fetch` 或监听前完成；运行中变更需新建快照。
- method-first 匹配。某方法的静态路由不会挡住另一方法的参数路由。HEAD 先显式路由再 GET；支持 ALL、自动 OPTIONS 和 Allow。
- 模式支持静态段、`:name` 和末尾 `*` / `*name`；拒绝可选参数、自定义正则、重复参数名和重复结构。忽略一个末尾斜杠。参数逐段解码，编码斜杠仍在一个参数中，错误编码返回 400。
- 没有旧 Context、动态状态、srvx Raw Request 的 `runtime/ip/waitUntil` 扩展、插件、WebSocket/SSE 专用 API、签名 Cookie 等兼容承诺。标准 Response 可以输出流及多条 Set-Cookie。
- Node 原型仅 HTTP/1，没有 TLS/upgrade、自定义 body 限额、过载保护和处理器 deadline。强制关闭能终止连接，不能中止任意永不结束的用户 JavaScript。
- 不承诺所有低层 HTTP 边界、URL 异常形式或两种运行时的完整一致性。已有行为测试覆盖常用路径及已发现的连接生命周期问题，后续迁移须建立完整合同矩阵。

## 验证与可复现性

运行 `npx vitest run test/experimental` 和 `bun --bun x vitest run test/experimental`。Node 原生适配器测试只在 Node 执行；Bun 原生适配器测试只在 Bun 执行，公共内核测试两边都运行。

本地编译：`npx tsc -p experimental/kernel/tsconfig.build.json --outDir /tmp/your-owned-directory/kernel`。性能打包时向 `pack-remote.mjs` 提供 `BENCH_KERNEL_DIST`，manifest 独立记录原型源码和编译摘要。`BENCH_FRAMEWORKS=kernel,keala,hono,h3` 选择原型和同机对照；原型未打包时该选择会拒绝。实验报告必须说明新 API 能力与旧框架不同，不能宣称旧 API 等价加速或据此承诺生产“全面领先”。

服务器仍采用 `REMOTE.md` 的单任务、限额、资源保护和清理流程；吞吐、延迟、每请求 CPU 都取真实 HTTP 样本，不以路由微基准代替。
