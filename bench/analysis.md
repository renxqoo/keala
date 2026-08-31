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
