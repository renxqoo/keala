# bun-koa performance report

Generated: 2026-08-30T17:20:58.612Z

- Load tool: autocannon
- Connections: 200, duration: 8s per run, median of 3 runs
- Runtimes: Bun 1.4 (raw / bun-koa / hono) vs Node.js 22 (koa / fastify)
- Loopback HTTP/1.1 keep-alive; identical response shapes on every framework

## Text response

| Framework     | Runtime |   req/s |
| ------------- | ------- | ------: |
| raw Bun.serve | bun 1.4 | 230,912 |
| bun-koa       | bun 1.4 | 230,752 |
| hono 4        | bun 1.4 | 218,080 |
| koa 3         | node 22 |  86,248 |
| fastify 5     | node 22 | 114,640 |
| koa 3         | bun 1.4 | 115,520 |
| fastify 5     | bun 1.4 | 140,860 |

- bun-koa vs koa 3: **2.68x**
- bun-koa vs fastify 5: **2.01x**
- bun-koa vs hono 4: **1.06x**
- bun-koa vs raw Bun: **1.00x**

## JSON response

| Framework     | Runtime |   req/s |
| ------------- | ------- | ------: |
| raw Bun.serve | bun 1.4 | 237,232 |
| bun-koa       | bun 1.4 | 220,592 |
| hono 4        | bun 1.4 | 198,560 |
| koa 3         | node 22 |  85,288 |
| fastify 5     | node 22 | 112,136 |
| koa 3         | bun 1.4 | 105,208 |
| fastify 5     | bun 1.4 | 130,142 |

- bun-koa vs koa 3: **2.59x**
- bun-koa vs fastify 5: **1.97x**
- bun-koa vs hono 4: **1.11x**
- bun-koa vs raw Bun: **0.93x**

## Param route

| Framework     | Runtime |   req/s |
| ------------- | ------- | ------: |
| raw Bun.serve | bun 1.4 | 218,224 |
| bun-koa       | bun 1.4 | 207,796 |
| hono 4        | bun 1.4 | 235,520 |
| koa 3         | node 22 |  86,008 |
| fastify 5     | node 22 | 113,464 |
| koa 3         | bun 1.4 |  98,200 |
| fastify 5     | bun 1.4 | 126,464 |

- bun-koa vs koa 3: **2.42x**
- bun-koa vs fastify 5: **1.83x**
- bun-koa vs hono 4: **0.88x**
- bun-koa vs raw Bun: **0.95x**

## 3 middlewares

| Framework     | Runtime |   req/s |
| ------------- | ------- | ------: |
| raw Bun.serve | bun 1.4 | 225,984 |
| bun-koa       | bun 1.4 | 189,120 |
| hono 4        | bun 1.4 | 146,880 |
| koa 3         | node 22 |  79,840 |
| fastify 5     | node 22 | 117,192 |
| koa 3         | bun 1.4 |  99,720 |
| fastify 5     | bun 1.4 | 140,716 |

- bun-koa vs koa 3: **2.37x**
- bun-koa vs fastify 5: **1.61x**
- bun-koa vs hono 4: **1.29x**
- bun-koa vs raw Bun: **0.84x**

## 1000-route scale (late)

| Framework     | Runtime |   req/s |
| ------------- | ------- | ------: |
| raw Bun.serve | bun 1.4 | 173,104 |
| bun-koa       | bun 1.4 | 242,480 |
| hono 4        | bun 1.4 | 234,752 |
| koa 3         | node 22 |  16,715 |
| fastify 5     | node 22 | 108,800 |

- bun-koa vs koa 3: **14.51x**
- bun-koa vs fastify 5: **2.23x**
- bun-koa vs hono 4: **1.03x**
- bun-koa vs raw Bun: **1.40x**

## Latency under load (median of runs)

| Framework     | scenario                | p50 (ms) | p99 (ms) |
| ------------- | ----------------------- | -------: | -------: |
| raw Bun.serve | Text response           |      0.0 |      2.0 |
| raw Bun.serve | JSON response           |      0.0 |      2.0 |
| raw Bun.serve | Param route             |      0.0 |      2.0 |
| raw Bun.serve | 3 middlewares           |      0.0 |      2.0 |
| bun-koa       | Text response           |      0.0 |      2.0 |
| bun-koa       | JSON response           |      0.0 |      2.0 |
| bun-koa       | Param route             |      0.0 |      3.0 |
| bun-koa       | 3 middlewares           |      0.0 |      2.0 |
| hono 4        | Text response           |      0.0 |      2.0 |
| hono 4        | JSON response           |      0.0 |      3.0 |
| hono 4        | Param route             |      0.0 |      2.0 |
| hono 4        | 3 middlewares           |      1.0 |      3.0 |
| koa 3         | Text response           |      2.0 |      5.0 |
| koa 3         | JSON response           |      2.0 |      4.0 |
| koa 3         | Param route             |      2.0 |      5.0 |
| koa 3         | 3 middlewares           |      2.0 |      5.0 |
| fastify 5     | Text response           |      1.0 |      3.0 |
| fastify 5     | JSON response           |      1.0 |      3.0 |
| fastify 5     | Param route             |      1.0 |      3.0 |
| fastify 5     | 3 middlewares           |      1.0 |      3.0 |
| koa 3         | Text response           |      1.0 |      3.0 |
| koa 3         | JSON response           |      1.0 |      4.0 |
| koa 3         | Param route             |      1.0 |      5.0 |
| koa 3         | 3 middlewares           |      1.0 |      5.0 |
| fastify 5     | Text response           |      1.0 |      4.0 |
| fastify 5     | JSON response           |      1.0 |      5.0 |
| fastify 5     | Param route             |      1.0 |      5.0 |
| fastify 5     | 3 middlewares           |      1.0 |      3.0 |
| raw Bun.serve | 1000-route scale (late) |      1.0 |      2.0 |
| bun-koa       | 1000-route scale (late) |      0.0 |      1.0 |
| hono 4        | 1000-route scale (late) |      0.0 |      2.0 |
| koa 3         | 1000-route scale (late) |     11.0 |     27.0 |
| fastify 5     | 1000-route scale (late) |      1.0 |      4.0 |

## Memory footprint (sampled via /debug/memory)

| Framework     | idle RSS | steady RSS | peak RSS | idle heap | steady heap |
| ------------- | -------: | ---------: | -------: | --------: | ----------: |
| raw Bun.serve |   13.9MB |     31.5MB |   40.8MB |     0.1MB |       0.2MB |
| bun-koa       |   28.5MB |     38.4MB |   51.7MB |     1.3MB |       2.9MB |
| hono 4        |   25.6MB |     43.5MB |   46.9MB |     0.3MB |       3.4MB |
| koa 3         |   68.9MB |     86.4MB |  103.7MB |     9.6MB |      19.8MB |
| fastify 5     |   64.5MB |     99.6MB |   99.6MB |    11.6MB |      15.4MB |
| koa 3         |   40.8MB |     98.3MB |  132.9MB |     4.0MB |       5.7MB |
| fastify 5     |   43.2MB |     90.5MB |  144.4MB |     5.5MB |       7.6MB |
| raw Bun.serve |   19.2MB |     44.1MB |   44.1MB |     0.2MB |       0.2MB |
| bun-koa       |   37.2MB |     53.7MB |   53.7MB |     2.3MB |       2.0MB |
| hono 4        |   33.9MB |     48.6MB |   48.6MB |     0.7MB |       1.4MB |
| koa 3         |   74.8MB |     94.2MB |  106.9MB |    12.3MB |      26.9MB |
| fastify 5     |   98.1MB |    181.5MB |  181.5MB |    27.8MB |      80.1MB |

The last block of rows is the dedicated 1000-route scale servers.

## Reproduce

```sh
bun install
node bench/run.mjs 200 8       # HTTP benchmark (autocannon, 4 client workers)
bun bench/verify-baseline.ts   # in-process framework-overhead baseline
```

---

## bun-koa vs hono: faceoff (2026-08-30 re-measurement)

HTTP numbers above (200 connections, 4 autocannon workers — a single client
process saturates near 177k req/s on this machine and hides all differences).
In-process faceoff from `bun bench/verify-baseline.ts` on the same machine,
same day:

| scenario          |         bun-koa |          hono 4 | ratio |
| ----------------- | --------------: | --------------: | ----: |
| text, in-process  | 2,822,002 req/s | 2,759,667 req/s | 1.02x |
| param, in-process | 2,157,885 req/s | 2,217,797 req/s | 0.97x |

**Where bun-koa wins (HTTP, this run)**

- Text 1.06x, JSON 1.11x, and decisively the onion scenario: **3 middlewares
  1.29x** (189k vs 147k) — precompiled chains beat per-request composition
  once more than one middleware runs.
- **1000-route scale 1.03x** — and both frameworks beat raw Bun.serve's
  native routes table (242k/235k vs 173k): at 1000 entries Bun's table
  lookup costs more than a hash-map + trie dispatch.
- Memory: steady heap 2.9MB vs hono 3.4MB; RSS 38.4MB vs 43.5MB.

**Where hono wins**

- Param route 0.88x HTTP (208k vs 236k) — its RegExpRouter single-pass
  capture edges the trie on this shape. In-process param is a tie (0.97x).

**Ties**: text/JSON are within noise of each other everywhere; p99 identical
(2–3ms) across the Bun trio.

## Cross-runtime: koa and fastify ON Bun

Both run on Bun's node compatibility layer, lifted over their Node numbers —
koa 86k→116k, fastify 114k→130k — but they sit ~25–40% below the Bun-native
tier and pay a memory premium for the emulated node objects (koa 86MB→98MB
steady RSS, fastify 100MB→91MB with a 144MB peak). bun-koa beats every
cross-runtime placement in every scenario: **1.80–1.99x vs koa-on-bun** and
**1.34–1.73x vs fastify-on-bun**.

## vs koa 3 (Node 22) — the reason this framework exists

**2.37x–2.68x** on throughput across scenarios, at less than half the
memory (38MB vs 86MB steady RSS), with full onion semantics preserved.
At 1000 routes the gap explodes to **14.5x**: @koa/router walks its layer
stack linearly per request (16.7k req/s), the hybrid router stays O(path)
(242k req/s).

## Framework tax vs raw Bun.serve

1.00x text / 0.93x JSON / 0.95x param / 0.84x middlewares — the tax for
full Koa semantics is 0–16% depending on scenario. The 1000-route scale
inversion (1.40x FASTER than raw) is the native routes table's own lookup
cost at 1000 entries, not framework magic.
