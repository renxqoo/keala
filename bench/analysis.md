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
