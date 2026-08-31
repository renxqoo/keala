# bun-koa performance report

Generated: 2026-08-31T00:10:09.577Z

- Load tool: autocannon (4 client workers — one process saturates at ~177k req/s)
- Connections: 200, duration: 8s per fire, 4 interleaved rounds
- **ABAB-interleaved**: all servers resident; within each scenario every server fires once per round in rotating order
- Ratio lines carry each side's run-to-run noise (±spread); a ratio inside the noise band is a TIE, not a win
- Runtimes: bun 1.4.0 (raw / bun-koa / hono) vs node 26 (koa / fastify) vs go 1.27
- Loopback HTTP/1.1 keep-alive; identical response shapes on every framework
- Response correctness (bodies + middleware headers) is asserted for every server×scenario BEFORE any load runs

## Text response

| Framework     | Runtime |  req/s | noise |
| ------------- | ------- | -----: | ----: |
| raw Bun.serve | bun 1.4 | 49,916 |  ±33% |
| bun-koa       | bun 1.4 | 56,764 |  ±13% |
| hono 4        | bun 1.4 | 52,884 |  ±21% |
| koa 3         | node 26 | 20,320 |  ±35% |
| fastify 5     | node 26 | 27,434 |  ±23% |
| koa 3         | bun 1.4 | 24,260 |  ±15% |
| fastify 5     | bun 1.4 | 30,730 |   ±9% |
| go net/http   | go 1.27 | 57,720 |   ±2% |

- bun-koa vs koa 3: **2.79x** (±13% / ±35%)
- bun-koa vs fastify 5: **2.07x** (±13% / ±23%)
- bun-koa vs hono 4: **1.07x** (±13% / ±21%)
- bun-koa vs raw Bun: **1.14x** (±13% / ±33%)
- bun-koa vs go net/http: **0.98x** (±13% / ±2%)

## JSON response

| Framework     | Runtime |  req/s | noise |
| ------------- | ------- | -----: | ----: |
| raw Bun.serve | bun 1.4 | 51,332 |   ±3% |
| bun-koa       | bun 1.4 | 48,648 |  ±10% |
| hono 4        | bun 1.4 | 46,000 |  ±11% |
| koa 3         | node 26 | 16,492 |  ±10% |
| fastify 5     | node 26 | 22,566 |   ±2% |
| koa 3         | bun 1.4 | 23,016 |   ±3% |
| fastify 5     | bun 1.4 | 30,913 |   ±5% |
| go net/http   | go 1.27 | 56,228 |   ±3% |

- bun-koa vs koa 3: **2.95x** (±10% / ±10%)
- bun-koa vs fastify 5: **2.16x** (±10% / ±2%)
- bun-koa vs hono 4: **1.06x** (±10% / ±11%)
- bun-koa vs raw Bun: **0.95x** (±10% / ±3%)
- bun-koa vs go net/http: **0.87x** (±10% / ±3%)

## Param route

| Framework     | Runtime |  req/s | noise |
| ------------- | ------- | -----: | ----: |
| raw Bun.serve | bun 1.4 | 47,580 |  ±22% |
| bun-koa       | bun 1.4 | 47,604 |  ±18% |
| hono 4        | bun 1.4 | 50,088 |  ±11% |
| koa 3         | node 26 | 16,219 |   ±1% |
| fastify 5     | node 26 | 22,530 |  ±10% |
| koa 3         | bun 1.4 | 23,190 |   ±9% |
| fastify 5     | bun 1.4 | 29,674 |  ±21% |
| go net/http   | go 1.27 | 55,268 |  ±36% |

- bun-koa vs koa 3: **2.94x** (±18% / ±1%)
- bun-koa vs fastify 5: **2.11x** (±18% / ±10%)
- bun-koa vs hono 4: **0.95x** (±18% / ±11%)
- bun-koa vs raw Bun: **1.00x** (±18% / ±22%)
- bun-koa vs go net/http: **0.86x** (±18% / ±36%)

## 3 middlewares

| Framework     | Runtime |  req/s | noise |
| ------------- | ------- | -----: | ----: |
| raw Bun.serve | bun 1.4 | 48,596 |   ±1% |
| bun-koa       | bun 1.4 | 39,396 |   ±1% |
| hono 4        | bun 1.4 | 39,072 |   ±2% |
| koa 3         | node 26 | 17,249 |   ±5% |
| fastify 5     | node 26 | 25,188 |   ±2% |
| koa 3         | bun 1.4 | 24,212 |   ±1% |
| fastify 5     | bun 1.4 | 33,426 |   ±3% |
| go net/http   | go 1.27 | 54,972 |   ±4% |

- bun-koa vs koa 3: **2.28x** (±1% / ±5%)
- bun-koa vs fastify 5: **1.56x** (±1% / ±2%)
- bun-koa vs hono 4: **1.01x** (±1% / ±2%)
- bun-koa vs raw Bun: **0.81x** (±1% / ±1%)
- bun-koa vs go net/http: **0.72x** (±1% / ±4%)

## 1000-route scale (late)

| Framework             | Runtime |  req/s | noise |
| --------------------- | ------- | -----: | ----: |
| raw Bun.serve (scale) | bun 1.4 | 38,800 |   ±3% |
| bun-koa (scale)       | bun 1.4 | 55,608 |   ±2% |
| hono 4 (scale)        | bun 1.4 | 52,336 |   ±6% |
| koa 3 (scale)         | node 26 |  5,917 |   ±8% |
| fastify 5 (scale)     | node 26 | 27,070 |   ±1% |
| go net/http (scale)   | go 1.27 | 62,976 |   ±2% |

- bun-koa vs koa 3: **9.40x** (±2% / ±8%)
- bun-koa vs fastify 5: **2.05x** (±2% / ±1%)
- bun-koa vs hono 4: **1.06x** (±2% / ±6%)
- bun-koa vs raw Bun: **1.43x** (±2% / ±3%)
- bun-koa vs go net/http: **0.88x** (±2% / ±2%)

## Latency under load (median of interleaved rounds)

| Framework             | scenario                | p50 (ms) | p99 (ms) |
| --------------------- | ----------------------- | -------: | -------: |
| raw Bun.serve         | Text response           |      3.0 |      8.0 |
| raw Bun.serve         | JSON response           |      3.0 |      8.0 |
| raw Bun.serve         | Param route             |      4.0 |      9.0 |
| raw Bun.serve         | 3 middlewares           |      3.0 |      8.0 |
| bun-koa               | Text response           |      3.0 |      8.0 |
| bun-koa               | JSON response           |      3.0 |      8.0 |
| bun-koa               | Param route             |      3.0 |      8.0 |
| bun-koa               | 3 middlewares           |      4.0 |      9.0 |
| hono 4                | Text response           |      3.0 |      8.0 |
| hono 4                | JSON response           |      4.0 |      8.0 |
| hono 4                | Param route             |      4.0 |      8.0 |
| hono 4                | 3 middlewares           |      4.0 |     10.0 |
| koa 3                 | Text response           |     10.0 |     13.0 |
| koa 3                 | JSON response           |     12.0 |     15.0 |
| koa 3                 | Param route             |     12.0 |     16.0 |
| koa 3                 | 3 middlewares           |     11.0 |     15.0 |
| fastify 5             | Text response           |      7.0 |      9.0 |
| fastify 5             | JSON response           |      8.0 |     11.0 |
| fastify 5             | Param route             |      8.0 |     11.0 |
| fastify 5             | 3 middlewares           |      7.0 |     10.0 |
| koa 3                 | Text response           |      7.0 |     11.0 |
| koa 3                 | JSON response           |      8.0 |     11.0 |
| koa 3                 | Param route             |      8.0 |     19.0 |
| koa 3                 | 3 middlewares           |      7.0 |     10.0 |
| fastify 5             | Text response           |      6.0 |     11.0 |
| fastify 5             | JSON response           |      6.0 |     10.0 |
| fastify 5             | Param route             |      6.0 |     12.0 |
| fastify 5             | 3 middlewares           |      5.0 |     10.0 |
| go net/http           | Text response           |      2.0 |     20.0 |
| go net/http           | JSON response           |      2.0 |     20.0 |
| go net/http           | Param route             |      2.0 |     21.0 |
| go net/http           | 3 middlewares           |      2.0 |     19.0 |
| raw Bun.serve (scale) | 1000-route scale (late) |      5.0 |      9.0 |
| bun-koa (scale)       | 1000-route scale (late) |      3.0 |      7.0 |
| hono 4 (scale)        | 1000-route scale (late) |      3.0 |      8.0 |
| koa 3 (scale)         | 1000-route scale (late) |     33.0 |     37.0 |
| fastify 5 (scale)     | 1000-route scale (late) |      7.0 |      9.0 |
| go net/http (scale)   | 1000-route scale (late) |      2.0 |     16.0 |

## Memory footprint (sampled via /debug/memory)

| Framework             | idle RSS | steady RSS | peak RSS | idle heap | steady heap |
| --------------------- | -------: | ---------: | -------: | --------: | ----------: |
| raw Bun.serve         |   12.0MB |     32.6MB |   39.4MB |     0.1MB |       0.2MB |
| bun-koa               |   19.1MB |     47.2MB |   47.5MB |     0.6MB |       0.8MB |
| hono 4                |   20.0MB |     43.9MB |   47.1MB |     0.5MB |       0.6MB |
| koa 3                 |   63.5MB |     87.3MB |  109.9MB |    12.5MB |      12.3MB |
| fastify 5             |   61.5MB |     80.7MB |  109.1MB |    12.3MB |      15.3MB |
| koa 3                 |   33.8MB |     80.5MB |   90.5MB |     4.6MB |       4.6MB |
| fastify 5             |   36.2MB |     82.7MB |  100.9MB |     6.1MB |       4.9MB |
| go net/http           |    5.9MB |     18.4MB |   19.6MB |     0.3MB |       0.6MB |
| raw Bun.serve (scale) |   16.7MB |     39.0MB |   39.0MB |     0.2MB |       0.2MB |
| bun-koa (scale)       |   25.8MB |     38.6MB |   38.6MB |     1.5MB |       1.4MB |
| hono 4 (scale)        |   27.8MB |     38.8MB |   38.8MB |     1.4MB |       0.9MB |
| koa 3 (scale)         |   70.4MB |     89.8MB |   89.8MB |    14.6MB |      13.4MB |
| fastify 5 (scale)     |   98.6MB |     96.1MB |   97.6MB |    27.8MB |      20.2MB |
| go net/http (scale)   |    7.1MB |     19.0MB |   19.0MB |     1.1MB |       3.7MB |

---

## Reading this data honestly (ABAB-interleaved; two machines, 2026-08-31)

Methodology note: the previous report measured each server sequentially and
its per-scenario ratios carried up to ±25% order bias. All numbers here are
ABAB-interleaved — every server resident, firing in rotating order, 4 rounds
per scenario, ratio lines annotated with each side's run-to-run spread.
Response correctness (bodies + middleware headers) is asserted for every
server×scenario before any load runs.

Two machines contribute, and their ABSOLUTE numbers are not comparable:

- **8-core Apple Silicon** (client and servers co-resident, headroom to
  spare): the throughput headline — `bun-koa` ≈ 200–243k req/s.
- **4-core Intel** (i5-8257U, colocated client compresses everything ~4x):
  the RELATIVE table with the Go reference — ratios carry, absolutes do not.

**bun-koa vs hono 4: statistical parity — on both machines.**

| scenario              |       bun-koa |        hono 4 |     ratio | verdict       |
| --------------------- | ------------: | ------------: | --------: | ------------- |
| text                  |  228,432 ±13% |  194,448 ±23% |     1.17x | inside noise  |
| JSON                  |  231,280 ±13% |  211,968 ±16% |     1.09x | inside noise  |
| param                 |  243,536 ±15% |  242,000 ±21% |     1.01x | tie           |
| 3 middlewares         |  206,224 ±15% |  195,056 ±10% |     1.06x | inside noise  |
| 1000-route scale      |   229,136 ±6% |   239,856 ±6% |     0.96x | inside noise  |
| **in-process ns/req** | **379 / 476** | **379 / 476** | **1.00x** | **exact tie** |

| Intel 4-core (colocated) |     bun-koa |      hono 4 | ratio | verdict      |
| ------------------------ | ----------: | ----------: | ----: | ------------ |
| text                     | 56,764 ±13% | 52,884 ±21% | 1.07x | inside noise |
| JSON                     | 48,648 ±10% | 46,000 ±11% | 1.06x | inside noise |
| param                    | 47,604 ±18% | 50,088 ±11% | 0.95x | inside noise |
| 3 middlewares            |  39,396 ±1% |  39,072 ±2% | 1.01x | tight tie    |
| 1000-route scale         |  55,608 ±2% |  52,336 ±6% | 1.06x | inside noise |

Four of five Apple-Silicon ratio medians lean bun-koa, but every one sits
inside the run-to-run noise band — claiming a win would repeat the bias this
methodology exists to remove. The decisive measurement is the batch-
interleaved in-process baseline (`bun bench/verify-baseline.ts`): identical
medians, 379ns text and 476ns param per request on BOTH frameworks. Framework
overhead is equal; the onion model costs nothing versus hono's composition.

**Where the gaps ARE real (far beyond any noise band):**

- **vs koa 3 (Node): 2.3–3.5x** on every scenario, **9.4–15x at 1000 routes**
  (@koa/router's linear layer walk vs O(path) dispatch).
- **vs fastify 5 (Node): 1.6–3.0x**, and vs their Bun-compat placements
  (koa-on-bun, fastify-on-bun) still 1.5–2.1x on Apple Silicon.
- **Idle memory** (Intel box): bun-koa **19.1MB vs hono 20.0MB** — the lazy
  native bridges flipped this row in our favor (pre-change: 31.2 vs 24.8).
  Peak is a tie (47.5 vs 47.1MB); koa/fastify idle at 34–64MB, peak ~100MB.

**vs raw Bun.serve: 0.81–1.14x** — parity at this client scale (the
~140ns/req framework overhead measured in-process is a few percent of the
wire cost). The framework tax question is answered in-process: 379ns vs
raw's 243ns per request, same as hono's.

**The 1000-route raw inversion is real and reproduced** (raw's native routes
table loses to hash-map + trie dispatch at 1000 entries on both machines;
Intel: bun-koa 55.6k vs raw 38.8k, ±2%/±3%). The explanation is a
hypothesis, the measurement is not.

## The Go reference (net/http, Go 1.27 — added 2026-08-31)

A stdlib `net/http` server with byte-identical responses joins the harness
(`bench/server-go`, auto-built when a Go toolchain exists). On the Intel box
it is the fastest participant, ahead of **raw Bun.serve** itself:

| Intel 4-core  |     bun-koa |          Go | ratio | verdict              |
| ------------- | ----------: | ----------: | ----: | -------------------- |
| text          | 56,764 ±13% |  57,720 ±2% | 0.98x | inside noise         |
| JSON          | 48,648 ±10% |  56,228 ±3% | 0.87x | Go ahead, near-noise |
| param         | 47,604 ±18% | 55,268 ±36% | 0.86x | inside noise         |
| 3 middlewares |  39,396 ±1% |  54,972 ±4% | 0.72x | **real gap**         |
| 1000-route    |  55,608 ±2% |  62,976 ±2% | 0.88x | **real gap**         |

Honest reading: Go leads the whole field by ~10–15% in throughput and wins
memory outright (idle 5.9MB / peak 19.6MB — every JS runtime idles at
12–28MB and peaks at 38–48MB). The gap sits BELOW the framework layer: raw
Bun.serve trails Go on the same box, and bun-koa adds nothing to that gap
versus hono (both tie). The onion/middleware tower widens it to 0.72x —
three JS closures per request cost what Go pays in a static handler chain.
Latency flips at the tail: Go's p50 is lowest (2ms vs 3ms) but its p99 is
the WORST of the Bun-side group (19–21ms vs 8–10ms) under colocated
contention — scheduler queuing, not per-request cost.

## Cross-machine replication (dedicated Intel machine)

The batch-interleaved in-process baseline on the same Intel machine:

| scenario          |           bun-koa |            hono 4 | ratio |
| ----------------- | ----------------: | ----------------: | ----: |
| text, in-process  | 2,118 ns (472k/s) | 2,089 ns (479k/s) | 0.99x |
| param, in-process | 2,757 ns (363k/s) | 2,703 ns (370k/s) | 0.98x |

Parity replicates on completely different hardware at a completely different
absolute speed (Apple Silicon: 379ns tie; Intel: ~2.1µs, same tie).

An earlier session DISCARDED this machine's HTTP layer (±31–214% spreads
from colocated client contention). The 2026-08-31 23:35 run — machine
otherwise idle — produced ±1–36% spreads and is published above as the
relative table; two earlier attempts that evening (user sessions active on
the box) reproduced the old ±65–126% pattern and were discarded. Colocated
HTTP on a 4-core box is usable only in quiet windows; treat its absolutes
as client-bound (~50–63k ceiling) and never compare them across machines.

## Methodology calibrated against hono's own suite (2026-08-31)

First-hand read of hono's `benchmarks/`: its only HTTP harness is a
hono-vs-hono PR regression gate — no warmup, runs=1, means, baseline always
first, no noise reporting. The rigorous part is its in-process micro
benchmarks: fresh process per variant per round, alternating order,
median-of-p50, explicit lazy-init warmup. Borrowed here: pre-load response
assertions (now in `run.mjs`, `--skip-tests` to skip) and honesty footnotes
in the generated report. Not adopted: bombardier `--fasthttp` (client
behavior diverges from real HTTP), shared CI runners (noise), dropping
latency percentiles. Known limitation kept on the books:
`verify-baseline.ts` interleaves suites in ONE process (not per-variant
fresh processes) — its ties are cross-validated by the HTTP parity above.

## Reproduce

```sh
bun install
node bench/run.mjs 200 8       # HTTP benchmark (ABAB-interleaved, 4 workers)
bun bench/verify-baseline.ts   # in-process framework-overhead baseline
# Go reference: install any Go >= 1.22 toolchain — run.mjs builds it
# automatically and adds it to every scenario; without one it is skipped.
```
