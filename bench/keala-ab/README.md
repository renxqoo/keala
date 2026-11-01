# Keala 重构前后 Hello World A/B

本次实测：[完整报告](REPORT.md)、[原始数据](results.json)。

后续 Node 优化：[原因、改动、完整回归与两组同参数 A/B](node-optimization/ANALYSIS.md)。

```sh
node bench/keala-ab/run.mjs /absolute/path/to/before 200 8 10 4
```

参数依次为迁移前源码目录、总连接数、测量秒数、每运行时配对轮数、客户端进程数。
要求真实 Node 26 与 Bun 1.4.4。默认参数为 200 / 8 / 10 / 4。
使用 `KEALA_AB_AFTER` 可指定 after 源码目录，默认当前工作区；
`KEALA_AB_BUN` 可指定 Bun 二进制，`KEALA_AB_OUTPUT` 可指定全新的输出目录。
`KEALA_AB_RUNTIMES=node` 可只测 Node，默认 `node,bun`；
`KEALA_AB_DESCRIPTION` 可设置报告的对照名称，区分迁移前后和优化前后。
已有结果或源码归档不会被覆盖，重复运行应使用新的输出目录。

只验证四个版本/运行时组合的 HTTP 行为与 CPU IPC：

```sh
node bench/keala-ab/run.mjs /absolute/path/to/before --verify-only
```

仅验证模式默认把快照与记录写入独立临时目录，不覆盖正式结果。

两份源码先冻结到临时目录，使用当前工作区相同的编译器、构建配置及依赖生成 JS。
服务器只注册 `GET /` 并返回 `Hello World`，无中间件、pooling 或 sink；
CPU 快照通过冷 IPC 读取，不添加 HTTP 指标路由，也不在请求处理器里插桩。
每次采样均创建新的服务器和客户端进程；预热 1 秒后同步开始测量。
每轮同一运行时的 before/after 背靠背测量，奇偶轮交换 AB/BA，运行时首发顺序也交换。
测量请求逐个验证正文，HTTP 错误、超时、非 2xx 或不匹配直接中止。
仅对既有时钟窗口校验或客户端启动偏差超限的整对样本重试，最多三次；
已完成但失去配对的样本保存在拒绝记录中，所有有效的慢样本均保留。

CPU/请求是服务端进程 user + system CPU 增量除以完成请求数，包含传输、框架和 GC，
不包含客户端 CPU。快照窗口还包含开始屏障与客户端收尾，不是单独处理器的 CPU 时间。
延迟合并客户端直方图后计算；报告的延迟列是各次测量统计量的中位数。
变化百分比使用同轮 after/before 的配对比值中位数，不使用两个独立中位数之比。
客户端达到单核 90% 的样本会标记，不作自动删除。

输出 `REPORT.md`、`results.json`、`before-source.tar.gz`、`after-source.tar.gz`。
JSON 包含源码和归档摘要、原始 CPU 快照、各客户端结果、负载与执行顺序。
两份源码归档可用于精确复现，解压到不同目录后重新运行：

```sh
mkdir /tmp/keala-ab-before /tmp/keala-ab-after
tar -xzf bench/keala-ab/before-source.tar.gz -C /tmp/keala-ab-before
tar -xzf bench/keala-ab/after-source.tar.gz -C /tmp/keala-ab-after
KEALA_AB_AFTER=/tmp/keala-ab-after KEALA_AB_OUTPUT=/tmp/keala-ab-repeat \
  node bench/keala-ab/run.mjs /tmp/keala-ab-before 200 8 10 4
```

测试比较整个迁移及随附修复。两份快照包含未提交改动，不能只凭 Git HEAD 复原；
归档中不含 node_modules，复现仍使用本仓库锁定的工具与依赖。
