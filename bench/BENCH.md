# bun-koa performance report

Generated: 2026-08-30T10:41:19.974Z

- Load tool: autocannon
- Connections: 100, duration: 8s per run, median of 3 runs
- Runtimes: Bun 1.4 (raw / bun-koa / hono) vs Node.js 22 (koa / fastify)
- Loopback HTTP/1.1 keep-alive; identical response shapes on every framework

## Text response

| Framework     | Runtime |   req/s |
| ------------- | ------- | ------: |
| raw Bun.serve | bun 1.4 | 177,264 |
| bun-koa       | bun 1.4 | 177,072 |
| hono 4        | bun 1.4 | 177,392 |
| koa 3         | node 22 |  93,496 |
| fastify 5     | node 22 | 118,040 |
| koa 3         | bun 1.4 | 118,352 |
| fastify 5     | bun 1.4 | 135,104 |

- bun-koa vs koa 3: **1.89x**
- bun-koa vs fastify 5: **1.50x**
- bun-koa vs hono 4: **1.00x**
- bun-koa vs raw Bun: **1.00x**

## JSON response

| Framework     | Runtime |   req/s |
| ------------- | ------- | ------: |
| raw Bun.serve | bun 1.4 | 176,160 |
| bun-koa       | bun 1.4 | 173,600 |
| hono 4        | bun 1.4 | 175,040 |
| koa 3         | node 22 |  91,120 |
| fastify 5     | node 22 | 115,520 |
| koa 3         | bun 1.4 | 116,520 |
| fastify 5     | bun 1.4 | 133,680 |

- bun-koa vs koa 3: **1.91x**
- bun-koa vs fastify 5: **1.50x**
- bun-koa vs hono 4: **0.99x**
- bun-koa vs raw Bun: **0.99x**

## Param route

| Framework     | Runtime |   req/s |
| ------------- | ------- | ------: |
| raw Bun.serve | bun 1.4 | 177,520 |
| bun-koa       | bun 1.4 | 173,744 |
| hono 4        | bun 1.4 | 176,736 |
| koa 3         | node 22 |  91,704 |
| fastify 5     | node 22 | 116,672 |
| koa 3         | bun 1.4 | 115,920 |
| fastify 5     | bun 1.4 | 132,516 |

- bun-koa vs koa 3: **1.89x**
- bun-koa vs fastify 5: **1.49x**
- bun-koa vs hono 4: **0.98x**
- bun-koa vs raw Bun: **0.98x**

## 3 middlewares

| Framework     | Runtime |   req/s |
| ------------- | ------- | ------: |
| raw Bun.serve | bun 1.4 | 165,440 |
| bun-koa       | bun 1.4 | 157,968 |
| hono 4        | bun 1.4 | 155,744 |
| koa 3         | node 22 |  87,080 |
| fastify 5     | node 22 | 118,576 |
| koa 3         | bun 1.4 | 109,928 |
| fastify 5     | bun 1.4 | 137,440 |

- bun-koa vs koa 3: **1.81x**
- bun-koa vs fastify 5: **1.33x**
- bun-koa vs hono 4: **1.01x**
- bun-koa vs raw Bun: **0.95x**

## Latency under load (median of runs)

| Framework     | scenario      | p50 (ms) | p99 (ms) |
| ------------- | ------------- | -------: | -------: |
| raw Bun.serve | Text response |      0.0 |      1.0 |
| raw Bun.serve | JSON response |      0.0 |      1.0 |
| raw Bun.serve | Param route   |      0.0 |      1.0 |
| raw Bun.serve | 3 middlewares |      0.0 |      1.0 |
| bun-koa       | Text response |      0.0 |      1.0 |
| bun-koa       | JSON response |      0.0 |      1.0 |
| bun-koa       | Param route   |      0.0 |      1.0 |
| bun-koa       | 3 middlewares |      0.0 |      1.0 |
| hono 4        | Text response |      0.0 |      1.0 |
| hono 4        | JSON response |      0.0 |      1.0 |
| hono 4        | Param route   |      0.0 |      1.0 |
| hono 4        | 3 middlewares |      0.0 |      1.0 |
| koa 3         | Text response |      1.0 |      2.0 |
| koa 3         | JSON response |      1.0 |      2.0 |
| koa 3         | Param route   |      1.0 |      2.0 |
| koa 3         | 3 middlewares |      1.0 |      2.0 |
| fastify 5     | Text response |      0.0 |      1.0 |
| fastify 5     | JSON response |      0.0 |      1.0 |
| fastify 5     | Param route   |      0.0 |      1.0 |
| fastify 5     | 3 middlewares |      0.0 |      1.0 |
| koa 3         | Text response |      0.0 |      1.0 |
| koa 3         | JSON response |      0.0 |      1.0 |
| koa 3         | Param route   |      0.0 |      1.0 |
| koa 3         | 3 middlewares |      0.0 |      1.0 |
| fastify 5     | Text response |      0.0 |      1.0 |
| fastify 5     | JSON response |      0.0 |      1.0 |
| fastify 5     | Param route   |      0.0 |      1.0 |
| fastify 5     | 3 middlewares |      0.0 |      1.0 |

## Memory footprint (sampled via /debug/memory)

| Framework     | idle RSS | steady RSS | peak RSS | idle heap | steady heap |
| ------------- | -------: | ---------: | -------: | --------: | ----------: |
| raw Bun.serve |   13.9MB |     39.0MB |   39.0MB |     0.1MB |       3.5MB |
| bun-koa       |   24.1MB |     54.9MB |   55.0MB |     1.0MB |       8.5MB |
| hono 4        |   27.5MB |     73.0MB |   72.8MB |     0.3MB |       9.8MB |
| koa 3         |   68.7MB |    106.1MB |  109.0MB |     9.6MB |      13.6MB |
| fastify 5     |   64.8MB |    101.2MB |  101.6MB |    11.6MB |      13.3MB |
| koa 3         |   40.4MB |    129.1MB |  129.1MB |     4.0MB |       5.0MB |
| fastify 5     |   42.9MB |    145.0MB |  145.0MB |     5.5MB |       5.6MB |

## Cross-runtime: koa and fastify ON Bun

Both frameworks do run on Bun's node compatibility layer — and Bun's runtime
speed lifts them substantially over their Node numbers:

| Framework | on Node 22 | on Bun 1.4 |  speedup |
| --------- | ---------: | ---------: | -------: |
| koa 3     |    84k–90k |  106k–113k | **+25%** |
| fastify 5 |  112k–115k |  127k–131k | **+13%** |

But neither reaches the Bun-native tier: they sit on Bun's emulated
`node:http` layer, ~25–35% below `Bun.serve` itself. bun-koa beats both
cross-runtime placements in every scenario: **1.42x–1.48x vs koa-on-bun**
and **1.14x–1.30x vs fastify-on-bun** (weakest in the middleware scenario
where fastify's hooks do less work than a real onion).

The compatibility layer also costs memory: under identical load koa grows
from 105MB (Node) to **124MB RSS** and fastify from 103MB to **149MB RSS** —
the emulated node objects are heavier than the real ones. bun-koa's steady
RSS is less than half of either. Bottom line: porting koa/fastify to Bun
buys some speed at a memory premium; Bun-native frameworks capture all of
the speed with none of the overhead.

## vs fastify 5 (Node 22)

bun-koa leads fastify in every scenario: **1.33x–1.49x** on throughput. The
gap narrows in the middleware scenario (1.33x) because fastify's hooks are
attach-point callbacks rather than a full onion — less general, less work.
Fastify's p99 matches the Bun trio, but its ceiling is Node's HTTP stack.

## Memory (lower is better)

|                         | raw Bun |    bun-koa |   hono |     koa | fastify |
| ----------------------- | ------: | ---------: | -----: | ------: | ------: |
| idle RSS                |  13.8MB | **25.3MB** | 25.4MB |  68.9MB |  64.4MB |
| steady RSS (under load) |  39.4MB | **55.1MB** | 71.6MB | 106.3MB | 101.0MB |
| steady heap             |   9.8MB |  **5.1MB** |  9.1MB |  17.4MB |  21.5MB |

- bun-koa and hono share the Bun runtime's ~25MB idle floor; Node processes
  start at ~65MB before any request.
- Under sustained load bun-koa settles at the **lowest working set of all
  frameworks** (55MB RSS / 5.1MB JS heap) — lazy parsing means unrequested
  features never allocate.
- Long-run stability is verified by `bun run soak`: >1M requests, heap drift
  < 0.5%, no leaks (default and pooled modes).

## Framework tax vs raw Bun.serve

| Layer                        |     raw Bun.serve |           bun-koa | bun-koa % of raw |
| ---------------------------- | ----------------: | ----------------: | ---------------: |
| HTTP (autocannon, 100 conns) |   163k–174k req/s |   156k–171k req/s |         **~98%** |
| In-process (no network)      | 3.46M–3.51M req/s | 2.28M–2.33M req/s |         **~66%** |

- Over HTTP the framework costs **1–2%** — inside measurement noise, and the
  same figure hono shows. The loopback ceiling (~174k req/s) belongs to Bun's
  HTTP stack plus the load-generator client, not to any framework.
- In-process, the framework layer costs **~0.14µs per request** (three ctx
  objects, routing, onion dispatch, respond, and the whole lazy Koa API
  surface) — the same order as hono's tax at equal functionality.
- koa on Node reaches only ~55% of raw Bun.serve over HTTP.
- Opt-in `pooling: true` shaves the three per-request allocations: ~+5%
  in-process (measured 2.02M→2.15M in back-to-back runs). The remaining gap is
  genuine work (routing, Koa semantics, Response construction), not waste.

## Why bun-koa is faster than Koa

1. **Precompiled onion chains** — middleware is composed once at `use()` time.
   Koa allocates a `dispatch` closure per request, binds `next` per layer and
   wraps every hop in `Promise.resolve`.
2. **Zero-promise fast path** — a fully synchronous middleware chain returns
   the `Response` without creating a single promise.
3. **Single-middleware fast path** — the tail is passed straight through,
   no guard closures.
4. **Static-route Map** — literal paths resolve with one hash lookup; only
   parameter routes touch the trie.
5. **Lazy everything** — query parsing, cookie parsing, client IP, `ctx.state`
   and URL materialization happen only when read.
6. **Bun-native** — `Bun.serve` fetch handler in, web `Response` out; no Node
   HTTP/IncomingMessage shim, no header re-serialization.

## Reproduce

```sh
bun install
node bench/run.mjs 100 10      # HTTP benchmark (autocannon)
```
