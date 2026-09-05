# route-shootout — 经典 12 路由表 × 6 栈对比

独立于 `bench/` 主矩阵的单场景集:一张固定的 12 路由表(短静态、
同基数静态、参数、混合、POST、深静态、通配),七个命名探针,
六个栈各实现一份**字节相同**的响应契约。

## 参赛栈

| 栈                                   | 服务器                  | 端口 |
| ------------------------------------ | ----------------------- | ---: |
| raw Bun.serve(运行时天花板,手写匹配) | `servers/raw-bun.ts`    | 4201 |
| keala(Bun)                           | `servers/keala-bun.ts`  | 4202 |
| keala(Node,keala/node 适配器)        | `servers/keala-node.ts` | 4203 |
| hono 4(Bun)                          | `servers/hono-bun.ts`   | 4204 |
| hono 4(Node,@hono/node-server)       | `servers/hono-node.ts`  | 4205 |
| go net/http(Go 1.22 ServeMux)        | `server-go/main.go`     | 4206 |

## 路由表与探针

```text
GET  /user                                 → "user"            (1) 短静态
GET  /user/comments                        → "user/comments"   (2) 同基数静态
GET  /user/avatar                          → "user/avatar"
GET  /user/lookup/username/:username       → 回显 username      (3) 4 段参数
GET  /user/lookup/email/:address           → 回显 address
GET  /event/:id                            → 回显 id
GET  /event/:id/comments                   → 回显 id           (4) 混合静态+参数
POST /event/:id/comment                    → "{id} comment"    (5) POST 混合
GET  /map/:location/events                 → 回显 location
GET  /status                               → "status"
GET  /very/deeply/nested/route/hello/there → "hello there"     (6) 6 段深静态
GET  /static/*                             → 回显后缀          (7) 通配
```

七个探针:`/user`、`/user/comments`、`/user/lookup/username/hey`、
`/event/abcd1234/comments`、`POST /event/abcd1234/comment`、
`/very/deeply/nested/route/hello/there`、`/static/index.html`。

通配契约:所有栈回显路径后缀 `index.html`(keala 用 `params.wildcard`
捕获,hono 的 `*` 未命名、从 path 切片,Go 用 `{rest...}`,raw 手写
切片)——输出字节相同,机制各自原生。

## 方法论(与 bench/run.mjs 同源)

- **ABAB 交错**:六服务器全部常驻,每轮内轮换首发顺序(顺序测量有
  高达 ±25% 的次序偏置,见 bench/analysis.md);
- **先验证后压测**:每个 服务器×探针 组合在加压前断言响应字节,
  "答得快但答得错"的栈进不了表;
- autocannon,4 个 client worker(单进程 ~177k req/s 就把客户端自己
  打满,所有栈被压平成 1.00x);
- 比值落在双方 ±噪声带内判 **平局**,不判赢;
- 内存经每栈的 `/debug/memory` 采样(idle / steady / peak)。

## 运行

```bash
node bench/route-shootout/run.mjs [connections] [durationSeconds] [rounds]
# 默认:200 连接、每 fire 8s、4 轮 → REPORT.md
# 快速冒烟(约 3 分钟):node bench/route-shootout/run.mjs 50 2 2
```

Go 基线有工具链时自动构建,没有时静默跳过。结果写 `REPORT.md`
(提交时保留最近一次的实测数据;机器不同数字不同,比值与噪声带
才是可搬运的结论)。

## 首轮实测结论(2026-09-04 全量 + 2026-09-05 诊断复核与 R413 修复)

> 两项疑点已由 `docs/R412-SHOOTOUT-DIFF-DIAGNOSIS.md` 用工具实证到
> 根因;疑点 A 的修复(bucket-regex 快速层)以 0.7.3 落地,结论随之更新。

- **HTTP 层(R413+通配兜底后,见 REPORT.md)**:vs hono 紧带轮
  (±3% 内)0.99-1.03x、噪声轮平局,wildcard **1.00x**(旧 0.98x 已
  消);keala vs raw Bun.serve 0.97-1.01x(紧带轮,框架 ≈ 裸运行时
  天花板);keala 轮间噪声从 ±22-52% 收紧(每请求路由分配消失的 GC
  红利)。首轮 REPORT 里 mixed 0.86-0.88x 是"首枪凹陷窗口"采样伪影;
- **进程内(R413 后)**:动态形状 keala **1.09-1.14x 快**(修复前
  1.49-1.79x 慢),static 0.95x——bucket-regex 吸收路由差距后,keala
  的 context/dispatch 机器比 hono 快 ~50ns/请求;
- **Node 双栈**:七场景 keala(node) ≈ hono(node)(0.94-1.06x);
- **vs Go**:Bun 栈吞吐全面高于 go net/http(1.10-1.29x),Go 赢
  内存——与主矩阵 BENCH.md 结论一致;
- **内存**:Bun 腿 idle 持平(27.7 vs 28.4MB),steady/peak 高
  ~8-11MB——实验排除 JS 存量堆/期限竞赛/context 分配三假设后定性为
  分配器 arena 随分配率增长(soak 证实有界非泄漏,CHANGELOG 0.7.3);
  Node 腿 idle +19MB 中 ~10MB+ 是本服务器直接 import src/*.ts 的
  类型剥离器 WASM 税(dist JS 形态下真实差 +9.7MB)。

诊断工具在 `diag/`(路由隔离/管线分解/CPU profile/HTTP 安静窗口
复核/Node 内存三段归因),复现命令见诊断文档。
