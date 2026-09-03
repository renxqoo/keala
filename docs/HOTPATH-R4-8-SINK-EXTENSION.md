# R4.8 原生路由表下沉扩展(切片 3':函数 handler + 中间件透明性声明)

> 状态:完成(2026-09-03)。实现 56b235d,fixture 开关 6ac1dfa,
> 六腿矩阵 415,517,469 请求零错误。Bun 侧:sunk 场景 K/H +6.8%(fn)/
> +9.6%(静态),均为真实增益(五轮范围不与零相交);Node 镜像大幅劣化
> (fn −43%/静态 −35%),下沉是 Bun 原生优化、Node 部署不应开启。
> 用户裁决(2026-09-03):立项;错误契约=排除映射器+双向拒绝;
> 首轮矩阵 param+text 两配置。本文合并设计/镜像语义审计/验收记录。

## 1. 设计契约(批准计划要点)

- **函数下沉**:`app.sink(path, handler)`,签名
  `(request, params) => MaybePromise<Response>`——无中间件/Context/sugar
  (该消除即收益),双运行时同签名;仅静态+纯 `:param` 段(拒绝
  optional/正则/通配/含 `%` 路径);GET 作用域 `{GET: wrapper}`,非 GET
  落 fetch→405+Allow(HEAD 复用 GET,探针证实原生表 HEAD 剥 body 且
  CL 精确)。
- **错误契约(裁决)**:原生包装器接住一切失败走 `sunkErrorResponse`
  (内置 funnel 的上下文无关提取:exposed 4xx/隐藏 5xx/HEAD 无 body);
  探针实证 Bun 对非 Response 返回答 200 帮助页、对抛错走 serve error
  (纯 500)——包装器为硬需求。`app.sink(path, fn)` 与 `app.onError()`
  双向拒绝(映射器契约基于 Context)。
- **透明性声明 `noOpFor(fn, {methods?, bodyless?})`**:作者证明义务
  (框架不可验证),WeakMap 旁挂(conditionalMeta 先例);四门同步豁免
  (middlewareConflictForPath 增方法集/registerMiddleware 两守卫/param
  门不放宽);镜像照常运行被声明层——谎言只在原生腿可观察。
  bodyLimit 为试点声明(无 body 请求分支确证无操作)。
- **先修缺陷**:B1/B2(参数模式被当 middleware scope 编译抛错类型)
  、B3(参数-字面遮蔽不可见)——`patternsOverlap`(pattern.ts,保守:
  静态相等/任一侧动态兼容/通配零或多/optional 折叠)与 pathsConflict
  并联接入双守卫。
- **对拍差分(DESIGN P3 出口门,首次落地)**:L1 镜像 vs 纯 JS 孪生
  (native-sink-parity.test.ts,16 行语料×4 方法,双门禁);L2 真
  Bun.serve 原生表 vs 预测 + L3 nativeRoutes:false(smoke,15 项)。
- **探针实证(Bun 1.4.0)**:HEAD 行为、静态自动 ETag/304(原生独有,
  记台账)、参数解码(unicode/数字/%2F 解码一致;malformed 原生 U+FFFD
  vs 镜像原样——台账)、params 双端 null 原型(verbatim 即奇偶)、
  maxRequestBodySize 不约束表内路由(bodyless 残余,台账)。

## 2. 实施清单(56b235d)

src/router/pattern.ts(patternsOverlap)、router.ts(registerDef 守卫)、
core/middleware-stack.ts(noOpFor/noOpExcuses/四门/SinkGuardSpec)、
core/sink.ts(SunkHandler/NativeFnSink/注册分支/镜像/nativeFnRoute/
sinkGuardSpecs)、core/error-response.ts(sunkErrorResponse)、
app.ts+application.ts+types+index(签名/导出/onError 反向守卫)、
middleware/limits.ts(bodyLimit 试点声明)、adapters/bun.ts 不变
(buildNativeRoutes 内联包装)、examples/app.ts(fn sink 示例)。
测试:native-sink.test.ts 扩(守卫矩阵+单元契约,B1/B2/B3 回归)、
native-sink-parity.test.ts(L1)、smoke sink 腿(L2/L3,15 项含台账
定向断言)。

## 3. 质量门禁

| 门禁                                                            | 结果                                                                                                                                                   |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Node / Vitest + coverage                                        | 119 文件,2085 pass / 9 skip                                                                                                                            |
| coverage(stmts/branch/func/lines)                               | 97.27 / 92.34 / 96.40 / 98.75(基线 97.35/92.20/96.29/98.74:branch/func/lines 反超;stmts −0.08pp,系新增近全覆盖代码的分母效应,未覆盖语句集中于既有文件) |
| Bun / Vitest                                                    | 119 文件,2057 pass / 37 skip                                                                                                                           |
| fmt / lint / typecheck / build                                  | 通过                                                                                                                                                   |
| smoke(含 L2/L3 sink 对拍)/ soak / example:check / process:check | 通过                                                                                                                                                   |

## 4. 测量(基线 6ac1dfa,2026-09-03 19:22–20:01 + 补跑腿)

六腿:Bun/Node × default / KEALA_SINK=param(/users/:id 函数下沉)/
KEALA_SINK=text(全局 noOpFor(bodyLimit) + /text 静态下沉)。各腿 60
样本、合计 **415,517,469** 请求,errors/timeouts/non2xx 全零,sink 位
逐样本核验,最大偏斜 3ms,发压峰值 81.0% 单核无容量警告。装置指纹
`76d9a405…`(新代际:6ac1dfa 的 server-metrics sink 字段进入指纹集合,
runner 未动,152f0bb 同款披露)。全程 50ms 分辨率时钟监视零步进;两腿
被时钟门禁正确拦截后重试,一次分析者前台调试污染了 bun-default 首跑
(已识别、整腿重跑替换,本表为干净数据)。

原始数据:[bun-default](./bench/r4-8-sink-bun-default.jsonl)(70,959,676)、
[bun-param](./bench/r4-8-sink-bun-param.jsonl)(72,755,423)、
[bun-text](./bench/r4-8-sink-bun-text.jsonl)(70,582,451)、
[node-default](./bench/r4-8-sink-node-default.jsonl)(34,566,032)、
[node-param](./bench/r4-8-sink-node-param.jsonl)(33,728,588)、
[node-text](./bench/r4-8-sink-node-text.jsonl)(33,264,299)。

### 4.1 Bun:下沉场景(核心表)

| 腿             | 场景      | K/H 配对中位数 |   五轮范围 |        RPS K/H(k) |      CPU μs K/H |
| -------------- | --------- | -------------: | ---------: | ----------------: | --------------: |
| default        | text      |          +0.9% |  −1.1~+1.2 |     264.9 / 263.0 |     3.86 / 3.91 |
| **sink-text**  | **text**  |      **+9.6%** | +8.1~+11.0 | **293.8** / 268.2 | **3.42** / 3.83 |
| default        | param     |          +1.7% |  +0.2~+2.6 |     259.2 / 254.7 |     3.95 / 4.05 |
| **sink-param** | **param** |      **+6.8%** |  +4.6~+9.5 | **278.5** / 260.8 | **3.68** / 3.96 |

下沉效果(腿间 Δ):text **+8.6pp / kealaRPS +10.9% / CPU −12.9%**;
param **+5.1pp / +7.4% / −7.4%**。非下沉场景在 sink-param 腿 ±1.3pp
(配置未变,跨腿漂移量级);在 sink-text 腿系统性 −8.4%(见 §4.3)。

### 4.2 Node:镜像代价(对照发现)

| 腿         | 场景  |                                               K/H | RPS K(k) | CPU μs K |
| ---------- | ----- | ------------------------------------------------: | -------: | -------: |
| default    | text  |                                            +10.7% |    138.5 |     7.35 |
| sink-text  | text  |                                        **−35.1%** |     80.9 |    12.71 |
| default    | param | +4.0%*(范围 −17.0~+217.8,一轮 Hono 异常,中位数稳) |    122.6 |     8.12 |
| sink-param | param |                                        **−43.0%** |     68.7 |    14.96 |

Node 适配器不消费 nativeSinks:静态镜像逐命中 rebuild(fn sink 镜像则
逐命中 `sourceRequest` 物化完整 Request),CPU +4.5~+6.8μs/req。非下沉
场景在 Node sink 腿 −0.5~−5.4pp(跨腿漂移,配置等价)。

### 4.3 判读

1. **下沉效果真实且远超噪声**:两个 sunk 场景的五轮范围全正,Bun 侧
   静态下沉 +10.9% kealaRPS 是 R4.x 系列迄今最大单项杠杆;keala text
   以 +9.6% 逼近 R4.5 的 10% 线(param +6.8%)。Hono 锚点全程稳定
   (Bun 246~268k),增益非锚点漂移。
2. **fn 下沉收益小于 58% 采样预估**:剩余成本=handler 自身的
   `new Response`+字符串拼接(与 sugar 等价)与 Bun 原生表→JS 回调的
   过渡;CPU 仅 −0.27μs(3.95→3.68)。静态下沉(CPU −0.44μs,免
   per-request 构造)印证地板在 Response 构造,不在框架 JS——与
   R4.7 归因一致。
3. **noOpFor 的镜像成本**:sink-text 腿非下沉场景 −8.4%(CPU
   +0.44μs)——镜像照常运行全局 bodyLimit。透明性声明对原生腿免费,
   对 JS 腿仍是普通中间件;应作用域化使用而非全局化(本腿为测门而
   全局化,已如实计量)。
4. **Node 侧定位**:下沉是 Bun 原生优化;Node 镜像的物化/重建使 sunk
   路由慢 ~1.7-2.0x。Node 部署不应启用下沉;镜像快路径(sourceRequest
   免物化、静态 rebuild→planned response)列为后续切片候选。
5. **R4.5 整体目标仍未核销**:非下沉场景 +1~+5%;下沉能对选定热路由
   再取 +5~+9pp,但"所有场景稳定超 10%"需要组合(下沉热路由 +
   其余场景的既有领先)且各场景分别达标,当前差 text/param 外的量。

## 5. 后续

- Node 镜像快路径(fn 免物化/静态免 rebuild)——独立小切片,
  预期回收 Node sunk 腿大部分差距;不改变 Bun 结论。
- 多方法 map 下沉(类型已收、注册拒)与 HTMLBundle/BunFile 值:
  维持出界(D8)。
- sink 热路由组合策略(哪些路由值得下沉)与 R4.5 收官路径:
  待用户裁决是否立项。
- 1000 路由规模警示(BENCH.md:表查询输给 trie)仍然成立——下沉是
  少数热路由的精准杠杆,不是规模化方案。
