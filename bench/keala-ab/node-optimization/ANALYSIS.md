# Node CPU 开销定位与优化

本轮相对优化前的配对中位数为：**吞吐 +12.7%，服务端 CPU/请求 −11.4%**。
p50 中位数保持 1 ms，p99 中位数保持 3 ms，没有稳定延迟改善的证据。
另做的迁移前对照仍有差距，不能宣称完全恢复迁移前性能。

## 原因与改动

迁移后的普通 Node 请求先构造 srvx `NodeRequest`，随后取出其原始 req/res，
再构造 Keala 已有的惰性请求源。简单响应则从 Keala 的响应计划转换为
`NodeResponse`，整理成原始头数组，最后调用 `write(body)` 和 `end()`。

Inspector profile 在预热后采样了相同 Hello World 处理器：迁移前的发送栈以
`writeUtf8String` 为主；迁移后出现 `writev` / `writevGeneric` 和
`_toNodeResponse`。优化后的最终源码采样中，Hello World 回到 `writeUtf8String`，
不再出现这条 `writev` 与 `_toNodeResponse` 路径。
这说明发送形式与重复包装是可避免的开销；采样比例不是严格的因果成本分摊。
带 profiler 的吞吐和 CPU 数值不参与正式 A/B 汇总。

实际只修改两个框架源码文件：

- `src/adapters/node.ts`：对 origin-form 请求复用 Keala 自己的惰性请求源，
  通过公开的 srvx Node server/handler 边界接入，避免构造后立即丢弃的 Request 包装。
  srvx 仍负责监听器创建、启动和关闭；非 origin-form 请求继续完整委托原 handler。
- `src/adapters/node-response.ts`：只对默认 200、未物化且没有响应头快照的私有响应计划，
  精确计算长度并用 `end(body)` 发送，避免第二次 Response/头数组转换和分散写入。
  流、显式头、非默认状态及已物化响应仍使用原准备逻辑和 srvx sender。

显式自定义 `http.ServerResponse` 时关闭 bare 发送优化，保留其 `write()` 转换、
预发送响应头等行为。仍保留 HTTP/1 默认 reason、HEAD、UTF-8 字节长度、
连接关闭、TE/CL、live Headers 快照、请求体上限、取消及 drain 契约。
准备异常仍进入 Keala 错误映射，物理发送异常仍保持原 silent send 分界。
没有修改依赖或屏蔽任何运行时保护。

## 正式 A/B

Apple M4 / 16 GiB，Node 26.9.0；200 总连接、4 个独立 Node 客户端，
每次预热 1 秒、测量 8 秒，每组 10 对、每样本新进程，交替 AB/BA。
只注册 `GET /` 返回 `Hello World`。两份源码使用同一编译器、配置和依赖构建成 JS。
计算方式与上一轮相同，本轮只筛选 Node 运行时，没有修改计量窗口、阈值或样本筛选规则。

| 比较                      | 基线 req/s 中位数 | 优化后 req/s 中位数 | 基线 CPU ns/请求 | 优化后 CPU ns/请求 | 配对吞吐变化 | 配对 CPU 变化 |
| ------------------------- | ----------------: | ------------------: | ---------------: | -----------------: | -----------: | ------------: |
| 优化前 a18 → 优化后 05df  |           134,803 |             144,202 |            7,393 |              6,825 |       +12.7% |        −11.4% |
| 迁移前 ba68 → 优化后 05df |           140,729 |             127,009 |            6,892 |              7,642 |       −11.1% |         +9.5% |

绝对值分别取各组中位数；变化百分比是同轮比值的中位数，不能用两个绝对值直接相除代替。

| 比较            | 平均延迟中位数 ms | p50 中位数 ms | p99 中位数 ms | 各轮 p99 范围 ms |
| --------------- | ----------------- | ------------- | ------------- | ---------------- |
| 优化前 → 优化后 | 1.069 → 1.100     | 1 → 1         | 3 → 3         | 1–6 → 2–16       |
| 迁移前 → 优化后 | 1.122 → 1.189     | 1 → 1         | 3.5 → 4.5     | 2–6 → 2–12       |

延迟来自毫秒量化直方图，平均值小数及偶数轮次的分位数中位数不代表额外测量精度。

第一组 7/10 对吞吐增加，8/10 对 CPU/请求下降；两种先后顺序的汇总改善方向一致。
主机一分钟负载为 6.34–8.94，前几对存在明显波动。第一组说明本轮相对优化前有改善，
不能把 +12.7% 当作所有环境、所有路由的保证。

第二组负载为 7.35–13.86，顺序和时段效应更明显：

| 比较            | 测量顺序       | 配对吞吐变化 | 配对 CPU/请求变化 |
| --------------- | -------------- | -----------: | ----------------: |
| 优化前 → 优化后 | before → after |       +16.7% |            −14.0% |
| 优化前 → 优化后 | after → before |        +4.7% |             −6.5% |
| 迁移前 → 优化后 | before → after |       −16.9% |            +16.3% |
| 迁移前 → 优化后 | after → before |        +0.4% |             +0.8% |

第二组前五对的配对中位数接近迁移前，后五对明显更差。所有有效慢样本均保留，
不能把坏值删除，也不能将差距全部归因于系统噪声。现有数据尚不能证明完全恢复迁移前性能。

两组合计 **40 个正式样本、40,862,170 个测量请求**，错误、超时、非 2xx、正文不匹配及计时拒绝均为 0。
客户端最高单核 CPU 分别为 47.55% / 67.94%，启动偏差最高为 2 / 4 ms，未触发客户端瓶颈标记。

## 行为验证

新增 11 个真实 HTTP 用例，覆盖 UTF-8/孤立 surrogate、空正文、字节正文所有权、
HEAD、keep-alive、drain、absolute-form，以及自定义响应类的 reason、发送失败、
提前发送响应头、正文转换。后两处兼容问题在初版优化中由测试明确复现失败，修正后通过。

最终版本的实际检查结果：

- Typecheck / build / format / lint 通过，原有 lint warnings 保留。
- Node 全套：176 文件通过，1 文件条件跳过；2,959 测试通过，16 跳过。
- Node 覆盖率：statements 95.54%、branches 91.26%、functions 96.17%、lines 97.34%；原有全局 90% 门槛通过。
- Bun 1.4.4 全套：175 文件通过，2 文件条件跳过；2,888 测试通过，87 跳过。
- Bun smoke/examples、Node/Bun × source/dist 进程检查、Node runtime contracts 通过。
- Node/Bun 两套内存 soak 通过，未修改 1500 B/请求预算。
- 独立只读审查及统计复算通过；包括 CPU 快照差值、延迟直方图、配对比值及源码/归档摘要。

完整日志保留在本地 `validation/` 目录，按仓库的 `*.log` 规则不纳入版本控制。没有改变测试阈值或弱化断言。

## 原始资料与复现

- [优化前后报告](REPORT.md)、[优化前后原始数据](results.json)。
- [迁移前对照报告](../node-optimization-vs-premigration/REPORT.md)、[其原始数据](../node-optimization-vs-premigration/results.json)。
- [诊断 profile 汇总](profile-summary.json)、[迁移前 profile](profiles/premigration.cpuprofile)、
  [优化前 profile](profiles/unoptimized.cpuprofile)、[优化后 profile](profiles/optimized.cpuprofile)。
- 两个报告目录均保存 before/after 源码归档及 SHA-256；优化前为 `a18ed34…`，
  迁移前为 `ba68e9e…`，优化后为 `05df8d2…`。归档对应包含未提交修改的工作区快照，不能只用 Git HEAD 代替。

按 [A/B 说明](../README.md) 解压源码归档，使用 `KEALA_AB_RUNTIMES=node` 和全新的输出目录复现：

```sh
KEALA_AB_RUNTIMES=node KEALA_AB_OUTPUT=/tmp/keala-node-opt-repeat \
  node bench/keala-ab/run.mjs /path/to/extracted/before 200 8 10 4
```

`KEALA_AB_AFTER` 可指定解压后的优化版源码目录。诊断采样可单独运行：

```sh
node bench/keala-ab/profile.mjs /path/to/compiled/snapshot /tmp/sample.cpuprofile
```
