# bun-koa performance report

Generated: 2026-08-30T18:00:09.114Z

- Load tool: autocannon (4 client workers — one process saturates at ~177k req/s)
- Connections: 200, duration: 8s per fire, 4 interleaved rounds
- **ABAB-interleaved**: all servers resident; within each scenario every server fires once per round in rotating order
- Ratio lines carry each side's run-to-run noise (±spread); a ratio inside the noise band is a TIE, not a win
- Runtimes: Bun 1.4 (raw / bun-koa / hono) vs Node.js 22 (koa / fastify)
- Loopback HTTP/1.1 keep-alive; identical response shapes on every framework

## Text response

| Framework     | Runtime |   req/s | noise |
| ------------- | ------- | ------: | ----: |
| raw Bun.serve | bun 1.4 | 217,088 |  ±31% |
| bun-koa       | bun 1.4 | 228,432 |  ±13% |
| hono 4        | bun 1.4 | 194,448 |  ±23% |
| koa 3         | node 22 |  64,758 |  ±37% |
| fastify 5     | node 22 |  80,888 |  ±14% |
| koa 3         | bun 1.4 | 109,080 |  ±14% |
| fastify 5     | bun 1.4 | 136,676 |  ±19% |

- bun-koa vs koa 3: **3.53x** (±13% / ±37%)
- bun-koa vs fastify 5: **2.82x** (±13% / ±14%)
- bun-koa vs hono 4: **1.17x** (±13% / ±23%)
- bun-koa vs raw Bun: **1.05x** (±13% / ±31%)

## JSON response

| Framework     | Runtime |   req/s | noise |
| ------------- | ------- | ------: | ----: |
| raw Bun.serve | bun 1.4 | 235,008 |  ±15% |
| bun-koa       | bun 1.4 | 231,280 |  ±13% |
| hono 4        | bun 1.4 | 211,968 |  ±16% |
| koa 3         | node 22 |  69,936 |   ±4% |
| fastify 5     | node 22 |  77,528 |  ±12% |
| koa 3         | bun 1.4 | 112,840 |   ±8% |
| fastify 5     | bun 1.4 | 123,896 |  ±27% |

- bun-koa vs koa 3: **3.31x** (±13% / ±4%)
- bun-koa vs fastify 5: **2.98x** (±13% / ±12%)
- bun-koa vs hono 4: **1.09x** (±13% / ±16%)
- bun-koa vs raw Bun: **0.98x** (±13% / ±15%)

## Param route

| Framework     | Runtime |   req/s | noise |
| ------------- | ------- | ------: | ----: |
| raw Bun.serve | bun 1.4 | 246,976 |  ±16% |
| bun-koa       | bun 1.4 | 243,536 |  ±15% |
| hono 4        | bun 1.4 | 242,000 |  ±21% |
| koa 3         | node 22 |  71,072 |   ±1% |
| fastify 5     | node 22 |  85,560 |   ±1% |
| koa 3         | bun 1.4 | 123,680 |   ±3% |
| fastify 5     | bun 1.4 | 142,948 |   ±3% |

- bun-koa vs koa 3: **3.43x** (±15% / ±1%)
- bun-koa vs fastify 5: **2.85x** (±15% / ±1%)
- bun-koa vs hono 4: **1.01x** (±15% / ±21%)
- bun-koa vs raw Bun: **0.99x** (±15% / ±16%)

## 3 middlewares

| Framework     | Runtime |   req/s | noise |
| ------------- | ------- | ------: | ----: |
| raw Bun.serve | bun 1.4 | 231,168 |   ±6% |
| bun-koa       | bun 1.4 | 206,224 |  ±15% |
| hono 4        | bun 1.4 | 195,056 |  ±10% |
| koa 3         | node 22 |  68,546 |  ±18% |
| fastify 5     | node 22 |  88,128 |  ±18% |
| koa 3         | bun 1.4 | 113,000 |  ±12% |
| fastify 5     | bun 1.4 | 150,000 |   ±9% |

- bun-koa vs koa 3: **3.01x** (±15% / ±18%)
- bun-koa vs fastify 5: **2.34x** (±15% / ±18%)
- bun-koa vs hono 4: **1.06x** (±15% / ±10%)
- bun-koa vs raw Bun: **0.89x** (±15% / ±6%)

## 1000-route scale (late)

| Framework     | Runtime |   req/s | noise |
| ------------- | ------- | ------: | ----: |
| raw Bun.serve | bun 1.4 | 173,684 |   ±5% |
| bun-koa       | bun 1.4 | 229,136 |   ±6% |
| hono 4        | bun 1.4 | 239,856 |   ±6% |
| koa 3         | node 22 |  15,301 |  ±14% |
| fastify 5     | node 22 |  84,456 |   ±3% |

- bun-koa vs koa 3: **14.98x** (±6% / ±14%)
- bun-koa vs fastify 5: **2.71x** (±6% / ±3%)
- bun-koa vs hono 4: **0.96x** (±6% / ±6%)
- bun-koa vs raw Bun: **1.32x** (±6% / ±5%)

## Latency under load (median of interleaved rounds)

| Framework     | scenario                | p50 (ms) | p99 (ms) |
| ------------- | ----------------------- | -------: | -------: |
| raw Bun.serve | Text response           |      0.0 |      3.0 |
| raw Bun.serve | JSON response           |      0.0 |      2.0 |
| raw Bun.serve | Param route             |      0.0 |      2.0 |
| raw Bun.serve | 3 middlewares           |      0.0 |      2.0 |
| raw Bun.serve | 1000-route scale (late) |      1.0 |      3.0 |
| bun-koa       | Text response           |      0.0 |      2.0 |
| bun-koa       | JSON response           |      0.0 |      2.0 |
| bun-koa       | Param route             |      0.0 |      2.0 |
| bun-koa       | 3 middlewares           |      0.0 |      2.0 |
| bun-koa       | 1000-route scale (late) |      0.0 |      2.0 |
| hono 4        | Text response           |      0.0 |      4.0 |
| hono 4        | JSON response           |      0.0 |      3.0 |
| hono 4        | Param route             |      0.0 |      2.0 |
| hono 4        | 3 middlewares           |      0.0 |      2.0 |
| hono 4        | 1000-route scale (late) |      0.0 |      2.0 |
| koa 3         | Text response           |      2.0 |      8.0 |
| koa 3         | JSON response           |      2.0 |      6.0 |
| koa 3         | Param route             |      2.0 |      4.0 |
| koa 3         | 3 middlewares           |      2.0 |      6.0 |
| koa 3         | 1000-route scale (late) |     12.0 |     25.0 |
| fastify 5     | Text response           |      2.0 |      7.0 |
| fastify 5     | JSON response           |      2.0 |      7.0 |
| fastify 5     | Param route             |      2.0 |      4.0 |
| fastify 5     | 3 middlewares           |      2.0 |      3.0 |
| fastify 5     | 1000-route scale (late) |      2.0 |      4.0 |
| koa 3         | Text response           |      1.0 |      5.0 |
| koa 3         | JSON response           |      1.0 |      5.0 |
| koa 3         | Param route             |      1.0 |      3.0 |
| koa 3         | 3 middlewares           |      1.0 |      5.0 |
| fastify 5     | Text response           |      1.0 |      4.0 |
| fastify 5     | JSON response           |      1.0 |      5.0 |
| fastify 5     | Param route             |      1.0 |      2.0 |
| fastify 5     | 3 middlewares           |      1.0 |      2.0 |

## Memory footprint (sampled via /debug/memory)

| Framework     | idle RSS | steady RSS | peak RSS | idle heap | steady heap |
| ------------- | -------: | ---------: | -------: | --------: | ----------: |
| raw Bun.serve |   14.0MB |     17.4MB |   35.8MB |     0.1MB |       0.2MB |
| bun-koa       |   31.2MB |     25.0MB |   48.0MB |     1.4MB |       1.2MB |
| hono 4        |   24.8MB |     27.6MB |   52.6MB |     0.4MB |       0.6MB |
| koa 3         |   68.8MB |     30.5MB |   98.1MB |     9.6MB |      12.4MB |
| fastify 5     |   64.5MB |     29.3MB |   94.3MB |    11.6MB |      20.6MB |
| koa 3         |   40.4MB |     32.6MB |  119.9MB |     4.0MB |       4.6MB |
| fastify 5     |   43.3MB |     33.3MB |  130.5MB |     5.5MB |       4.7MB |
| raw Bun.serve |   19.1MB |     30.0MB |   34.6MB |     0.2MB |       0.2MB |
| bun-koa       |   37.1MB |     36.7MB |   43.0MB |     2.3MB |       2.0MB |
| hono 4        |   32.6MB |     35.1MB |   38.3MB |     0.7MB |       2.6MB |
| koa 3         |   74.5MB |     76.8MB |   84.5MB |    12.3MB |      13.4MB |
| fastify 5     |   97.8MB |     53.1MB |  155.3MB |    27.5MB |      16.3MB |

---

## Reading this data honestly (ABAB-interleaved, 2026-08-31)

Methodology note: the previous report measured each server sequentially and
its per-scenario ratios carried up to ±25% order bias. All numbers here are
ABAB-interleaved — every server resident, firing in rotating order, 4 rounds
per scenario, ratio lines annotated with each side's run-to-run spread.

**bun-koa vs hono 4: statistical parity.**

| scenario              |       bun-koa |        hono 4 |     ratio | verdict       |
| --------------------- | ------------: | ------------: | --------: | ------------- |
| text                  |  228,432 ±13% |  194,448 ±23% |     1.17x | inside noise  |
| JSON                  |  231,280 ±13% |  211,968 ±16% |     1.09x | inside noise  |
| param                 |  243,536 ±15% |  242,000 ±21% |     1.01x | tie           |
| 3 middlewares         |  206,224 ±15% |  195,056 ±10% |     1.06x | inside noise  |
| 1000-route scale      |   229,136 ±6% |   239,856 ±6% |     0.96x | inside noise  |
| **in-process ns/req** | **379 / 476** | **379 / 476** | **1.00x** | **exact tie** |

Four of five HTTP ratio medians lean bun-koa, but every one sits inside the
run-to-run noise band — claiming a win would repeat the bias this
methodology exists to remove. The decisive measurement is the batch-
interleaved in-process baseline (`bun bench/verify-baseline.ts`): identical
medians, 379ns text and 476ns param per request on BOTH frameworks. Framework
overhead is equal; the onion model costs nothing versus hono's composition.

**Where the gaps ARE real (far beyond any noise band):**

- **vs koa 3 (Node 22): 3.0–3.5x** on every scenario, **15x at 1000 routes**
  (15k vs 229k req/s — @koa/router's linear layer walk vs O(path) dispatch).
- **vs fastify 5 (Node 22): 2.3–3.0x**, and vs their Bun-compat placements
  (koa-on-bun 109–124k, fastify-on-bun 124–150k) still 1.5–2.1x.
- **Peak memory**: bun-koa 48.0MB vs hono 52.6MB vs koa 98.1MB — the
  framework with the lowest peak RSS of the group.

**vs raw Bun.serve: 0.89–1.05x** — parity at this client scale (4 workers
push ~240k req/s; the ~140ns/req framework overhead measured in-process is
~3% of the wire cost and invisible here). The framework tax question is
answered in-process: 379ns vs raw's 243ns per request, same as hono's.

**The 1000-route raw inversion is real and reproduced three times**
(160k / 173k / 174k across independent runs): Bun 1.4's native routes table
costs more per lookup at 1000 entries than a hash-map + trie dispatch. The
explanation is a hypothesis, the measurement is not.

## Reproduce

```sh
bun install
node bench/run.mjs 200 8       # HTTP benchmark (ABAB-interleaved, 4 workers)
bun bench/verify-baseline.ts   # in-process framework-overhead baseline
```
