# R4.5 复核：原生对象所有权与异常隔离

> 状态：正确性修复与复验完成；R4.5 整体性能预算未达，不能整体核销（2026-09-03）
> 基线：`3c4347f`；只修改 bun-koa，不修改 Tillgate。
> 本文是 R4.5 设计/实施/迁移文档的追加裁决；此前核销不覆盖以下新确认缺陷。

## 1. 已确认缺陷与外部契约

| 编号   | 最小复现                                                                        | 必须保持的契约                                                            |
| ------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| B45-14 | plan 的锁定 body 仍可 clone；clone 在首次读头前看到原响应后续修改               | clone 按原生 Response 处理 locked/used 状态及 header 快照                 |
| B45-15 | async 单 handler 返回 status getter 抛错的 Response，handle reject              | 同步、异步收尾错误都进入框架错误映射，handle 不 reject                    |
| B45-16 | Node c.headers/raw.headers 修改后 c.get 仍读原始头表，两个 Headers 非同一对象   | 请求头只有一个可修改事实源；访问顺序不改变身份及可见性                    |
| B45-17 | 非法 status/header 不在构造时抛错；原 Uint8Array 后续修改改变响应               | 构造时验证非默认 init；二进制 body 取得自己的快照                         |
| B45-18 | Node writer 失败后返回 `500 Original`，沿用旧 `Content-Length: 1000` 和 gzip 头 | 错误信封必须重置头及 reason；拒绝已消费/锁定 body；下一条管线响应不得错帧 |

## 2. 逐模块裁决及执行方案

- response-plan 重构：保留默认 string 小响应的轻量计划；非默认 init 用原生构造验证。
  首次 headers/body/clone 访问时物化唯一 native Response，之后全部 API 共用它；clone
  直接委托 native.clone。Uint8Array 在构造时复制一次，这是快照契约成本，不保留借用旧路径。
  删除 headersInit/headersResolved/status/statusText 的重复缓存及多形态 header writer；
  默认实例仅 directBody/implicitContentType 两个 own slots。原生 Response 拥有全部已观察状态。
- Node request source 重构：单字段读取在物化前直接读 incoming；首次 c.headers/c.raw
  物化唯一 Request，之后 header/headers/raw.headers 都以它为准，删除第二份 Headers 缓存。
  未访问对象 API 的 probe 和有界 native body 路径继续不创建 Request。
- dispatchDirect 修复：将收尾回调自身放入错误守卫；不添加公共 API，不增加成功路径 Promise。
- Node writer 在普通响应分支发送前拒绝 used/locked body；未发头的失败分支清空已暂存头和
  reason，再构造静态错误信封；已发头仍关闭连接。默认计划快路径不增加此项检查。
- 原有 Node adapter、body、Response、pooling、属性测试保留，新增回归先在基线上证明失败。

## 3. 验证与迁移边界

- 锁定/已读/已取消 body clone；clone 头快照、删除 Content-Type、Set-Cookie；
  headers 在 body 物化后的修改仍影响 Blob 类型；非法 status/header 立即抛错；bytes 快照。
- async 收尾异常经过 onError，返回 opaque 500 或 mapper Response；同步行为不变。
- 真实 Node socket：headers-first/raw-first 两种顺序，同一 Headers，修改可见且跨请求隔离。
- fmt/typecheck/build/全量 Node+Bun/coverage 不下降；source/dist 进程检查。
- 同版本 Hono 与修改前/后都必须用相同负载，样本及统计口径落档。历史 28.35k 与 133k
  来自不同 connections/pipelining，不能作为严格的同负载 4.7 倍因果结论。
- 不降低原设计性能目标换取核销；有缺陷或未完成验证时不得宣称整体生产验收完成。

## 4. 验收

- [x] B45-14/15/16/17/18 先红后绿，旧测试全量保留
- [x] 双运行时与构建产物门禁通过，覆盖率不低于 `97.32/92.07/96.29/98.69%`
- [x] 同负载前后性能记录与 Hono 比较可复核，不用独立中位数冒充配对数据
- [x] 只提交本轮点名文件；Tillgate 工作树保持未修改

## 5. 质量证据

第一组 7 个新增回归在修改前全部失败；修复后通过。进一步的 init 强制转换回归、
3 个 Node 管线连接错误分帧回归也均先确认失败，再修复。没有删除原用例或降低门限。
覆盖原生 clone/header/body 所有权、构造验证、二进制快照、异步收尾隔离、非法 handler
返回值、headers-first 后有界 body memo、413 后继续请求及错误后下一条管线响应。

| 门禁                                                  | 本轮结果                                                         |
| ----------------------------------------------------- | ---------------------------------------------------------------- |
| Node / Vitest                                         | 110 文件，2028 pass / 8 skip                                     |
| Bun 1.4.0                                             | 110 文件，1999 pass / 37 skip / 0 fail                           |
| coverage（statements / branches / functions / lines） | 97.35% / 92.15% / 96.29% / 98.73%                                |
| fmt / typecheck / build                               | 通过                                                             |
| lint                                                  | 本轮改动文件 0 error / 0 warning；全仓仍有既存 warnings，0 error |
| smoke / example / soak                                | 通过，含 Bun 1.4 文本类型真实 HTTP 与 24×20,000 soak             |
| 进程矩阵                                              | Bun / Node × source / dist 全部通过                              |

运行时差异：裸 `new Response("x", { statusText: "bad\\r\\nphrase" })` 在 Node 22.20.0
抛 TypeError，而 Bun 1.4.0 允许构造。计划遵循所在运行时的构造契约，回归分别与原生对象
对照；没有强行将 Node 构造行为套给 Bun。框架已有的 staged statusText 校验没有削弱。

Tillgate 本轮仅检查原工作树未修改；没有重跑消费方 718 项测试，旧文档中的结果属于上一轮。
回滚本轮提交不涉及数据库或数据迁移；本轮修复形成独立提交，但回滚会重新暴露这些已确认缺陷。

## 6. 性能复验口径

Apple M4，同一台机器顺序运行 Node 22.20.0 与 Bun 1.4.0；Hono 4.13.5，官方 Node
adapter 2.1.1，autocannon 8.0.0。修复前为独立 checkout `3c4347f`，共享同版本依赖；
每轮交错运行修复后 / Hono / 修复前三个独立进程，轮换次序，每个样本重新启动服务。
各场景 5 轮，200 connections，pipeline 1，预热 1 秒、采样 5 秒；GET 使用 4 个
load workers，POST 使用主进程（autocannon 8 的 body+workers 统计缺陷仍需规避）。

计时前验证正文、状态、Content-Type、已有 Content-Length 与实际字节相符、无 CL/TE
冲突、洋葱 late headers，以及 JSON 的 400/413。每个样本记录 PID、RPS、总请求、
p50/p99、错误、timeout、非 2xx、前后内存；元数据记录代码和 fixture 哈希。
源码在完整矩阵内冻结；中止的两次探索运行不用于最终统计。

主指标是同轮比率的中位数，不是各组独立中位数相除；范围只是 5 个样本的 min/max，
不是置信区间。RSS 是采样时快照，不是峰值或强制 GC 后存活量，不能单凭它证明无泄漏。
同机测量仍可能受后台负载、JIT 和客户端上限影响，不外推成所有部署都稳定领先。

`middleware-3` 为两层路由级洋葱加一个 handler，不冒充全局链结论。本轮将 Bun Hono
fixture 从 app.use 注册改为与两套 Keala/Node Hono 相同的路由级注册。
`json-body-safe` 仅比较声明长度请求的读前/读后字节检查；Hono fixture 全量读取后才
检查实际字节，没有 Keala 的 chunked 缓冲上限，不能据此证明完整安全语义等价。

### 6.1 最终原始数据与结果

原始数据：[Node JSONL](./bench/r4-5-contract-node.jsonl)、[Bun JSONL](./bench/r4-5-contract-bun.jsonl)。
两运行时均为 90 个完整样本、6 个场景；合计 145,000,236 个完成请求，测量中的
errors / timeouts / non2xx 全为 0。两组源码指纹完全一致：
`70d3c1f04f77282c9f63a068a60b27a2120054c4badd536a3f575288693b947f`。

下表相对值均为每轮配对比率的中位数；正数越大越快。p99 列为 Keala/Hono，单位 ms。

| runtime | 场景           | 相对 Hono | 相对修复前 3c4347f | p99 |
| ------- | -------------- | --------: | -----------------: | --: |
| node    | probe-scoped-3 |     13.7% |              -0.7% | 2/2 |
| node    | text           |      5.1% |               1.7% | 2/2 |
| node    | json           |      4.6% |               1.3% | 2/2 |
| node    | param          |     13.1% |              -1.3% | 2/2 |
| node    | middleware-3   |     32.6% |             -18.5% | 3/4 |
| node    | json-body-safe |     15.6% |               1.1% | 3/3 |
| bun     | probe-scoped-3 |      8.4% |               5.9% | 1/2 |
| bun     | text           |     -0.1% |               1.5% | 1/1 |
| bun     | json           |      3.7% |               0.5% | 1/1 |
| bun     | param          |      1.7% |               0.6% | 1/1 |
| bun     | middleware-3   |      2.3% |              -0.5% | 2/2 |
| bun     | json-body-safe |      0.2% |              -0.4% | 2/2 |

### 6.2 结论与未达项

- Node 六场景的配对中位数均超过 Hono；但这是本机、固定 payload 与所列条件下的结果。
- Bun 文本 −0.1%、JSON body +0.2% 都应判为持平，不能包装成“整体超过 Hono”。
  Bun middleware 的单轮方向也有交叉；多数场景没有达到原定 +10% 目标。
- 相对修复前，多数路径在持平附近，本轮不主张新的整体吞吐提升。Node middleware
  明确下降 18.5%，五轮比率均低于 1；原因是自定义 init 的标准化、快照和原生 Response
  构造成本。旧版这一路径漏掉了本轮确认的语义，不能把撤销守卫当作优化。
- 所列 p99 中位数未劣于 Hono；瞬时最大延迟及内存快照见原始记录，不由中位数推出
  任意流量下的尾延迟保证。Bun JSON body 也可能受单进程 load generator 上限影响。
- R4.4→R4.5 同负载“至少 3 倍”、匹配的全局链、完整 chunked 安全语义及跨机器稳定
  领先仍无本轮达标证据；R4.5 不标记整体已核销，也不称为数学最优算法。

下一轮的具体验证方向是默认 status 的带头计划：构造时用原生 Headers 取得私有的已验证
快照，但不提前构造完整 body Response；首次公开 headers/body/clone 观察时再物化唯一
原生所有者。必须先锁定早抛错、参数转换、快照、live headers、clone/locked、错误分帧及
Bun 类型差异，再证明带头链恢复吞吐。这是尚未实现的研究方向，不是本轮已有性能收益。

复现实验（baseline 指向 `3c4347f` 的独立 checkout，并安装同版本依赖）：

```sh
KEALA_BENCH_BASELINE=/path/to/baseline KEALA_BENCH_OUTPUT=/tmp/new-node.jsonl node bench/run-node-hotpaths.mjs 200 5 5
KEALA_BENCH_BASELINE=/path/to/baseline KEALA_BENCH_OUTPUT=/tmp/new-bun.jsonl node bench/run-bun-hotpaths.mjs 200 5 5
```

输出文件采用排他创建，不会覆盖已有证据；中断时仅停止本次启动的服务进程。
