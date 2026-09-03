# keala performance report

Generated: 2026-09-02T21:45:53.732Z

- Load tool: autocannon (4 client workers — one process saturates at ~177k req/s)
- Connections: 200, duration: 8s per fire, 6 interleaved rounds
- **ABAB-interleaved**: all servers resident; within each scenario every server fires once per round in rotating order
- Ratio lines carry each side's run-to-run noise (±spread); a ratio inside the noise band is a TIE, not a win
- Runtimes: bun 1.4.0 (raw / keala / hono) vs node 22 (keala / koa / fastify) vs go 1.27
- Loopback HTTP/1.1 keep-alive; identical response shapes on every framework
- Response correctness (bodies + middleware headers) is asserted for every server×scenario BEFORE any load runs

## Text response

| Framework               | Runtime |   req/s | noise |
| ----------------------- | ------- | ------: | ----: |
| raw Bun.serve           | bun 1.4 | 248,208 |   ±3% |
| keala                   | bun 1.4 | 249,376 |   ±4% |
| hono 4                  | bun 1.4 | 247,200 |   ±3% |
| keala                   | node 22 |  79,048 |   ±1% |
| hono 4 official adapter | node 22 |  61,236 |   ±1% |
| koa 3                   | node 22 |  61,556 |   ±2% |
| fastify 5               | node 22 |  74,536 |   ±3% |
| koa 3                   | bun 1.4 | 124,064 |   ±4% |
| fastify 5               | bun 1.4 | 146,784 |   ±2% |
| go net/http             | go 1.27 | 187,312 |   ±1% |

- keala vs koa 3: **4.05x** (±4% / ±2%)
- keala vs fastify 5: **3.35x** (±4% / ±3%)
- keala vs hono 4: **1.01x** (±4% / ±3%)
- keala vs raw Bun: **1.00x** (±4% / ±3%)
- keala vs go net/http: **1.33x** (±4% / ±1%)

## JSON response

| Framework               | Runtime |   req/s | noise |
| ----------------------- | ------- | ------: | ----: |
| raw Bun.serve           | bun 1.4 | 250,032 |   ±1% |
| keala                   | bun 1.4 | 243,552 |   ±1% |
| hono 4                  | bun 1.4 | 236,672 |   ±1% |
| keala                   | node 22 |  77,664 |   ±1% |
| hono 4 official adapter | node 22 |  60,240 |   ±1% |
| koa 3                   | node 22 |  59,776 |   ±1% |
| fastify 5               | node 22 |  73,992 |   ±2% |
| koa 3                   | bun 1.4 | 119,816 |   ±2% |
| fastify 5               | bun 1.4 | 143,312 |   ±3% |
| go net/http             | go 1.27 | 186,320 |   ±1% |

- keala vs koa 3: **4.07x** (±1% / ±1%)
- keala vs fastify 5: **3.29x** (±1% / ±2%)
- keala vs hono 4: **1.03x** (±1% / ±1%)
- keala vs raw Bun: **0.97x** (±1% / ±1%)
- keala vs go net/http: **1.31x** (±1% / ±1%)

## Param route

| Framework               | Runtime |   req/s | noise |
| ----------------------- | ------- | ------: | ----: |
| raw Bun.serve           | bun 1.4 | 245,696 |   ±3% |
| keala                   | bun 1.4 | 243,744 |   ±2% |
| hono 4                  | bun 1.4 | 240,640 |   ±2% |
| keala                   | node 22 |  78,432 |   ±3% |
| hono 4 official adapter | node 22 |  59,924 |   ±1% |
| koa 3                   | node 22 |  60,064 |   ±2% |
| fastify 5               | node 22 |  74,312 |   ±3% |
| koa 3                   | bun 1.4 | 122,000 |   ±2% |
| fastify 5               | bun 1.4 | 142,256 |   ±3% |
| go net/http             | go 1.27 | 186,976 |   ±2% |

- keala vs koa 3: **4.06x** (±2% / ±2%)
- keala vs fastify 5: **3.28x** (±2% / ±3%)
- keala vs hono 4: **1.01x** (±2% / ±2%)
- keala vs raw Bun: **0.99x** (±2% / ±3%)
- keala vs go net/http: **1.30x** (±2% / ±2%)

## 3 middlewares

| Framework               | Runtime |   req/s | noise |
| ----------------------- | ------- | ------: | ----: |
| raw Bun.serve           | bun 1.4 | 237,568 |   ±1% |
| keala                   | bun 1.4 | 190,992 |   ±2% |
| hono 4                  | bun 1.4 | 192,032 |   ±4% |
| keala                   | node 22 |  61,400 |   ±1% |
| hono 4 official adapter | node 22 |  39,928 |   ±3% |
| koa 3                   | node 22 |  57,628 |   ±4% |
| fastify 5               | node 22 |  75,256 |   ±2% |
| koa 3                   | bun 1.4 | 115,272 |   ±2% |
| fastify 5               | bun 1.4 | 148,928 |   ±2% |
| go net/http             | go 1.27 | 184,368 |   ±2% |

- keala vs koa 3: **3.31x** (±2% / ±4%)
- keala vs fastify 5: **2.54x** (±2% / ±2%)
- keala vs hono 4: **0.99x** (±2% / ±4%)
- keala vs raw Bun: **0.80x** (±2% / ±1%)
- keala vs go net/http: **1.04x** (±2% / ±2%)

## 1000-route scale (late)

| Framework                       | Runtime |   req/s | noise |
| ------------------------------- | ------- | ------: | ----: |
| raw Bun.serve (scale)           | bun 1.4 | 179,088 |   ±3% |
| keala (scale)                   | bun 1.4 | 246,272 |   ±2% |
| hono 4 (scale)                  | bun 1.4 | 249,104 |   ±3% |
| keala (scale)                   | node 22 |  92,856 |   ±3% |
| hono 4 official adapter (scale) | node 22 |  91,568 |   ±3% |
| koa 3 (scale)                   | node 22 |  15,592 |   ±1% |
| fastify 5 (scale)               | node 22 |  93,936 |   ±2% |
| go net/http (scale)             | go 1.27 | 189,600 |   ±2% |

- keala vs koa 3: **15.79x** (±2% / ±1%)
- keala vs fastify 5: **2.62x** (±2% / ±2%)
- keala vs hono 4: **0.99x** (±2% / ±3%)
- keala vs raw Bun: **1.38x** (±2% / ±3%)
- keala vs go net/http: **1.30x** (±2% / ±2%)

## Latency under load (median of interleaved rounds)

| Framework                       | scenario                | p50 (ms) | p99 (ms) |
| ------------------------------- | ----------------------- | -------: | -------: |
| raw Bun.serve                   | Text response           |      0.0 |      1.0 |
| raw Bun.serve                   | JSON response           |      0.0 |      1.0 |
| raw Bun.serve                   | Param route             |      0.0 |      1.0 |
| raw Bun.serve                   | 3 middlewares           |      0.0 |      1.0 |
| keala                           | Text response           |      0.0 |      1.0 |
| keala                           | JSON response           |      0.0 |      1.0 |
| keala                           | Param route             |      0.0 |      1.0 |
| keala                           | 3 middlewares           |      0.0 |      2.0 |
| hono 4                          | Text response           |      0.0 |      1.0 |
| hono 4                          | JSON response           |      0.0 |      1.0 |
| hono 4                          | Param route             |      0.0 |      1.0 |
| hono 4                          | 3 middlewares           |      0.0 |      2.0 |
| keala                           | Text response           |      2.0 |      2.0 |
| keala                           | JSON response           |      2.0 |      2.0 |
| keala                           | Param route             |      2.0 |      2.0 |
| keala                           | 3 middlewares           |      3.0 |      3.0 |
| hono 4 official adapter         | Text response           |      3.0 |      3.0 |
| hono 4 official adapter         | JSON response           |      3.0 |      3.0 |
| hono 4 official adapter         | Param route             |      3.0 |      3.0 |
| hono 4 official adapter         | 3 middlewares           |      5.0 |      5.0 |
| koa 3                           | Text response           |      3.0 |      3.0 |
| koa 3                           | JSON response           |      3.0 |      3.0 |
| koa 3                           | Param route             |      3.0 |      3.0 |
| koa 3                           | 3 middlewares           |      3.0 |      3.0 |
| fastify 5                       | Text response           |      2.0 |      2.0 |
| fastify 5                       | JSON response           |      2.0 |      2.0 |
| fastify 5                       | Param route             |      2.0 |      2.0 |
| fastify 5                       | 3 middlewares           |      2.0 |      2.0 |
| koa 3                           | Text response           |      1.0 |      2.0 |
| koa 3                           | JSON response           |      1.0 |      3.0 |
| koa 3                           | Param route             |      1.0 |      2.0 |
| koa 3                           | 3 middlewares           |      1.0 |      2.0 |
| fastify 5                       | Text response           |      1.0 |      2.0 |
| fastify 5                       | JSON response           |      1.0 |      2.0 |
| fastify 5                       | Param route             |      1.0 |      2.0 |
| fastify 5                       | 3 middlewares           |      1.0 |      2.0 |
| go net/http                     | Text response           |      1.0 |      3.0 |
| go net/http                     | JSON response           |      1.0 |      3.0 |
| go net/http                     | Param route             |      1.0 |      3.0 |
| go net/http                     | 3 middlewares           |      1.0 |      3.0 |
| raw Bun.serve (scale)           | 1000-route scale (late) |      1.0 |      2.0 |
| keala (scale)                   | 1000-route scale (late) |      0.0 |      1.0 |
| hono 4 (scale)                  | 1000-route scale (late) |      0.0 |      1.0 |
| keala (scale)                   | 1000-route scale (late) |      2.0 |      2.0 |
| hono 4 official adapter (scale) | 1000-route scale (late) |      2.0 |      2.0 |
| koa 3 (scale)                   | 1000-route scale (late) |     12.0 |     14.0 |
| fastify 5 (scale)               | 1000-route scale (late) |      2.0 |      2.0 |
| go net/http (scale)             | 1000-route scale (late) |      1.0 |      3.0 |

## Memory footprint (sampled via /debug/memory)

| Framework                       | idle RSS | steady RSS | peak RSS | idle heap | steady heap |
| ------------------------------- | -------: | ---------: | -------: | --------: | ----------: |
| raw Bun.serve                   |   13.7MB |     18.3MB |   34.5MB |     0.1MB |       0.2MB |
| keala                           |   27.5MB |     26.9MB |   55.4MB |     0.9MB |       1.1MB |
| hono 4                          |   29.1MB |     24.5MB |   53.0MB |     0.5MB |       0.6MB |
| keala                           |   88.6MB |     48.1MB |  106.4MB |    11.3MB |      21.5MB |
| hono 4 official adapter         |   80.8MB |     48.7MB |  106.4MB |    11.9MB |      15.3MB |
| koa 3                           |   68.6MB |     46.0MB |  102.4MB |     9.7MB |      18.5MB |
| fastify 5                       |   64.4MB |     43.2MB |   99.3MB |    11.4MB |      22.4MB |
| koa 3                           |   40.9MB |     36.7MB |  131.5MB |     4.6MB |       4.5MB |
| fastify 5                       |   43.7MB |     52.5MB |  145.1MB |     6.1MB |       4.7MB |
| go net/http                     |   11.6MB |     14.5MB |   27.5MB |     0.3MB |       0.7MB |
| raw Bun.serve (scale)           |   19.3MB |     32.8MB |   35.2MB |     0.2MB |       0.2MB |
| keala (scale)                   |   36.4MB |     37.0MB |   46.4MB |     2.0MB |       1.9MB |
| hono 4 (scale)                  |   33.0MB |     36.4MB |   40.6MB |     1.4MB |       0.9MB |
| keala (scale)                   |   95.4MB |     95.9MB |  101.0MB |    12.4MB |      10.8MB |
| hono 4 official adapter (scale) |   83.0MB |     95.4MB |  100.3MB |    11.0MB |      17.3MB |
| koa 3 (scale)                   |   74.6MB |     97.9MB |  101.5MB |    12.5MB |      16.9MB |
| fastify 5 (scale)               |  106.0MB |     99.6MB |  103.7MB |    30.4MB |      27.8MB |
| go net/http (scale)             |   13.0MB |     26.0MB |   27.3MB |     1.2MB |       5.8MB |

---

## Reading this data honestly (ABAB-interleaved; three machines, 2026-08-31)

Methodology note: the previous report measured each server sequentially and
its per-scenario ratios carried up to ±25% order bias. All numbers here are
ABAB-interleaved — every server resident, firing in rotating order, 4 rounds
per scenario, ratio lines annotated with each side's run-to-run spread.
Response correctness (bodies + middleware headers) is asserted for every
server×scenario before any load runs.

Three machines contribute, and their ABSOLUTE numbers are not comparable:

- **8-core Apple Silicon** (client and servers co-resident, headroom to
  spare): the original throughput headline — `keala` ≈ 200–243k req/s.
- **4-core Intel** (i5-8257U, colocated client compresses everything ~4x):
  the original RELATIVE table with the Go reference.
- **10-core Apple M4** (the report above): the post-hardening regression
  check machine — `keala` ≈ 226–247k req/s, with the Go reference
  trailing the Bun trio here (179–188k) at this core count.

**keala vs hono 4: statistical parity — on all three machines.**

| M4 10-core (report above) |       keala |      hono 4 | ratio | verdict      |
| ------------------------- | ----------: | ----------: | ----: | ------------ |
| text                      | 226,144 ±7% | 223,280 ±4% | 1.01x | inside noise |
| JSON                      | 227,792 ±8% | 231,072 ±8% | 0.99x | inside noise |
| param                     | 225,472 ±6% | 224,816 ±6% | 1.00x | tie          |
| 3 middlewares             | 198,944 ±3% | 186,352 ±3% | 1.07x | leans ours   |
| 1000-route scale          | 247,232 ±3% | 249,024 ±3% | 0.99x | tie          |

| 8-core Apple Silicon  |         keala |        hono 4 |     ratio | verdict       |
| --------------------- | ------------: | ------------: | --------: | ------------- |
| text                  |  228,432 ±13% |  194,448 ±23% |     1.17x | inside noise  |
| JSON                  |  231,280 ±13% |  211,968 ±16% |     1.09x | inside noise  |
| param                 |  243,536 ±15% |  242,000 ±21% |     1.01x | tie           |
| 3 middlewares         |  206,224 ±15% |  195,056 ±10% |     1.06x | inside noise  |
| 1000-route scale      |   229,136 ±6% |   239,856 ±6% |     0.96x | inside noise  |
| **in-process ns/req** | **379 / 476** | **379 / 476** | **1.00x** | **exact tie** |

| Intel 4-core (colocated) |       keala |      hono 4 | ratio | verdict      |
| ------------------------ | ----------: | ----------: | ----: | ------------ |
| text                     | 56,764 ±13% | 52,884 ±21% | 1.07x | inside noise |
| JSON                     | 48,648 ±10% | 46,000 ±11% | 1.06x | inside noise |
| param                    | 47,604 ±18% | 50,088 ±11% | 0.95x | inside noise |
| 3 middlewares            |  39,396 ±1% |  39,072 ±2% | 1.01x | tight tie    |
| 1000-route scale         |  55,608 ±2% |  52,336 ±6% | 1.06x | inside noise |

**Where the gaps ARE real (far beyond any noise band):**

- **vs koa 3 (Node): 3.1–4.1x** on every scenario, **15.5–15.8x at 1000
  routes** (@koa/router's linear layer walk vs O(path) dispatch).
- **vs fastify 5 (Node): 2.4–3.3x**, and vs their Bun-compat placements
  (koa-on-bun, fastify-on-bun) still ~1.7x on the M4.
- **Idle memory**: keala 24–25MB vs hono 25–26MB on the M4 — the lazy
  native bridges keep this row at parity-or-better (pre-change Intel:
  19.1 vs 20.0MB). koa/fastify idle at 34–64MB and peak ~100MB.

**vs raw Bun.serve: 0.78–1.02x** — parity at this client scale (the
~140ns/req framework overhead measured in-process is a few percent of the
wire cost). **The 1000-route raw inversion is real and reproduced on all
three machines** (raw's native routes table loses to hash-map + trie
dispatch at 1000 entries; M4 run 2: keala 247k vs raw 179k, ±3%/±2%). The
explanation is a hypothesis, the measurement is not.

## Post-hardening regression check (Apple M4, 2026-08-31)

The 2026-08-31 hardening round fixed 30 defects (router keyspace conflation,
post-commit rewrite semantics, signed-cookie fail-open, pooling lifecycle
races, cache poisoning, validator bypass, …) — security and correctness work
that touches the per-request hot path (finalizer, context creation, sugar
constructors). This machine re-verified performance before shipping it, and
the bench DID catch a real regression:

**Found:** the pooled-context foreign-key sweep (which prevents cross-request
property disclosure) initially ran in `initContext` — i.e. on EVERY fresh
context, paying an `Object.keys()` allocation + loop per request on the
no-pooling hot path.

| in-process ns/req (best of 3)                        |     keala |    hono 4 | ratio to hono                  |
| ---------------------------------------------------- | --------: | --------: | ------------------------------ |
| pre-change baseline                                  | 384 / 490 | 386 / 488 | 0.995x / 1.004x                |
| hardening, first cut                                 | 421 / 528 | 378 / 496 | **1.11x / 1.06x** ← regression |
| hardening, sweep moved to the pool-recycle path only | 352 / 443 | 342 / 430 | 1.006x / 1.007x                |

The sweep now runs only in `resetContext` (a fresh `Object.create`d context
cannot carry foreign keys), the regression vanished, and the full suite
(1370 tests) stayed green. Parity with hono is preserved on the decisive
in-process baseline; absolute numbers moved between windows because the
machine moved — which is exactly why the ratio-to-hono column is the
trustworthy metric.

HTTP wire check, same machine, same protocol (200 conns, 8s fires, 4
interleaved rounds per run; post numbers are best-of-2 full runs, each
internally a median of 4 rounds):

| scenario (HTTP req/s) | pre-change | post-hardening | vs hono pre | vs hono post |
| --------------------- | ---------: | -------------: | ----------: | -----------: |
| text                  |    236,320 |        230,800 |       1.01x |   1.00–1.01x |
| JSON                  |    234,368 |        227,792 |       1.03x |   0.99–1.01x |
| param                 |    226,016 |        225,472 |       1.01x |   0.98–1.00x |
| 3 middlewares         |    193,680 |        198,944 |       1.04x |   0.98–1.07x |
| 1000-route scale      |    230,736 |        247,232 |       1.02x |   0.99–1.01x |

Every ratio sits inside its run-to-run noise band — the hardening round
costs nothing measurable on the wire. Memory idles at parity too (keala
24–25MB vs hono 25–26MB; peaks 58–59 vs 56–62MB across runs). This check is
the methodology paying for itself: the in-process baseline caught a +6–11%
regression that the first HTTP pass alone would have buried in noise.

**The Go reference on this box (net/http, go 1.27 darwin/arm64):** unlike
the 4-core Intel result, Go TRAILS the Bun trio here (179–188k vs 210–247k)
— with 10 cores the colocated autocannon workers stop being the bottleneck
and Bun's HTTP stack pulls ahead. The Intel conclusion ("Go leads by
~10–15%") is a small-box property, not a universal one; both measurements
stand.

## R4.6 lifecycle round (Apple M4, 2026-09-03)

R4.6 added graceful drain, overload admission, request deadlines and
cooperative cancellation — every request now passes an admission gate and a
guarded settle, and the Node adapter gained per-request WIRE accounting
(client-disconnect bridge + honest drain completion). A dedicated
head-to-head harness (`bench/run-r45-r46.mjs`) pins the R4.5 tip
(`3c4347f`) in an auto-created worktree and interleaves both trees' servers
in rotating order; the bench scripts themselves are byte-identical across
the two refs, so the only variable is the framework. Report artifact:
`bench/R45-R46.md` (200 conns, 8s fires, 6 interleaved rounds).

**Found:** the first pass measured a 3–5% Node-only throughput regression
(p50/p99 flat → pure per-request CPU). Root cause: 2 closures + 3 listener
registrations + 1 removal per request for wire truth (`res` finish/close
double-listening plus socket-level close). **Fix:** a single handler
registered on `res` `close` + socket `close` — `res` `close` fires for
every STARTED response (completed or terminated), so the `finish` listener
was strictly redundant, and `close` is also the more honest settle point
(last byte flushed, not handed to the kernel). Per request: 1 closure +
2 registrations + 1 removal.

| head-to-head (6 rounds) |   text |   JSON |  param |                 3 mw |
| ----------------------- | -----: | -----: | -----: | -------------------: |
| bun — R4.6/R4.5         | 0.990x | 0.993x | 0.994x | 0.955x (TIE, ±3/±7%) |
| node — R4.6/R4.5        | 0.987x | 0.984x | 0.991x |               0.984x |

Bun ties on every scenario. The Node residual (~1–1.6%) is the intrinsic
price of wire truth + the S4 disconnect bridge: socket-level `close` is the
ONLY observable for never-started pipelined responses (which emit no res
`close` at all on socket death) and for evicting queued requests whose
client walked away — removing it would be a semantic regression, not an
optimization. In-process, the unconfigured increment is +1ns
(416→417ns/req) with a 1.8ns/op fast-path probe — see
`docs/HOTPATH-R4-6-MIGRATION-LIFECYCLE.md` §8.

## The Go reference (net/http, Go 1.27 — Intel box, added 2026-08-31)

A stdlib `net/http` server with byte-identical responses joins the harness
(`bench/server-go`, auto-built when a Go toolchain exists). On the Intel box
it is the fastest participant, ahead of **raw Bun.serve** itself:

| Intel 4-core  |       keala |          Go | ratio | verdict              |
| ------------- | ----------: | ----------: | ----: | -------------------- |
| text          | 56,764 ±13% |  57,720 ±2% | 0.98x | inside noise         |
| JSON          | 48,648 ±10% |  56,228 ±3% | 0.87x | Go ahead, near-noise |
| param         | 47,604 ±18% | 55,268 ±36% | 0.86x | inside noise         |
| 3 middlewares |  39,396 ±1% |  54,972 ±4% | 0.72x | **real gap**         |
| 1000-route    |  55,608 ±2% |  62,976 ±2% | 0.88x | **real gap**         |

Honest reading: Go leads that field by ~10–15% in throughput and wins memory
outright (idle 5.9MB / peak 19.6MB — every JS runtime idles at 12–28MB and
peaks at 38–48MB). The gap sits BELOW the framework layer: raw Bun.serve
trails Go on the same box, and keala adds nothing to that gap versus hono
(both tie). The onion/middleware tower widens it to 0.72x — three JS
closures per request cost what Go pays in a static handler chain. Latency
flips at the tail: Go's p50 is lowest (2ms vs 3ms) but its p99 is the WORST
of the Bun-side group (19–21ms vs 8–10ms) under colocated contention —
scheduler queuing, not per-request cost. On the M4 the ordering inverts
(see the section above): core count decides this race, not the frameworks.

## Cross-machine replication (dedicated Intel machine)

The batch-interleaved in-process baseline on the same Intel machine:

| scenario          |             keala |            hono 4 | ratio |
| ----------------- | ----------------: | ----------------: | ----: |
| text, in-process  | 2,118 ns (472k/s) | 2,089 ns (479k/s) | 0.99x |
| param, in-process | 2,757 ns (363k/s) | 2,703 ns (370k/s) | 0.98x |

Parity replicates on completely different hardware at completely different
absolute speeds (8-core Apple Silicon: 379ns tie; Intel: ~2.1µs, same tie;
M4: 352ns, same tie).

An earlier session DISCARDED the Intel machine's HTTP layer (±31–214%
spreads from colocated client contention). The 2026-08-31 23:35 run —
machine otherwise idle — produced ±1–36% spreads and is published above as
the relative table; two earlier attempts that evening (user sessions active
on the box) reproduced the old ±65–126% pattern and were discarded.
Colocated HTTP on a 4-core box is usable only in quiet windows; treat its
absolutes as client-bound (~50–63k ceiling) and never compare them across
machines.

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
                               # optional 3rd arg: rounds (default 4)
node bench/run-r45-r46.mjs 8 6 # R4.5-vs-R4.6 head-to-head (auto worktree;
                               # KEALA_R45_REF pins the baseline, default 3c4347f)
bun bench/verify-baseline.ts   # in-process framework-overhead baseline
# Go reference: install any Go >= 1.22 toolchain — run.mjs builds it
# automatically and adds it to every scenario; without one it is skipped.
```
