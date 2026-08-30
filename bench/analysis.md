## bun-koa vs hono: deep-dive faceoff (in-process, ABAB interleaved)

**Where hono wins**

- Pure-text echo, fully warmed: hono **3.8–3.9M req/s vs bun-koa 2.7M (1.44x)**.
  Its single-Context + bare `c.text()` path is cheaper than the full Koa
  semantics (ctx/request/response trio + lazy API surface).
- Small route tables (50 routes): hono 1.34x — RegExpRouter shines at low
  route counts; cold boot 0.03ms vs 0.09ms (both imperceptible).

**Where bun-koa wins**

- **Route-table scaling**: crossover ≈150 routes. At 200 routes bun-koa is
  1.21x; at **1000 routes: 4.57x in-process (1420k vs 311k)** — hono's
  RegExpRouter degrades linearly, the trie stays O(path segments).
- At HTTP level with 1000 routes the gap persists: **174k vs 128k (1.37x)**
  on both hits and misses.
- Steady-state memory: 57MB RSS / 5.1MB heap vs hono's 69MB / 9.8MB.

**Ties**

- JSON bodies, 64KB payloads, 10-layer onions: identical (payload work
  dominates). Response-side allocation: 381 B/req on both. p50/p99 latency:
  identical. HTTP throughput on small route tables: 0.98–1.02x (noise).

**Honest correction**: an earlier micro-benchmark reported "at parity" for
the pure-text case — insufficient warmup under-measured hono. The 1.44x
in-process gap above is the accurate figure; it stays invisible over HTTP
where both frameworks ride Bun's HTTP stack at ~168k req/s.

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
