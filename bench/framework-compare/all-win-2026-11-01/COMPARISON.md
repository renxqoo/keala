# 最终 Xi：同机完整对比

结论：尚未全面领先。本轮中位数中，Node 13/13场景的吞吐与CPU/请求均优于Hono/H3；Node p99对Hono有4项更差。Bun对Hono仅6/13同时赢吞吐与CPU，对H3为13/13。这里只描述本次样本，不代表微小差距有统计显著性。

源码33f23a18be16853fdaa06371aee662a1138723e229b0e9fac06d02c0b82b2067，对照290a323faa77b894e7c2a60a558f4777136bb39028c7a76b1a9e675ad6b29ec6。Node26.9.0/Bun1.4.4；相同50连接、预热1秒、计量3秒、3轮，实际窗口3.000–3.034秒。完整方法见同目录README。

## 汇总

| 运行时/场景           | Keala req/s | Hono req/s | H3 req/s | Keala CPU µs/请求 | Hono CPU | H3 CPU |
| --------------------- | ----------: | ---------: | -------: | ----------------: | -------: | -----: |
| node/Hello            |        9526 |       8677 |     8695 |             97.56 |   109.48 | 110.36 |
| node/十二路由几何平均 |        9342 |       8776 |     8230 |            101.47 |   108.61 | 116.64 |
| bun/Hello             |       23134 |      22536 |    21149 |             33.31 |    33.33 |  36.98 |
| bun/十二路由几何平均  |       21484 |      21715 |    19306 |             36.12 |    35.52 |  40.87 |

十二路由几何平均不是混合流量吞吐；不对p99求几何平均。相对本轮起点290a：Node十二路由吞吐+2.21%、CPU−2.76%；Bun+6.06%/−5.66%。Node有email/event/event-comments退化，不能说全部路径均获优化。

## 逐项结果

| 运行时/场景                                    | Keala req/s | 对Hono吞吐 | 对Hono CPU | p99 Keala/Hono/H3 ms |
| ---------------------------------------------- | ----------: | ---------: | ---------: | -------------------: |
| node/hello                                     |        9526 |      9.78% |    -10.88% |             23/21/26 |
| node/GET /user                                 |        9639 |     10.39% |    -10.45% |             21/29/29 |
| node/GET /user/comments                        |        9931 |      1.33% |     -3.41% |             26/20/30 |
| node/GET /user/avatar                          |        9976 |      7.72% |     -8.63% |             26/28/24 |
| node/GET /user/lookup/username/:username       |        8802 |      0.73% |     -1.49% |             26/27/29 |
| node/GET /user/lookup/email/:address           |        8447 |      3.57% |     -2.62% |             30/32/32 |
| node/GET /event/:id                            |        9315 |      3.05% |     -2.37% |             23/24/32 |
| node/GET /event/:id/comments                   |        9197 |      3.21% |     -3.81% |             27/24/30 |
| node/POST /event/:id/comment                   |        8391 |     16.52% |    -15.92% |             29/27/30 |
| node/GET /map/:location/events                 |        9499 |      9.97% |     -8.78% |             27/28/30 |
| node/GET /status                               |        9536 |      3.94% |     -3.31% |             27/28/28 |
| node/GET /very/deeply/nested/route/hello/there |        9938 |      7.79% |     -8.68% |             21/24/30 |
| node/GET /static/*                             |        9614 |     10.30% |     -8.33% |             23/28/30 |
| bun/hello                                      |       23134 |      2.65% |     -0.05% |                8/9/8 |
| bun/GET /user                                  |       22688 |     -0.81% |      1.45% |                8/9/8 |
| bun/GET /user/comments                         |       21376 |     -6.76% |      7.72% |                9/9/9 |
| bun/GET /user/avatar                           |       22693 |     -0.06% |      0.47% |                8/8/9 |
| bun/GET /user/lookup/username/:username        |       20900 |      0.60% |     -0.22% |                9/9/9 |
| bun/GET /user/lookup/email/:address            |       21159 |      3.37% |     -1.33% |              9/10/10 |
| bun/GET /event/:id                             |       20782 |      0.06% |     -0.25% |                9/8/9 |
| bun/GET /event/:id/comments                    |       21699 |      2.33% |     -2.76% |                8/9/8 |
| bun/POST /event/:id/comment                    |       19426 |     -4.89% |      5.73% |             10/10/10 |
| bun/GET /map/:location/events                  |       20643 |     -5.27% |      7.38% |               9/8/11 |
| bun/GET /status                                |       23157 |     -0.18% |      1.83% |               8/8/10 |
| bun/GET /very/deeply/nested/route/hello/there  |       23250 |      1.73% |     -0.50% |               7/8/10 |
| bun/GET /static/*                              |       20402 |     -2.31% |      1.21% |               9/9/10 |

CPU列负值表示更省CPU。Bun对Hono仍落后的七项：user、user/comments、user/avatar、POST comment、map、status、static。Hello Bun CPU优势仅约0.05%，不能据此确认稳定领先。

## 核验与限制

312样本、176项HTTP检查、13,909,050次完成请求；0错误、0计时拒绝/重试，640个测试子进程、0存活。源码、dist、before-dist、bench、原生客户端与归档摘要均经独立只读复核；原始文件SHA256为89c476267eddc15dd7c54db9969bff91031c7081fbb35de8e031c22be6789860。

全部样本均受150%总CPU配额节流，包含客户端与协调进程，不是裸机峰值。延迟为向下取整整数毫秒桶；三轮不足以确认微小差距的稳定性。最小可用内存1378.84MiB，cgroup峰值130.25MiB，OOM为0。

构建/完整verify、Node2984通过25跳过、Bun2916通过93跳过（3009项），smoke/examples、process/runtime、Node/Bun内存soak通过。服务器与本地临时目录清理记录另存；三个原服务PID不变。
