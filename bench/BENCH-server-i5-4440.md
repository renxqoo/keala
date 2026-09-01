# keala performance report

Generated: 2026-09-01T02:45:40.388Z

- Load tool: autocannon (4 client workers — one process saturates at ~177k req/s)
- Connections: 200, duration: 8s per fire, 4 interleaved rounds
- **ABAB-interleaved**: all servers resident; within each scenario every server fires once per round in rotating order
- Ratio lines carry each side's run-to-run noise (±spread); a ratio inside the noise band is a TIE, not a win
- Runtimes: bun 1.4.0 (raw / keala / hono) vs node 24 (keala / koa / fastify) vs go 1.27
- Loopback HTTP/1.1 keep-alive; identical response shapes on every framework
- Response correctness (bodies + middleware headers) is asserted for every server×scenario BEFORE any load runs

## Text response

| Framework     | Runtime |  req/s | noise |
| ------------- | ------- | -----: | ----: |
| raw Bun.serve | bun 1.4 | 58,916 |  ±74% |
| keala         | bun 1.4 | 61,584 |  ±69% |
| hono 4        | bun 1.4 | 64,404 |  ±52% |
| keala         | node 24 |  6,588 |  ±35% |
| koa 3         | node 24 | 14,192 |  ±24% |
| fastify 5     | node 24 | 20,394 |  ±25% |
| koa 3         | bun 1.4 | 19,474 |  ±12% |
| fastify 5     | bun 1.4 | 24,642 |  ±16% |
| go net/http   | go 1.27 | 43,929 |  ±12% |

- keala vs koa 3: **4.34x** (±69% / ±24%)
- keala vs fastify 5: **3.02x** (±69% / ±25%)
- keala vs hono 4: **0.96x** (±69% / ±52%)
- keala vs raw Bun: **1.05x** (±69% / ±74%)
- keala vs go net/http: **1.40x** (±69% / ±12%)

## JSON response

| Framework     | Runtime |  req/s | noise |
| ------------- | ------- | -----: | ----: |
| raw Bun.serve | bun 1.4 | 58,348 |   ±2% |
| keala         | bun 1.4 | 52,612 |   ±2% |
| hono 4        | bun 1.4 | 52,100 |   ±1% |
| keala         | node 24 |  5,817 |  ±11% |
| koa 3         | node 24 | 11,791 |   ±7% |
| fastify 5     | node 24 | 16,028 |   ±4% |
| koa 3         | bun 1.4 | 18,696 |  ±10% |
| fastify 5     | bun 1.4 | 23,332 |   ±3% |
| go net/http   | go 1.27 | 42,687 |   ±2% |

- keala vs koa 3: **4.46x** (±2% / ±7%)
- keala vs fastify 5: **3.28x** (±2% / ±4%)
- keala vs hono 4: **1.01x** (±2% / ±1%)
- keala vs raw Bun: **0.90x** (±2% / ±2%)
- keala vs go net/http: **1.23x** (±2% / ±2%)

## Param route

| Framework     | Runtime |  req/s | noise |
| ------------- | ------- | -----: | ----: |
| raw Bun.serve | bun 1.4 | 54,736 |   ±2% |
| keala         | bun 1.4 | 49,684 |   ±3% |
| hono 4        | bun 1.4 | 53,788 |   ±2% |
| keala         | node 24 |  5,315 |  ±10% |
| koa 3         | node 24 | 12,732 |   ±9% |
| fastify 5     | node 24 | 16,381 |  ±11% |
| koa 3         | bun 1.4 | 18,590 |  ±10% |
| fastify 5     | bun 1.4 | 22,412 |  ±10% |
| go net/http   | go 1.27 | 41,479 |   ±4% |

- keala vs koa 3: **3.90x** (±3% / ±9%)
- keala vs fastify 5: **3.03x** (±3% / ±11%)
- keala vs hono 4: **0.92x** (±3% / ±2%)
- keala vs raw Bun: **0.91x** (±3% / ±2%)
- keala vs go net/http: **1.20x** (±3% / ±4%)

## 3 middlewares

| Framework     | Runtime |  req/s | noise |
| ------------- | ------- | -----: | ----: |
| raw Bun.serve | bun 1.4 | 51,712 |   ±4% |
| keala         | bun 1.4 | 36,180 |   ±6% |
| hono 4        | bun 1.4 | 37,624 |   ±2% |
| keala         | node 24 |  5,183 |  ±14% |
| koa 3         | node 24 | 11,711 |   ±8% |
| fastify 5     | node 24 | 16,835 |   ±4% |
| koa 3         | bun 1.4 | 18,242 |   ±9% |
| fastify 5     | bun 1.4 | 23,446 |   ±8% |
| go net/http   | go 1.27 | 40,075 |   ±4% |

- keala vs koa 3: **3.09x** (±6% / ±8%)
- keala vs fastify 5: **2.15x** (±6% / ±4%)
- keala vs hono 4: **0.96x** (±6% / ±2%)
- keala vs raw Bun: **0.70x** (±6% / ±4%)
- keala vs go net/http: **0.90x** (±6% / ±4%)

## 1000-route scale (late)

| Framework             | Runtime |  req/s | noise |
| --------------------- | ------- | -----: | ----: |
| raw Bun.serve (scale) | bun 1.4 | 33,835 |   ±4% |
| keala (scale)         | bun 1.4 | 55,744 |   ±5% |
| hono 4 (scale)        | bun 1.4 | 58,840 |   ±3% |
| keala (scale)         | node 24 |  5,552 |  ±10% |
| koa 3 (scale)         | node 24 |  4,438 |  ±14% |
| fastify 5 (scale)     | node 24 | 17,099 |   ±7% |
| go net/http (scale)   | go 1.27 | 45,116 |   ±5% |

- keala vs koa 3: **12.56x** (±5% / ±14%)
- keala vs fastify 5: **3.26x** (±5% / ±7%)
- keala vs hono 4: **0.95x** (±5% / ±3%)
- keala vs raw Bun: **1.65x** (±5% / ±4%)
- keala vs go net/http: **1.24x** (±5% / ±5%)

## Latency under load (median of interleaved rounds)

| Framework             | scenario                | p50 (ms) | p99 (ms) |
| --------------------- | ----------------------- | -------: | -------: |
| raw Bun.serve         | Text response           |      3.0 |      9.0 |
| raw Bun.serve         | JSON response           |      2.0 |      9.0 |
| raw Bun.serve         | Param route             |      3.0 |      9.0 |
| raw Bun.serve         | 3 middlewares           |      3.0 |     10.0 |
| keala                 | Text response           |      3.0 |      9.0 |
| keala                 | JSON response           |      3.0 |     10.0 |
| keala                 | Param route             |      3.0 |     10.0 |
| keala                 | 3 middlewares           |      5.0 |     12.0 |
| hono 4                | Text response           |      2.0 |      9.0 |
| hono 4                | JSON response           |      3.0 |      9.0 |
| hono 4                | Param route             |      3.0 |      9.0 |
| hono 4                | 3 middlewares           |      5.0 |     12.0 |
| keala                 | Text response           |     28.0 |     38.0 |
| keala                 | JSON response           |     35.0 |     44.0 |
| keala                 | Param route             |     35.0 |     45.0 |
| keala                 | 3 middlewares           |     37.0 |     44.0 |
| koa 3                 | Text response           |     16.0 |     20.0 |
| koa 3                 | JSON response           |     16.0 |     26.0 |
| koa 3                 | Param route             |     16.0 |     20.0 |
| koa 3                 | 3 middlewares           |     17.0 |     22.0 |
| fastify 5             | Text response           |     12.0 |     16.0 |
| fastify 5             | JSON response           |     12.0 |     20.0 |
| fastify 5             | Param route             |     11.0 |     19.0 |
| fastify 5             | 3 middlewares           |     11.0 |     17.0 |
| koa 3                 | Text response           |     10.0 |     19.0 |
| koa 3                 | JSON response           |     10.0 |     18.0 |
| koa 3                 | Param route             |     11.0 |     19.0 |
| koa 3                 | 3 middlewares           |     11.0 |     20.0 |
| fastify 5             | Text response           |      8.0 |     17.0 |
| fastify 5             | JSON response           |      8.0 |     17.0 |
| fastify 5             | Param route             |      8.0 |     17.0 |
| fastify 5             | 3 middlewares           |      8.0 |     17.0 |
| go net/http           | Text response           |      3.0 |     18.0 |
| go net/http           | JSON response           |      3.0 |     18.0 |
| go net/http           | Param route             |      3.0 |     19.0 |
| go net/http           | 3 middlewares           |      3.0 |     20.0 |
| raw Bun.serve (scale) | 1000-route scale (late) |      5.0 |     12.0 |
| keala (scale)         | 1000-route scale (late) |      3.0 |      9.0 |
| hono 4 (scale)        | 1000-route scale (late) |      3.0 |      9.0 |
| keala (scale)         | 1000-route scale (late) |     35.0 |     41.0 |
| koa 3 (scale)         | 1000-route scale (late) |     41.0 |     50.0 |
| fastify 5 (scale)     | 1000-route scale (late) |     11.0 |     16.0 |
| go net/http (scale)   | 1000-route scale (late) |      3.0 |     17.0 |

## Memory footprint (sampled via /debug/memory)

| Framework             | idle RSS | steady RSS | peak RSS | idle heap | steady heap |
| --------------------- | -------: | ---------: | -------: | --------: | ----------: |
| raw Bun.serve         |   17.9MB |     29.4MB |   41.6MB |     0.1MB |       0.2MB |
| keala                 |   24.4MB |     38.6MB |   53.8MB |     0.7MB |       0.9MB |
| hono 4                |   26.9MB |     39.4MB |   53.4MB |     0.5MB |       0.6MB |
| keala                 |  101.3MB |    117.3MB |  195.5MB |    12.9MB |       9.9MB |
| koa 3                 |   72.5MB |    107.4MB |  110.5MB |    11.8MB |      16.0MB |
| fastify 5             |   73.6MB |    105.9MB |  105.9MB |    10.9MB |      16.5MB |
| koa 3                 |   47.9MB |     64.4MB |  100.5MB |     4.6MB |       5.0MB |
| fastify 5             |   51.0MB |     64.0MB |   96.7MB |     6.1MB |       4.8MB |
| go net/http           |    9.9MB |     16.8MB |   23.1MB |     0.3MB |       0.4MB |
| raw Bun.serve (scale) |   22.5MB |     32.2MB |   42.7MB |     0.2MB |       0.2MB |
| keala (scale)         |   33.3MB |     38.0MB |   49.5MB |     1.8MB |       1.8MB |
| hono 4 (scale)        |   34.9MB |     43.6MB |   49.2MB |     1.4MB |       4.6MB |
| keala (scale)         |  103.5MB |    118.1MB |  195.5MB |    13.7MB |      10.9MB |
| koa 3 (scale)         |   78.5MB |     87.6MB |  103.8MB |    14.0MB |      12.6MB |
| fastify 5 (scale)     |  118.5MB |    111.5MB |  111.5MB |    29.9MB |      23.8MB |
| go net/http (scale)   |   10.1MB |     18.3MB |   19.7MB |     1.1MB |       5.3MB |

---

> **Machine note:** this report was generated on a DIFFERENT machine than
> [BENCH.md](./BENCH.md) (2026-08-31, Apple M4). Absolute numbers are never
> comparable across machines — only same-machine ratios are meaningful.

## Fourth machine: dedicated Debian server (i5-4440, 2026-09-01)

A remote bare-metal box joins the roster: Intel i5-4440 (4 cores / 4 threads,
Haswell), 7.7GB RAM, Debian 13 trixie, node 24.20.0, bun 1.4.0,
go 1.27.0 linux/amd64. The CPU governor was switched to `performance` for the
benchmark window (restored to `schedutil` after); under full load all four
cores settle at ~2.2GHz — the Haswell all-core current limit below the 3.1GHz
nameplate. The frequency is stable and identical across cores, so ratios are
unaffected, but absolutes are not comparable with any other machine. The full
test suite (1807 tests) passed on this box before any load ran, and TWO
complete interleaved runs (~32 min, 173 fires each) agreed on every key
median within ≤2%. The generated tables above are run 2 (the tighter of the
two); run 1 is preserved alongside it on the server.

**Finding 1 — the Node adapter is not competitive on throughput.** keala
under node 24 manages 5.2–6.6k req/s: 2.1–2.4x SLOWER than koa 3 on the same
runtime, p50 28–37ms (koa 14–17ms), idle RSS ~102MB (koa 72MB). The
fetch-shaped core pays a per-request bridge (IncomingMessage → web Request →
web Response → ServerResponse: fresh Headers + header fan-in + Request
construction + a stream pipe) that koa's native req/res wrappers do not. The
router still wins at scale — 1000 routes: keala-node 5.6k vs koa 4.4k — but
the fixed bridge cost dominates every base scenario. "Runs under Node" is a
compatibility statement, not a performance one; the cost should be documented
(or a fast path ported) before Node deployment is advertised.

**Finding 2 — the hono parity claim breaks on this CPU (param routes).** All
three prior machines measured statistical parity; this Haswell box does not:

| i5-4440 (run 1 / run 2) |           keala |          hono 4 | ratio (r1/r2) | verdict                |
| ----------------------- | --------------: | --------------: | ------------: | ---------------------- |
| text                    | 61,674 / 61,584 | 63,788 / 64,404 | 0.97x / 0.96x | inside noise (±69%+)   |
| JSON                    | 53,504 / 52,612 | 51,704 / 52,100 | 1.03x / 1.01x | tie                    |
| param                   | 50,224 / 49,684 | 54,444 / 53,788 | 0.92x / 0.92x | **real gap** (±3%/±2%) |
| 3 middlewares           | 36,660 / 36,180 | 36,880 / 37,624 | 0.99x / 0.96x | tie / leans hono       |
| 1000-route scale        | 55,040 / 55,744 | 58,952 / 58,840 | 0.93x / 0.95x | leans hono             |

The in-process baseline agrees, three consecutive runs: keala text
1669–1783ns/req vs hono 1467–1573ns (1.12–1.14x slower), keala param
2245–2345ns vs hono 2049–2170ns (1.08–1.10x slower). Simple-route HTTP
ratios stay inside noise; the param gap (0.92x in both runs, ±3%/±2%) sits
outside it. Read the parity claim as new-hardware parity with a ~5–10%
param-dispatch deficit that old cores expose.

**Confirmed again on this box:** vs koa 3 3.9–4.5x (12.6–12.7x at 1000
routes), vs fastify 5 2.2–3.4x, and the 1000-route raw-Bun inversion
(1.65–1.67x — the fourth machine to reproduce it). The middleware tower
costs 0.70x vs raw here (0.86x on the M4) — slower boxes amplify per-request
closure cost. vs Go: keala leads JSON/param/scale by 20–25%, trails
3-middlewares at 0.90–0.92x, text is noise-bound (±52–74% first-scenario
spread; medians replicate at 0.96–0.97x). Go keeps the best p50 (2–3ms), the
worst p99 (17–20ms vs the Bun trio's 9–10ms), and the smallest footprint
(idle 10MB, peak 20–23MB).

## In-process baseline (i5-4440, three consecutive runs)

| suite (bun, in-process) | run 1       | run 2       | run 3       |
| ----------------------- | ----------- | ----------- | ----------- |
| raw text                | 971 ns/req  | 1056 ns/req | 1028 ns/req |
| keala text              | 1669 ns/req | 1783 ns/req | 1739 ns/req |
| hono text               | 1467 ns/req | 1573 ns/req | 1544 ns/req |
| raw param               | 1059 ns/req | 1145 ns/req | 1112 ns/req |
| keala param             | 2245 ns/req | 2345 ns/req | 2330 ns/req |
| hono param              | 2049 ns/req | 2170 ns/req | 2145 ns/req |

## Reproduce (this machine)

```sh
# on the Debian server (i5-4440): rsync/tar the repo, then
bun install
node bench/run.mjs 200 8       # full HTTP benchmark, ~32 min per run
bun bench/verify-baseline.ts   # in-process framework-overhead baseline
# run twice and compare medians; keep both reports.
```
