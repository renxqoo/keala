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
