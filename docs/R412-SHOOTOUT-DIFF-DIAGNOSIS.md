# R412 诊断:route-shootout 两项差异的根因(2026-09-05)

> 输入:`bench/route-shootout/REPORT.md` 首轮两个疑点——
> (A) mixed `/event/:id/comments` 场景 hono 领先 12-14%;
> (B) Node 腿 keala idle RSS 比 hono 高 ~17MB。
> 方法:只测不改。五件诊断工具落在 `bench/route-shootout/diag/`,
> 每个结论都有对应工具的输出背书。
>
> **后记(同日,R413 已实施)**:疑点 A 的候选修复 1+3(整表 regex /
> bucket 形状扩展)以"bucket-regex 快速层"落地(0.7.3,见 CHANGELOG):
> 进程内动态形状从 1.49-1.79x 慢翻转为 **1.09-1.14x 快**,HTTP 层
> 满跑 mixed 1.00x(±2%)/其余 0.97-1.11x 全平局、keala≈raw
> Bun.serve,且轮间方差从 ±22-52% 收紧到 ±1-3%;红队随机表差分在
> 实施过程中当场抓获的快速层边界 bug 一共四个(通配滑过字段检
> 查、纯静态空泛合格、尾斜杠捕获多一个 `/`、混合桶通配遮蔽未编译
> 模式),全部由红队差分/优先级锁当场抓获并修复——差分测试的价值
> 得到直接验证。尾部通配随后也进了快速层(纯桶兜底组),wildcard
> 场景安静窗口 1.00x。
> 疑点 B 的两条建议(harness 改 dist / 收窄 core 图)未实施,维持
> 低优先。

---

## 结论速览

| 疑点                       | 结论                                                                                                                                                                                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. mixed 场景 hono +12-14% | **HTTP 层伪影**——安静窗口 + 静态对照组下全场景 0.97-1.00x(平局);原先 0.86-0.88x 是"首枪凹陷窗口"采样偏差。**但进程内存在真实结构差**:动态路由 keala 慢 1.49-1.79x(Δ117-198ns/req),被 Bun HTTP 栈的每请求 ~4.5µs 预算吸收(占 3-4%),平时不可见 |
| B. Node 腿 idle +17MB      | **~10MB 是测量形态税**:shootout 服务器直接 `import src/*.ts`,Node 类型剥离器内嵌 WASM(amaro)首导即 +8MB external + 共 ~37MB RSS。**发行形态(dist JS)下真实差仅 ~9.7MB**(更大 JS 图:heap 7.0 vs 3.7MB);适配器/listen 近零成本(+0.7MB)         |

---

## A. mixed 场景:三层分解

### A1. 修正 HTTP 层结论(测量伪影)

`diag/recheck-dynamic.mjs`(安静窗口,keala vs hono 双栈,4 轮交错,
带静态对照组):

```
mixed /event/:id/comments:   keala 235.6k  hono 242.2k  → 0.97x
4-seg /user/lookup/username: keala 199.7k  hono 204.4k  → 0.98x
static /user (对照):         keala 211.6k  hono 210.7k  → 1.00x
```

原先"mixed 稳定落后 12-14%"不成立:每个数据集的**第一枪双方都系统性
偏低**(JIT/GC 空转后回暖——keala [201k,236k,236k,232k] vs
hono [204k,206k,242k,243k]),中位数恰好落在凹陷窗口时就产出 0.88x。
同窗口、同方法的静态对照 1.00x 证明不是框架差。

### A2. 进程内真实结构差(伪影之下有真差)

`diag/pipeline-micro.ts`(无 HTTP/无客户端,`app.handle` vs
`app.fetch`,同一 12 路由表,200k×5 轮取中位):

| 形状         | keala |  hono |      比值 |      Δ |
| ------------ | ----: | ----: | --------: | -----: |
| static /user | 177ns | 188ns | **0.94x** |  −11ns |
| 4-seg param  | 449ns | 251ns | **1.79x** | +198ns |
| mixed        | 407ns | 244ns | **1.67x** | +163ns |
| param-only   | 353ns | 236ns | **1.49x** | +117ns |

**动态路由全形状落后 117-198ns,静态反而快 6%**——差异不是 mixed
特有,是所有"走 trie"的形状共有。

`diag/router-micro.ts`(路由器隔离,`matchRoute` vs SmartRouter
`.match()`,1M×5 轮)把 Δ 分成两半:

| 形状        | keala 路由 | hono 路由 |    路由 Δ | 管线 Δ | 非路由 Δ |
| ----------- | ---------: | --------: | --------: | -----: | -------: |
| static      |      4.0ns |     9.9ns |      −6ns |  −11ns |     −5ns |
| 4-seg param |    129.5ns |    48.8ns | **+81ns** | +198ns |   +117ns |
| mixed       |    129.3ns |    45.0ns | **+84ns** | +163ns |    +78ns |
| param-only  |    106.4ns |    40.7ns | **+66ns** | +117ns |    +51ns |

- **路由器差**:keala trie 匹配 106-130ns vs hono RegExpRouter 40-49ns
  (2.6-2.9x)。机制:hono 把**整张表编译成每方法一个 regex**,匹配 =
  一次 regex exec;keala 是运行时 trie 走访,每次匹配分配
  `splitSegments` 数组 + `Frame[]` 栈 + 每参数一个 `ParamLink` +
  `recordOf` null-proto 对象(4-5 个小对象/次 vs hono ~2 个)。
- **非路由差**(context/dispatch/respond):+51-117ns,keala 每请求
  的 context 创建 + dispatch + URL 预填充(`getPath`/`getSearch`)组成。

### A3. CPU 归因(`--cpu-prof`,5s 紧循环 × 1150 万次)

`diag/profile-loop.ts` + Bun `--cpu-prof`(自耗时占比):

```
20.1%  splitSegments [trie.ts]     ← 每匹配一次的 split 分配
18.4%  matchPattern [trie.ts]      ← 栈式走访
16.7%  Response                    ← 双方同付
12.1%  matchRoute [router.ts]      ← staticMap/fast 尝试/分发
 8.9%  getPath [url.ts]            + 3.8% getSearch(URL 预填充)
 7.2%  handle [app.ts]
 2.7%  decodeSegment + 0.4% recordOf + 0.3% pushVariant
─────────────────────────────────
≈54%   路由合计(splitSegments 一项就 20%)
```

### A4. 为什么主矩阵(BENCH.md)一直是平的?

快速匹配的启用条件(`router.ts` indexPattern):

- `state.fastDynamic`:**全表唯一**动态路由才启用;
- `bucket.fast`:**同首段桶内唯一**动态路由、且形状为
  "静态前缀 + 剩余全为参数段"才启用。

主矩阵的 param 探针 `/users/:id` 满足桶条件("users" 桶内唯一动态)→
`fastMatch` 一次 slice(~10ns)→ 平局。shootout 的 12 路由表里
`/event/:id`、`/event/:id/comments`、`POST /event/:id/comment` **共享
"event" 桶**(count=3)、`/user/lookup/*` 两条共享 "user" 桶(count=2)
→ **全部 fast 路径关闭,所有动态形状落到 trie**。另外
`/map/:location/events` 这种"参数后还有静态尾"的形状连桶 fast 都
不覆盖(fastMatch 的 parts/names 对不上,fallback 到 trie——
`diag/router-micro.ts` 里它 117.5ns,≈trie 价)。

### A5. 为什么 HTTP 层看不见?

Bun 腿 ~210-240k req/s ⇒ 每请求总预算 ~4.2-4.8µs,其中框架(非 HTTP
栈)部分 keala ~400ns / hono ~245ns;Δ163-198ns = 总预算的 **3-4%**,
在 ±10-30% 的 HTTP 噪声带内。Node 腿 ~90k ⇒ ~11µs 预算,更不可见
(与 shootout Node 全平一致)。

### A6. 风险定性

- **今天**:不构成 HTTP 层落后(所有可复测窗口均平)。
- **何时会浮现**:① CPU 已饱和的部署(框架份额上升);② Bun HTTP
  栈未来变快(预算缩小,固定 Δ 占比放大);③ 路由表继续变大
  (trie 走访变深、regex 不变);④ CPU 受限环境(容器限核)。
- **候选修复方向(均未实施,待立项)**:
  1. **整表 regex 编译**(hono 路线):注册期把每个桶/全表编译成
     regex,请求期一次 exec。静态路径保留 staticMap(已优)。
  2. **trie 无分配化**:`splitSegments` → 起止指针扫描(不建数组);
     `Frame[]`/`ParamLink` → 栈上索引/预分配复用。保留 trie 语义,
     预期把 129ns 压到 ~60-80ns。
  3. **bucket-fast 形状扩展**:覆盖"静态前缀 + 参数 + 静态尾"
     (`/map/:x/events`、`/event/:id/comments` 这类),桶内多路由时
     按(静态头,段长)分组。
  4. URL 预填充合并:`getPath`+`getSearch` 8.9%+3.8% 可合并为单趟
     切片(次要)。

---

## B. Node 腿 idle +17MB:测量形态税为主

### B1. 现象(shootout)

keala(node) idle RSS 97.5MB vs hono(node) 80.4MB,**但 heapUsed
几乎相等**(11.6 vs 11.9MB)——差值不在 JS 对象里。

### B2. 步进归因(`diag/node-memory.mjs`,单进程累积 + 隔离双进程)

```
bare node                       rss= 42.5  ext=1.7
+ hono app built                rss= 50.4  ext=1.7   (+7.9)
+ keala app (root barrel)       rss=100.9  ext=9.4   (+50.5 !)
+ keala listen (node adapter)   rss=101.6            (+0.7 — 适配器免费)
+ hono serve (@hono/node-server) rss=102.0           (+0.4)

隔离进程:KEALA 100.0/heap 11.1   HONO 59.8/heap 6.5
```

### B3. 模块二分(`diag/node-memory-bisect2.mjs`,每模块独立进程)

```
bare            ext=1.6   rss=41.9
hono(js)        ext=1.3   rss=48.0
utils/query.ts  ext=9.7   rss=63.7   ← 最小叶子也 +8.1MB external!
http/status.ts  ext=9.6   rss=63.4
router/trie.ts  ext=9.7   rss=67.7
core/app.ts     ext=9.3   rss=97.7
```

**任何** keala `.ts` 文件的首次导入都让 external 跳 +8MB——这是
Node 内建类型剥离器(amaro/swc)的 **WASM 引擎**实例化成本,
与模块内容无关。keala 以 `.ts` 源码跑 Node(strip-types)就付这笔税;
hono 发行的是编译后 `.js`,不付。

### B4. 发行形态对照(`diag/node-memory-dist.mjs`)——决定性证据

```
hono (compiled js)        rss= 48.1  heap= 3.7  ext= 1.3
keala SRC (.ts 剥离)      rss= 95.1  heap= 10.6 ext= 9.3
keala DIST (编译 js)      rss= 57.8  heap= 7.0  ext= 3.2
```

- **dist 形态下 keala−hono = +9.7MB**(不是 +17MB);
- 剥离器税 ≈ 95.1 − 57.8 ≈ **37MB**(WASM + 编译中间态 + 页);
- 真实框架差 +9.7MB 的构成:heap 7.0 vs 3.7(+3.3MB,keala 核心
  JS 图更大:context/路由/生命周期/协商机器)、external 3.2 vs 1.3、
  其余为 V8 页;
- **适配器与 listen 近零**(+0.7MB);helpers/cookies/根 barrel 全部
  近零——宽度不是问题,`core/app` 图本身就是主体。

### B5. 定性与建议(不实施)

- +17MB 里约 **10MB+ 是 shootout 服务器直接 `import src/*.ts` 的
  dev 形态税**(生产消费者 import 的是编译产物/包入口),真实框架
  机器成本 ~9.7MB,其中 ~3.3MB 是 JS 图。
- 建议①:`bench/route-shootout/servers/keala-node.ts`(及主矩阵
  `bench/server-keala-node.ts`)改 import `dist/`,让 Node 腿是
  生产代表形态——纯 harness 改动;
- 建议②:若要压真实框架差,方向是把 `core/app.ts` 依赖图收窄
  (协商/conditional 等按需 lazy),收益 ≤3MB,优先级低。

---

## 诊断工具清单(全部保留在 `bench/route-shootout/diag/`)

| 工具                   | 测什么                               | 运行                                                      |
| ---------------------- | ------------------------------------ | --------------------------------------------------------- |
| `router-micro.ts`      | 路由器隔离:matchRoute vs SmartRouter | `bun …/diag/router-micro.ts`                              |
| `pipeline-micro.ts`    | 进程内全管线 + Δ 分解                | `bun …/diag/pipeline-micro.ts`                            |
| `profile-loop.ts`      | CPU profile 目标(紧循环)             | `bun --cpu-prof --cpu-prof-dir …/diag/ …/profile-loop.ts` |
| `recheck-dynamic.mjs`  | 安静窗口 HTTP 双栈对照               | `node …/diag/recheck-dynamic.mjs`                         |
| `node-memory*.mjs`(×3) | Node 内存步进/模块二分/dist 对照     | `node --expose-gc …`                                      |

复现口径:微基准 5 轮取中位;HTTP 复核 4 轮交错 + 首枪计入(它就是
伪影来源,计入才能看见);内存采样前强制 GC。
