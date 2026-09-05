# route-shootout Linux 服务器诊断 — 静态形状 0.93-0.95x 的分层归因

> 2026-09-05,`wrr@192.168.31.149`(8 核 x86_64, 7.1G, bun 1.4.2 + node 26.8.1,
> 无 go)。起因:该机器全量实测(bench/route-shootout/REPORT.md)静态形状
> keala(bun) 0.93-0.95x、wildcard 0.92x,与 Mac 安静窗口结论(静态
> 1.00x)矛盾。本文用六层判别实验把差距归因到底。

## 结论(TL;DR)

1. **静态形状的 HTTP 0.93-0.95x 不是 keala 代码问题**。每层隔离测量
   (路由/管线/适配器)keala 都**快 18-28%**;HTTP 层的中位差落在该机器
   ±5% 的配对 IQR 噪声带内。
2. 该机器每轮(runa 3-8s)吞吐在 ±20% 内翻转、有节流式下漂(首发轮
   ~100-105k,后续 72-86k),ABAB 双侧中位比值被漂移偏置;配对比值的
   "赢家"逐轮互换(keala 94.0k vs hono 89.7k/94.4k 的复跑即直接证据)。
3. 真实且可复现的结构差只有一条(已知、有记录):**动态形状路由层
   keala trie 走访 vs hono 整表预编译 regex,隔离比值 ~1.9x(本机
   ~100ns/请求,Mac ~40-50ns),HTTP 稀释后 ≤3%**——R413 bucket-regex
   的已知边界(shootout 的 event/user-lookup 桶共享多动态定义,不合格)。
4. bun `--cpu-prof` 的自耗时归因在内联存在时**不可信**:profile 显示
   `splitPathSearch` 占服务器 28.6%,插桩计数证实每请求恰好调用 1 次
   (~50ns 函数),属采样器把调用点周围的内联代码计入了该帧。

## 六层判别证据

| 层                            | 工具                         | 静态形状 keala/hono           | 判定     |
| ----------------------------- | ---------------------------- | ----------------------------- | -------- |
| 路由隔离                      | `diag/router-micro.ts`       | **0.72x**(12.1 vs 16.7ns)     | keala 快 |
| 管线(复用 Request)            | `diag/pipeline-micro.ts`     | **0.80x**(473 vs 591ns)       | keala 快 |
| 管线(新鲜 Request 环)         | `diag/pipeline-fresh.ts`     | **0.75x**(495 vs 660ns)       | keala 快 |
| 适配器(真实 serve fetch 闭包) | `diag/adapter-fresh.ts`      | **0.82x**(Δ −110ns)           | keala 快 |
| Bun.serve 选项(error/ws)      | `diag/serve-option-cost.mjs` | +ws/plain 配对中位 **1.009x** | 无成本   |
| HTTP 安静窗口                 | `diag/recheck-dynamic.mjs`   | 0.92-1.05x(逐轮翻转)          | 噪声带内 |

动态形状在管线/适配层为 0.98-1.08x(路由 ~100ns 差被更快的
context/dispatch 抵消大半),与 R413 后 Mac 结论一致。

## 方法论要点(复用)

- **管线微基准必须用新鲜 Request 环**:`pipeline-micro.ts` 复用同一
  Request 对象,按对象缓存的解析全部命中,会隐藏真实 HTTP 每请求支付
  的 URL 成本——`diag/pipeline-fresh.ts` 用 4096 个不同 host 的请求
  环修正这一点(两框架同付,差异测量仍公平)。
- **适配层可直接捕获**:`startBunServer` 的 `serveImpl` 可注入,用
  假 serve 捕获传给 Bun.serve 的 fetch 闭包,即可在不起网络的情况
  下对完整 serve 路径计时(`diag/adapter-fresh.ts`)。
- **这台机器上一切中位比值都要配对**:轮内背靠背 + 首发轮换 +
  配对比值取中位与 IQR(`diag/serve-option-cost.mjs`);跨轮中位相除
  会被漂移偏置(本文开头 0.905x 的 ws 伪影即此)。
- **bun --cpu-prof 只取方向不取数字**:89/125 个样本 + 内联归因失真;
  函数级结论用插桩计数或隔离计时核实。

## 遗留

- 内存:keala(bun) steady/peak 高 ~1-11MB,已定性为分配器 arena 随
  分配率增长(soak 证实有界,见 CHANGELOG 0.7.3),本机数据一致。
- 该机器噪声地板(±5% IQR)不足以分辨 <5% 的 HTTP 差异;要在此精度
  下比较,需独占机器 + 锁频,或以分层隔离测量为准。
