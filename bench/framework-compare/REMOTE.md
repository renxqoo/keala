# 在共享 Linux 服务器运行

`pack-remote.mjs` 在本地打包已编译的 `dist`、现有 HTTP 场景和负载工具，以及当前安装的 67 个依赖包。服务器不构建、不安装 npm 包、不使用 Docker。`remote-run.mjs` 复用 `server.mjs`、`scenarios.mjs`、`load-pool.ts` 和原报告生成器。

本次服务器是 `ssh wr`：2 vCPU、约 2 GiB 内存、Ubuntu 24.04 x86_64。服务器已有 Bun 1.4.4，Node 26.9.0 从官方发行包在本地准备，并验证官方 SHASUMS256。缺少的 `libatomic.so.1` 从 Ubuntu 对应的 libatomic1 包在本地提取，验证服务器 APT 元数据提供的 SHA512，通过私有 `LD_LIBRARY_PATH` 使用，没有修改系统软件包。

## 本地准备

```sh
npm run build
node bench/framework-compare/pack-remote.mjs /tmp/keala-upload/bundle
```

输出目录必须尚不存在。加入目标 Linux 架构的 `runtime/node` 和所需私有动态库后，在本地压缩；macOS 打包时使用 `tar --no-xattrs --no-acls`，避免 Linux tar 的扩展属性警告。上传到远端新建的独立临时目录，核对压缩包 SHA256，再解压并立即删除上传的压缩包。

不要把本地 macOS 的 Node 可执行文件上传到 Linux。`manifest.json` 记录 Git 提交、未提交文件清单、构建与测试工具摘要、全部依赖版本。运行前确认目标目录中的 Node 和 Bun 身份。

## 运行约束

必须使用独立的 `keala-bench-*` systemd transient service / cgroup v2；脚本读取并验证实际配额，未正确设置则拒绝执行。每次只运行一个服务进程和一个负载进程，仅监听 `127.0.0.1` 的系统分配端口。

本次 service 属性：

- `CPUQuota=150%`、`CPUWeight=1`、`Nice=15`，合计最多使用 1.5 核，包含客户端与协调进程。
- `MemoryHigh=512M`、`MemoryMax=640M`、`MemorySwapMax=0`。
- `TasksMax=128`、`IOWeight=1`、`IOSchedulingClass=idle`。
- `OOMPolicy=stop`、`KillMode=control-group`、`TimeoutStopSec=5`。
- 正式测试 `RuntimeMaxSec=1800`；试跑 `RuntimeMaxSec=180`。
- 环境：`NODE_OPTIONS=--max-old-space-size=128`、`UV_THREADPOOL_SIZE=2`、私有 `LD_LIBRARY_PATH`、`BENCH_BUN` 和全新的 `BENCH_OUTPUT`。

例如，由 `systemd-run --collect --unit=keala-bench-... -p ...` 启动以下命令：

```sh
/usr/bin/env NODE_OPTIONS=--max-old-space-size=128 UV_THREADPOOL_SIZE=2 \
  LD_LIBRARY_PATH=/tmp/keala-upload/bundle/runtime \
  BENCH_BUN=/usr/local/bin/bun BENCH_OUTPUT=/tmp/keala-upload/results \
  /tmp/keala-upload/bundle/runtime/node \
  /tmp/keala-upload/bundle/bench/framework-compare/remote-run.mjs
```

上述环境命令本身不提供 cgroup 约束，必须先通过带上述属性的 systemd service 启动。不要直接运行或省略配额。

先加 `--pilot`：10 连接、1 秒测量、1 轮、仅 Hello World，验证所有 6 种组合。`--verify-only` 只运行 HTTP 正确性和 CPU IPC 检查。正式默认 50 连接、3 秒测量、3 轮、单负载进程，前置 132 项 HTTP 检查；每次预热 1 秒，采样之间休息 500 ms，每次重新启动服务，交错并轮换框架顺序。

每秒记录主机可用内存、cgroup 内存/CPU/任务数、内存压力与系统负载。可用内存低于 384 MiB、cgroup 当前用量超过 560 MiB、发生 OOM、任务数超过 110 或一分钟负载超过 3.5 时停止。正文、状态码、超时等失败立即停止；仅按原工具规则重试无效计时，并保留拒绝记录。正常慢样本保留。

## 结果解释与清理

这是资源受限且客户端共机的比较。CPU 配额或客户端可能限制吞吐，即使客户端 CPU 未达到 90% 也不能认定为服务端峰值。记录每个测量窗口的 cgroup 节流时间，报告 CPU/请求、中位吞吐、延迟和波动。12 条路由分别测量，汇总用几何平均，并非混合流量吞吐。

CPU 增量通过 HTTP 路径外的 IPC 获取，使用 `process.cpuUsage()` 的 user + system 除以完成请求数。窗口包含负载启动屏障与客户端结束清理。与本地旧结果的硬件、连接数、客户端数不同，不能直接计算版本性能变化。

完整结果每次采样后原子更新为 `results.json`，完成后生成 `REPORT.md`。取回结果、manifest、运行时摘要、配额、测试日志，以及前后服务 PID / OOM 计数。确认仅本次子进程全部退出，停止仍在运行的本次 systemd unit，再删除本次临时目录。禁止使用 `pkill node`、`killall bun` 等全局清理命令。保留本地证据，删除本地临时运行时、依赖副本和压缩包。
