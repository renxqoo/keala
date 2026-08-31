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
  spare): the original throughput headline — `honu` ≈ 200–243k req/s.
- **4-core Intel** (i5-8257U, colocated client compresses everything ~4x):
  the original RELATIVE table with the Go reference.
- **10-core Apple M4** (the report above): the post-hardening regression
  check machine — `honu` ≈ 226–247k req/s, with the Go reference
  trailing the Bun trio here (179–188k) at this core count.

**honu vs hono 4: statistical parity — on all three machines.**

| M4 10-core (report above) |        honu |      hono 4 | ratio | verdict      |
| ------------------------- | ----------: | ----------: | ----: | ------------ |
| text                      | 226,144 ±7% | 223,280 ±4% | 1.01x | inside noise |
| JSON                      | 227,792 ±8% | 231,072 ±8% | 0.99x | inside noise |
| param                     | 225,472 ±6% | 224,816 ±6% | 1.00x | tie          |
| 3 middlewares             | 198,944 ±3% | 186,352 ±3% | 1.07x | leans ours   |
| 1000-route scale          | 247,232 ±3% | 249,024 ±3% | 0.99x | tie          |

| 8-core Apple Silicon  |          honu |        hono 4 |     ratio | verdict       |
| --------------------- | ------------: | ------------: | --------: | ------------- |
| text                  |  228,432 ±13% |  194,448 ±23% |     1.17x | inside noise  |
| JSON                  |  231,280 ±13% |  211,968 ±16% |     1.09x | inside noise  |
| param                 |  243,536 ±15% |  242,000 ±21% |     1.01x | tie           |
| 3 middlewares         |  206,224 ±15% |  195,056 ±10% |     1.06x | inside noise  |
| 1000-route scale      |   229,136 ±6% |   239,856 ±6% |     0.96x | inside noise  |
| **in-process ns/req** | **379 / 476** | **379 / 476** | **1.00x** | **exact tie** |

| Intel 4-core (colocated) |        honu |      hono 4 | ratio | verdict      |
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
- **Idle memory**: honu 24–25MB vs hono 25–26MB on the M4 — the lazy
  native bridges keep this row at parity-or-better (pre-change Intel:
  19.1 vs 20.0MB). koa/fastify idle at 34–64MB and peak ~100MB.

**vs raw Bun.serve: 0.78–1.02x** — parity at this client scale (the
~140ns/req framework overhead measured in-process is a few percent of the
wire cost). **The 1000-route raw inversion is real and reproduced on all
three machines** (raw's native routes table loses to hash-map + trie
dispatch at 1000 entries; M4 run 2: honu 247k vs raw 179k, ±3%/±2%). The
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

| in-process ns/req (best of 3)                        |      honu |    hono 4 | ratio to hono                  |
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
costs nothing measurable on the wire. Memory idles at parity too (honu
24–25MB vs hono 25–26MB; peaks 58–59 vs 56–62MB across runs). This check is
the methodology paying for itself: the in-process baseline caught a +6–11%
regression that the first HTTP pass alone would have buried in noise.

**The Go reference on this box (net/http, go 1.27 darwin/arm64):** unlike
the 4-core Intel result, Go TRAILS the Bun trio here (179–188k vs 210–247k)
— with 10 cores the colocated autocannon workers stop being the bottleneck
and Bun's HTTP stack pulls ahead. The Intel conclusion ("Go leads by
~10–15%") is a small-box property, not a universal one; both measurements
stand.

## The Go reference (net/http, Go 1.27 — Intel box, added 2026-08-31)

A stdlib `net/http` server with byte-identical responses joins the harness
(`bench/server-go`, auto-built when a Go toolchain exists). On the Intel box
it is the fastest participant, ahead of **raw Bun.serve** itself:

| Intel 4-core  |        honu |          Go | ratio | verdict              |
| ------------- | ----------: | ----------: | ----: | -------------------- |
| text          | 56,764 ±13% |  57,720 ±2% | 0.98x | inside noise         |
| JSON          | 48,648 ±10% |  56,228 ±3% | 0.87x | Go ahead, near-noise |
| param         | 47,604 ±18% | 55,268 ±36% | 0.86x | inside noise         |
| 3 middlewares |  39,396 ±1% |  54,972 ±4% | 0.72x | **real gap**         |
| 1000-route    |  55,608 ±2% |  62,976 ±2% | 0.88x | **real gap**         |

Honest reading: Go leads that field by ~10–15% in throughput and wins memory
outright (idle 5.9MB / peak 19.6MB — every JS runtime idles at 12–28MB and
peaks at 38–48MB). The gap sits BELOW the framework layer: raw Bun.serve
trails Go on the same box, and honu adds nothing to that gap versus hono
(both tie). The onion/middleware tower widens it to 0.72x — three JS
closures per request cost what Go pays in a static handler chain. Latency
flips at the tail: Go's p50 is lowest (2ms vs 3ms) but its p99 is the WORST
of the Bun-side group (19–21ms vs 8–10ms) under colocated contention —
scheduler queuing, not per-request cost. On the M4 the ordering inverts
(see the section above): core count decides this race, not the frameworks.

## Cross-machine replication (dedicated Intel machine)

The batch-interleaved in-process baseline on the same Intel machine:

| scenario          |              honu |            hono 4 | ratio |
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
bun bench/verify-baseline.ts   # in-process framework-overhead baseline
# Go reference: install any Go >= 1.22 toolchain — run.mjs builds it
# automatically and adds it to every scenario; without one it is skipped.
```
