# R4.7 pooling 双配置 A/B(切片 2')

> 状态:完成(2026-09-03)。缺陷修复(5916e40)+ 四腿矩阵(200M 请求)。
> 结论:修复消除了 wrapper 塌方与 Bun content-type 缺陷,但 pooling 在
> 双运行时仍为一致净退化(−20~−49pp),立项前提证伪,维持 opt-in 定位。
> 详见 §3/§4。
> 基线:152f0bb(fixture 开关接线)→ 首跑失败 → 修复 5916e40(重跑基线)。
> 用户裁决(2026-09-03):pooling 双配置都测并都披露;sink 结构切片暂缓,
> 先做高分辨力测量;缺陷定位后裁决"修复 pooling 后重测"。本文合并本切片的
> DESIGN / 缺陷记录 / 验收记录。

## 1. 设计契约

- 对照四腿:Bun/Node × 默认配置 / `KEALA_POOLING=1`,同一时段顺序执行;
  每腿内部仍按 R4.6 协议轮内交错 Keala/Hono 配对。Hono fixture 不读
  KEALA_POOLING,两腿 Hono 均为默认行为,充当漂移锚点。
- 配置证据:serverMetrics 恒报 `pooling` 布尔位,每个样本的
  beforeMetrics/afterMetrics 自带生效配置;校验器容忍旧 protocol-2 基线
  缺少该字段,非布尔值明确报错。runner 无改动(server 子进程继承编排环境)。
- 配对口径:K/H 比率为每腿内部轮内配对中位数;pooling 效果的判定为
  「pooled 腿 K/H」减「default 腿 K/H」,不以跨窗绝对 RPS 相除。两配置
  两行结果都披露,不挑选较优行。
- pooling 是 keala 既有 opt-in 特性(`new Keala({ pooling: true })`,
  dead-proto 退役防护,测试覆盖),Hono 4.13.5 无对应配置。该不对称性
  在结果表中显式披露。
- ~~函数级先验:pooling 直接消除 createBoundContext 的 25.1% 采样项,
  是预期效果唯一远大于噪声下限的 fetch 路径杠杆。~~ **已被首跑证伪并修正**,
  见 §1.1。
- 正确性门:fixture 六端点在 pooling 下的手工冒烟(含 413/400/HEAD、
  400 并发混合突发)全对;四门与既有 2000+ 双运行时测试不变。

### 1.1 首跑失败与缺陷记录(2026-09-03,基线 152f0bb)

首轮矩阵腿 2(Bun + KEALA_POOLING=1)在 verify 门禁失败(`wrong
content-type`),矩阵中止;腿 3/4 未运行。逐一定位出 `retireWithBody`
(src/core/context/pool.ts)的两个真实缺陷:

1. **正确性(仅 Bun)**:pooling 曾把每个带 body 的响应重包成消费追踪
   ReadableStream。Bun 对 `new Response(string)` 的 MIME 推断推迟到 serve
   时(response-plan.ts:24 注释),body 被流替换后推断失效——`/text`、
   `/users/:id` 返回 200 + **空 content-type**(`/json` 为 Response.json
   显式带头、`/mw` 显式 c.type,故幸免)。`rebuildCommitted`
   (respond.ts:158-169)对同一变换有恢复逻辑,retireWithBody 没有。
   Node 下 undici 构造即在 Headers 写 content-type,双运行时 2000+ 测试
   全绿仍漏掉——只有真 Bun.serve wire 断言能抓住。
   失败证据:[r4-7-pooling-bun-pooled-failed.jsonl](./bench/r4-7-pooling-bun-pooled-failed.jsonl)
   (10 样本,probe-scoped-3 五轮配对比率 0.235-0.238,K/H 0.24,
   28.5μs/req)。
2. **性能(双运行时)**:包裹使每响应走 ReadableStream + getReader +
   逐 chunk 异步 pull,摧毁双适配器直写快路径(Node 侧 wrapper 无 facts
   → writeStream 逐 chunk 循环)。text 场景量化:Bun 253k→60k req/s
   (4.0→28.5μs/req)、Node 140k→59k(7.2→17.7μs/req)。

归因实验(Bun text,单场景快测):wrapper 修复 60k→187k;回收槽清理
从 delete 改为按默认值赋值(避免字典模式)→195k;再拆双 proto swap
(纯诊断,已还原)→243k。即死防护本体(每请求两次 setPrototypeOf)
约 1.6μs/req、字典模式 delete 约 1.3μs/req——两者是 pooling 修复后
残余成本的构成,是否进一步优化属后续裁决,防护语义本轮不动。

## 2. 实施

### 2.1 fixture 开关(152f0bb)

- `bench/server-keala.ts` / `bench/server-keala-node.ts`:读取
  `KEALA_POOLING=1` 构造 `new Keala({ env: "production", pooling })`,
  metrics 端点上报生效值。
- `bench/server-metrics.ts`:载荷新增 `pooling` 布尔;校验器宽松可选。
- `test/server-metrics.test.ts`:新增一项。

### 2.2 缺陷修复(5916e40)

- 新槽 `directBodyResponseValue`(state.ts + CONTEXT_DEFAULTS):框架
  构造点(sugar 全出口、fromState 全出口、405/501、flag-128 重建)记录
  「body 为不可变快照(string/bytes/JSON 串/Blob)」的响应身份。
- `retireWithBody` 前置恒等快路径:命中即经既有 drainBranches 守卫立即
  退休、原样返回——不包裹、不读 `.body`(读真实 Response 的 `.body` 会
  破坏 Bun serve 时推断,实证约束)。流 body 与用户自建 Response 保留
  消费追踪包裹。
- 回收槽清理改为按 CONTEXT_DEFAULTS 赋值(delete 会入字典模式);
  INV-6 属性栅栏白名单内部槽位(值恒为哨兵默认),数据泄漏断言全部保留。
- 已知遗留(与 rebuildCommitted 同语义并已文档化):用户自建裸
  `new Response(string)` 在 pooling+Bun 下丢隐式 text/plain——不读
  `.body` 无法区分 string/stream;缓解为显式 content-type 或用 sugar。
- 测试:`test/pooling-wire.test.ts`(真 Bun.serve wire 奇偶校验,修复前
  红、修复后绿;Node native-source + pooling 首次有覆盖;流 body 包裹
  语义回归)、smoke pooling 腿(6 项)、INV-6 栅栏适配。
- 门禁:Node 118 文件 2065 pass / 9 skip,coverage 97.37/92.29/96.31/98.77
  (全项不低于修复前观测基线 97.35/92.20/96.29/98.74);Bun 118 文件
  2037 pass / 37 skip;fmt/lint/typecheck/build/smoke/soak/example:check/
  process:check 全过。

复现命令(输出路径须不存在):

```sh
KEALA_BENCH_PROCESSES=4 KEALA_BENCH_OUTPUT=<out> node bench/run-bun-hotpaths.mjs 200 5 5
KEALA_POOLING=1 KEALA_BENCH_PROCESSES=4 KEALA_BENCH_OUTPUT=<out> node bench/run-bun-hotpaths.mjs 200 5 5
KEALA_BENCH_PROCESSES=4 KEALA_BENCH_OUTPUT=<out> node bench/run-node-hotpaths.mjs 200 5 5
KEALA_POOLING=1 KEALA_BENCH_PROCESSES=4 KEALA_BENCH_OUTPUT=<out> node bench/run-node-hotpaths.mjs 200 5 5
```

## 3. 结果(基线 5916e40,2026-09-03 17:52–18:18)

四腿各 60 样本、合计 **200,975,073** 个完成请求;errors / timeouts /
non2xx 全零,pooling 位逐样本核验(pooled 腿 keala 全 true、default 腿全
false、Hono 全 false),最大启动偏斜 2ms,发压 CPU 峰值 71.5% 单核,
无容量警告。装置指纹四腿一致为 `59ae497e…`(152f0bb 起 server-metrics.ts
进入指纹集合,较 R4.6/slice-1 的 `11fec96b…` 变更,系配置证据接线所致,
runner 未动)。窗口为用户腾空机器后(本底负载 ~1.7–2.1),并挂 50ms 分辨率
墙钟-单调钟监视器全程零步进(累计漂移 ≤1.7ms)——此前两次矩阵尝试被装置
时钟门禁正确拦截(负载期墙钟步进 >2ms,环境性闪失,与被测代码无关),
仅完整矩阵计入本表。

原始数据:[Bun default](./bench/r4-7-pooling-bun.jsonl)(72,441,619 请求)、
[Bun pooled](./bench/r4-7-pooling-bun-pooled.jsonl)(62,700,950)、
[Node default](./bench/r4-7-pooling-node.jsonl)(35,345,767)、
[Node pooled](./bench/r4-7-pooling-node-pooled.jsonl)(30,486,737)。
K/H 为腿内轮内配对中位数,括号为五轮范围;Δpp = pooled − default。

| runtime | 场景           |         default K/H |          pooled K/H |   Δpp | RPS K def/pool(k) | CPU μs K def/pool |
| ------- | -------------- | ------------------: | ------------------: | ----: | ----------------: | ----------------: |
| Bun     | probe-scoped-3 |    +2.8%(+0.8~+4.2) | −22.3%(−23.4~−18.7) | −25.1 |     258.8 / 193.5 |       3.96 / 5.85 |
| Bun     | text           |    +1.8%(+0.5~+3.0) | −25.9%(−28.3~−24.4) | −27.7 |     269.4 / 200.0 |       3.80 / 5.67 |
| Bun     | json           |    +3.1%(+1.7~+4.9) | −24.2%(−24.7~−22.5) | −27.3 |     262.1 / 194.1 |       3.90 / 5.83 |
| Bun     | param          |    +1.1%(+0.6~+2.1) | −25.6%(−26.9~−25.0) | −26.7 |     263.6 / 196.0 |       3.89 / 5.80 |
| Bun     | middleware-3   |    +5.5%(+2.6~+6.7) | −27.6%(−28.9~−25.6) | −33.0 |     213.0 / 147.3 |       4.85 / 7.65 |
| Bun     | json-body-safe |    +4.5%(+3.2~+6.6) | −24.8%(−26.6~−22.1) | −29.2 |     199.5 / 144.2 |       5.16 / 7.74 |
| Node    | probe-scoped-3 |   +4.5%(+3.8~+11.0) | −15.5%(−22.0~−12.7) | −20.0 |     135.8 / 101.7 |      7.48 / 10.13 |
| Node    | text           |   +7.5%(+1.9~+13.0) | −21.6%(−22.5~−20.7) | −29.1 |     139.5 / 105.6 |       7.29 / 9.76 |
| Node    | json           |  +14.0%(+0.7~+16.0) | −21.3%(−21.8~−17.5) | −35.3 |     138.0 / 102.5 |      7.38 / 10.07 |
| Node    | param          |    +2.6%(−1.9~+7.0) | −21.0%(−24.3~−12.0) | −23.6 |     132.2 / 103.2 |      7.69 / 10.02 |
| Node    | middleware-3   | +68.6%(+66.0~+70.3) | +19.9%(+13.9~+23.0) | −48.7 |      100.5 / 69.3 |     10.16 / 14.98 |
| Node    | json-body-safe | +18.7%(+14.0~+28.1) | −14.2%(−16.7~−12.6) | −32.9 |      105.7 / 76.0 |      9.71 / 13.71 |

### 3.1 判读

1. **wrapper 修复被矩阵证实**:pooled 腿 Bun text 200k req/s,与首跑失败
   证据(60k)对照即修复效果;正确性核验(逐样本 content-type、六端点
   wire 奇偶)全过。
2. **pooling 是双运行时的一致净退化**:12 个场景-配置组合中,pooled 相对
   default 全部为负(−20.0~−48.7pp),五轮范围不与零相交。keala 服务端
   CPU/req 平均 +1.9μs(Bun)/+2.6μs(Node),与 §1.1 归因(死防护双
   proto swap ~1.6μs + 回归清扫)量级吻合。Node middleware-3 在 pooled
   下仍 +19.9%,只因 Hono 该场景本就慢 3 倍,不构成 pooling 的正面证据。
3. **切片 2' 的立项前提正式证伪**:pooling 节省的是 createBoundContext
   的每请求分配(切片 1 profile 25.1% 采样,≈1μs 量级),小于死防护与
   回收机制自身的运行时成本(≈2~3μs)。"pooling 是预期效果唯一远大于
   噪声下限的杠杆"在修复 wrapper 后不再成立——效果确实远大于噪声,
   方向为负。
4. 交叉窗口注意:default 腿的绝对 RPS(如 Bun text 269k)显著高于
   slice-1 窗口(168k),属机器腾空后的窗口差与 src 基线变化叠加,
   不构成任何增速宣称;本切片结论只依赖腿内配对与腿间 Δpp。
5. Hono 锚点稳定(双配置 Bun 249~~267k、Node 58~~135k),未见系统性漂移。

## 4. 后续

- **pooling 定位调整**:保持 opt-in,面向分配敏感的嵌入场景;不作为
  性能特性宣传,不进默认路径。文档与 README 表述如有"更快"措辞须修正。
- **若要 pooling 转正为净收益**:须重设计死防护机制(代际戳记等免
  proto-swap 方案,或接受防护语义弱化并独立裁决),预期可回收 ~1.6μs/req;
  立项须独立设计文档与安全语义审计,不在本切片范围。
- ~~若 pooling 效果落在噪声带内,加跑 10+ 轮高分辨力复测~~ 不适用:
  效果(−20~−49pp)远超噪声带,5 轮协议已足以分辨,无需加跑。
- sink 结构切片继续暂缓,不在本切片范围。
