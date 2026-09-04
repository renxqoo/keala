# R4.9 — query/text 差距收口(0.7.1)

> 2026-09-04。目标:query(双运行时)与 text-Bun 两处落后于 Hono 的
> 场景。方法:进程内 ABAB 归因 → CPU profile 定帧 → 只修被证据指向的
> 帧。基线:0.7.0(c225bb7)。原始样本:docs/bench/0-7-1-*.jsonl。

## 1. 归因(先测后改)

进程内(工装 `bench/compare-hono-hotpaths.ts`,新增对称 `query` 用例,
fresh-process A-B-B-A ×3,取中位):

| 场景 | 运行时 | 0.7.0 K/H(进程内) | 结论 |
| --- | --- | --- | --- |
| text | Bun | **1.010** | 框架层持平 → wire −2.8% 在 serve/adapter 侧,非框架 |
| text | Node | 0.999 | 持平 |
| query | Bun | 0.864(keala 823ns vs 711ns) | 框架侧真实 +112ns |
| query | Node | **0.803**(4186ns vs 3362ns) | 框架侧 +824ns |

Node CPU profile(--cpu-prof,165k 请求)每请求自耗时 top:

| 帧 | ns/req | 判定 |
| --- | --- | --- |
| `setResponseHeader` | ~326 | 一个暂存头走完整校验链(正则+分支+null-proto 建) |
| `mergedHeadersOf`(sugar) | ~250 | 无 per-call 头时仍做 spread 拷贝 |
| `get querystring` | ~121 | JS 逐字符 charCodeAt 扫描 |
| `headersInitOf` | ~98 | undici Headers.set(webidl)地板,Hono 同付 |

三者合计 ≈730ns,对上 824ns 差距主体。**params 记录(null-proto)与
createContext 不在 top-22——计划中的两项修复被证据否决,未实施。**

## 2. 修复(全部有证据指向)

1. **头名校验 memo 化**(`utils/text.ts`):`validateHeaderName` 返回
   小写名,Map 命中跳过 toLowerCase+禁用集+正则;上限 512 条防动态名
   无界增长。headers.ts 两个调用点直接用返回值(顺带消掉 singleton
   跳过分支)。
2. **querystring 原生扫描**(`request.ts`):逐字符循环 → 两个
   `indexOf`(原生),语义逐条对齐(碎片内 `?` 不算查询、`#` 先于 `?`
   则无查询)。
3. **sugar 记录直用**(`sugar.ts`):无 per-call 头时直接把暂存记录当
   scratch(默认 content-type 写入记录本体),Response 建成后统一
   in-place 清空——每糖调用少一次 spread 分配。html 的 withType 拷贝
   同步消除。

## 3. 结果

进程内(Bun/Node):

| 场景 | 0.7.0 | 修复后 | Δ |
| --- | --- | --- | --- |
| query Bun | 0.864(823ns) | **0.933**(760ns) | −63ns |
| query Node | 0.803(4186ns) | **0.946**(3540ns) | **−646ns** |
| text Bun/Node | 1.010/0.999 | 1.023/1.032 | 不回吐 |

wire(R4.6 协议,200conn×4s×4 轮,vs 0.7.0 配对):

| 场景 | 运行时 | K/H | vs 0.7.0 | vs 0.6.2 累计 |
| --- | --- | --- | --- | --- |
| query | Bun | **0.977** | +5.5%(min +2.6%) | +~7% |
| query | Node | **0.891** | **+10.3%**(min +9.4%) | +~11% |
| text | Bun | **1.000** | +0.9% | 回到平 |
| text | Node | 1.053 | +0.8% | +5% |

**text-Bun 的 −2% 消失且无 text 专项改动**——与"代码布局/环境敏感带"
归因一致(布局随本次改动移位)。

修复后 profile:框架帧全部退出 top 榜,剩余为 undici Response
构造/体消费(_Response/webild/brandCheck/readablestream)——Hono 侧
同付的运行时地板。

## 4. 剩余与决策点

query 仍低于 1.0:Bun 0.977 / Node 0.891。分解:

- 进程内残差 ~5%:dispatch+context+query 读的合计,无单点帧可归因
  (profile 证实),属最后边际;
- Node wire 与进程内之差(0.891 vs 0.946):官方 fixture 里 keala 挂
  全局 body-parser 层(Hono 零中间件)的场景形状 + Node adapter
  wire 路径。

选项:(a)接受带内并记录(本文即记录);(b)对指定 query 类热路由走
`app.sink` 下沉(原生表直出,≥10% 无悬念)。

## 5. 门禁

verify(2286 测试,coverage 95.84/91.24/96.14/97.55)、test:bun
(2237)、build、smoke/example-check 全绿。
