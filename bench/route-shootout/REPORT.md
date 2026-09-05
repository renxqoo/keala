# route shootout — the 12-route table, 6 stacks

Generated: 2026-09-05T15:05:53.283Z

- Load: autocannon, 200 connections, 8s/fire, 4 interleaved rounds, 4 client workers
- ABAB-interleaved: all servers resident, rotating first-fire order per round
- Correctness asserted for every server×scenario BEFORE any load (identical bodies)
- Runtimes: bun 1.4.0 (raw / keala / hono) vs node 26 (keala / hono)
- Route table: 12 routes (5 static incl. one 6-deep, 6 param, 1 wildcard); probes: 7
- Ratios inside the ±noise bands are TIES, not wins

| # | route | shape |
| --- | --- | --- |
| 1 | `GET /user` | short static |
| 2 | `GET /user/comments` | static, same radix as #1 |
| 3 | `GET /user/avatar` | static, same radix as #1 |
| 4 | `GET /user/lookup/username/:username` | 4-segment param |
| 5 | `GET /user/lookup/email/:address` | param, same radix as #4 |
| 6 | `GET /event/:id` | param |
| 7 | `GET /event/:id/comments` | mixed static+param |
| 8 | `POST /event/:id/comment` | mixed, POST |
| 9 | `GET /map/:location/events` | mixed, other radix |
| 10 | `GET /status` | static |
| 11 | `GET /very/deeply/nested/route/hello/there` | 6-deep static |
| 12 | `GET /static/*` | wildcard |

## short static — GET /user

| Framework | Runtime | req/s | noise |
| --- | --- | ---: | ---: |
| raw Bun.serve | bun 1.4.0 | 87,912 | ±11% |
| keala | bun 1.4.0 | 87,136 | ±22% |
| keala | node 26 | 36,300 | ±23% |
| hono 4 | bun 1.4.0 | 86,088 | ±13% |
| hono 4 official adapter | node 26 | 34,745 | ±12% |
- keala (bun) vs raw Bun.serve: **0.99x** (±22% / ±11%)
- keala (bun) vs hono 4: **1.01x** (±22% / ±13%)
- keala (node) vs hono 4 official adapter: **1.04x** (±23% / ±12%)

## static with same radix — GET /user/comments

| Framework | Runtime | req/s | noise |
| --- | --- | ---: | ---: |
| raw Bun.serve | bun 1.4.0 | 78,750 | ±11% |
| keala | bun 1.4.0 | 71,276 | ±17% |
| keala | node 26 | 29,354 | ±6% |
| hono 4 | bun 1.4.0 | 81,934 | ±17% |
| hono 4 official adapter | node 26 | 29,512 | ±7% |
- keala (bun) vs raw Bun.serve: **0.91x** (±17% / ±11%)
- keala (bun) vs hono 4: **0.87x** (±17% / ±17%)
- keala (node) vs hono 4 official adapter: **0.99x** (±6% / ±7%)

## dynamic route — GET /user/lookup/username/hey

| Framework | Runtime | req/s | noise |
| --- | --- | ---: | ---: |
| raw Bun.serve | bun 1.4.0 | 68,749 | ±62% |
| keala | bun 1.4.0 | 60,300 | ±80% |
| keala | node 26 | 27,980 | ±11% |
| hono 4 | bun 1.4.0 | 68,625 | ±47% |
| hono 4 official adapter | node 26 | 28,066 | ±5% |
- keala (bun) vs raw Bun.serve: **0.88x** (±80% / ±62%)
- keala (bun) vs hono 4: **0.88x** (±80% / ±47%)
- keala (node) vs hono 4 official adapter: **1.00x** (±11% / ±5%)

## mixed static dynamic — GET /event/abcd1234/comments

| Framework | Runtime | req/s | noise |
| --- | --- | ---: | ---: |
| raw Bun.serve | bun 1.4.0 | 74,158 | ±60% |
| keala | bun 1.4.0 | 69,027 | ±49% |
| keala | node 26 | 28,552 | ±4% |
| hono 4 | bun 1.4.0 | 62,495 | ±52% |
| hono 4 official adapter | node 26 | 27,778 | ±8% |
- keala (bun) vs raw Bun.serve: **0.93x** (±49% / ±60%)
- keala (bun) vs hono 4: **1.10x** (±49% / ±52%)
- keala (node) vs hono 4 official adapter: **1.03x** (±4% / ±8%)

## post — POST /event/abcd1234/comment

| Framework | Runtime | req/s | noise |
| --- | --- | ---: | ---: |
| raw Bun.serve | bun 1.4.0 | 65,483 | ±66% |
| keala | bun 1.4.0 | 81,640 | ±32% |
| keala | node 26 | 27,116 | ±53% |
| hono 4 | bun 1.4.0 | 61,625 | ±10% |
| hono 4 official adapter | node 26 | 25,114 | ±8% |
- keala (bun) vs raw Bun.serve: **1.25x** (±32% / ±66%)
- keala (bun) vs hono 4: **1.32x** (±32% / ±10%)
- keala (node) vs hono 4 official adapter: **1.08x** (±53% / ±8%)

## long static — GET /very/deeply/nested/route/hello/there

| Framework | Runtime | req/s | noise |
| --- | --- | ---: | ---: |
| raw Bun.serve | bun 1.4.0 | 47,806 | ±79% |
| keala | bun 1.4.0 | 58,612 | ±72% |
| keala | node 26 | 28,460 | ±3% |
| hono 4 | bun 1.4.0 | 37,849 | ±101% |
| hono 4 official adapter | node 26 | 27,846 | ±6% |
- keala (bun) vs raw Bun.serve: **1.23x** (±72% / ±79%)
- keala (bun) vs hono 4: **1.55x** (±72% / ±101%)
- keala (node) vs hono 4 official adapter: **1.02x** (±3% / ±6%)

## wildcard — GET /static/index.html

| Framework | Runtime | req/s | noise |
| --- | --- | ---: | ---: |
| raw Bun.serve | bun 1.4.0 | 35,490 | ±68% |
| keala | bun 1.4.0 | 52,720 | ±57% |
| keala | node 26 | 28,304 | ±3% |
| hono 4 | bun 1.4.0 | 35,952 | ±100% |
| hono 4 official adapter | node 26 | 27,430 | ±5% |
- keala (bun) vs raw Bun.serve: **1.49x** (±57% / ±68%)
- keala (bun) vs hono 4: **1.47x** (±57% / ±100%)
- keala (node) vs hono 4 official adapter: **1.03x** (±3% / ±5%)

## Latency under load (median of interleaved rounds)

| Framework | Runtime | scenario | p50 (ms) | p99 (ms) |
| --- | --- | --- | ---: | ---: |
| raw Bun.serve | bun 1.4.0 | short static | 1.0 | 4.0 |
| raw Bun.serve | bun 1.4.0 | static with same radix | 2.0 | 17.0 |
| raw Bun.serve | bun 1.4.0 | dynamic route | 2.0 | 29.0 |
| raw Bun.serve | bun 1.4.0 | mixed static dynamic | 2.0 | 19.0 |
| raw Bun.serve | bun 1.4.0 | post | 2.0 | 29.0 |
| raw Bun.serve | bun 1.4.0 | long static | 2.0 | 29.0 |
| raw Bun.serve | bun 1.4.0 | wildcard | 2.0 | 32.0 |
| keala | bun 1.4.0 | short static | 1.0 | 4.0 |
| keala | bun 1.4.0 | static with same radix | 2.0 | 19.0 |
| keala | bun 1.4.0 | dynamic route | 1.0 | 27.0 |
| keala | bun 1.4.0 | mixed static dynamic | 2.0 | 28.0 |
| keala | bun 1.4.0 | post | 2.0 | 26.0 |
| keala | bun 1.4.0 | long static | 2.0 | 26.0 |
| keala | bun 1.4.0 | wildcard | 2.0 | 29.0 |
| keala | node 26 | short static | 5.0 | 9.0 |
| keala | node 26 | static with same radix | 6.0 | 9.0 |
| keala | node 26 | dynamic route | 6.0 | 9.0 |
| keala | node 26 | mixed static dynamic | 6.0 | 9.0 |
| keala | node 26 | post | 6.0 | 10.0 |
| keala | node 26 | long static | 6.0 | 9.0 |
| keala | node 26 | wildcard | 6.0 | 10.0 |
| hono 4 | bun 1.4.0 | short static | 1.0 | 7.0 |
| hono 4 | bun 1.4.0 | static with same radix | 1.0 | 18.0 |
| hono 4 | bun 1.4.0 | dynamic route | 2.0 | 27.0 |
| hono 4 | bun 1.4.0 | mixed static dynamic | 2.0 | 29.0 |
| hono 4 | bun 1.4.0 | post | 2.0 | 27.0 |
| hono 4 | bun 1.4.0 | long static | 2.0 | 30.0 |
| hono 4 | bun 1.4.0 | wildcard | 2.0 | 31.0 |
| hono 4 official adapter | node 26 | short static | 5.0 | 8.0 |
| hono 4 official adapter | node 26 | static with same radix | 6.0 | 8.0 |
| hono 4 official adapter | node 26 | dynamic route | 6.0 | 9.0 |
| hono 4 official adapter | node 26 | mixed static dynamic | 7.0 | 9.0 |
| hono 4 official adapter | node 26 | post | 7.0 | 10.0 |
| hono 4 official adapter | node 26 | long static | 6.0 | 10.0 |
| hono 4 official adapter | node 26 | wildcard | 6.0 | 9.0 |

## Memory footprint (idle → steady → peak, via /debug/memory)

| Framework | Runtime | idle RSS | steady RSS | peak RSS | idle heap | steady heap |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| raw Bun.serve | bun 1.4.0 | 17.4MB | 29.0MB | 41.4MB | 0.1MB | 0.2MB |
| keala | bun 1.4.0 | 28.6MB | 38.7MB | 53.6MB | 0.7MB | 0.8MB |
| keala | node 26 | 102.1MB | 132.0MB | 139.3MB | 13.4MB | 12.8MB |
| hono 4 | bun 1.4.0 | 30.4MB | 37.1MB | 47.1MB | 0.3MB | 0.5MB |
| hono 4 official adapter | node 26 | 80.0MB | 110.9MB | 129.5MB | 15.1MB | 10.9MB |

