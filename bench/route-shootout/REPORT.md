# route shootout — the 12-route table, 6 stacks

Generated: 2026-09-05T12:35:47.747Z

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
| raw Bun.serve | bun 1.4.0 | 83,136 | ±15% |
| keala | bun 1.4.0 | 85,976 | ±28% |
| keala | node 26 | 35,635 | ±22% |
| hono 4 | bun 1.4.0 | 90,888 | ±17% |
| hono 4 official adapter | node 26 | 34,276 | ±11% |
- keala (bun) vs raw Bun.serve: **1.03x** (±28% / ±15%)
- keala (bun) vs hono 4: **0.95x** (±28% / ±17%)
- keala (node) vs hono 4 official adapter: **1.04x** (±22% / ±11%)

## static with same radix — GET /user/comments

| Framework | Runtime | req/s | noise |
| --- | --- | ---: | ---: |
| raw Bun.serve | bun 1.4.0 | 83,096 | ±3% |
| keala | bun 1.4.0 | 79,147 | ±18% |
| keala | node 26 | 28,734 | ±5% |
| hono 4 | bun 1.4.0 | 85,456 | ±24% |
| hono 4 official adapter | node 26 | 28,822 | ±4% |
- keala (bun) vs raw Bun.serve: **0.95x** (±18% / ±3%)
- keala (bun) vs hono 4: **0.93x** (±18% / ±24%)
- keala (node) vs hono 4 official adapter: **1.00x** (±5% / ±4%)

## dynamic route — GET /user/lookup/username/hey

| Framework | Runtime | req/s | noise |
| --- | --- | ---: | ---: |
| raw Bun.serve | bun 1.4.0 | 82,912 | ±9% |
| keala | bun 1.4.0 | 83,368 | ±8% |
| keala | node 26 | 26,844 | ±5% |
| hono 4 | bun 1.4.0 | 82,080 | ±3% |
| hono 4 official adapter | node 26 | 27,622 | ±5% |
- keala (bun) vs raw Bun.serve: **1.01x** (±8% / ±9%)
- keala (bun) vs hono 4: **1.02x** (±8% / ±3%)
- keala (node) vs hono 4 official adapter: **0.97x** (±5% / ±5%)

## mixed static dynamic — GET /event/abcd1234/comments

| Framework | Runtime | req/s | noise |
| --- | --- | ---: | ---: |
| raw Bun.serve | bun 1.4.0 | 78,256 | ±9% |
| keala | bun 1.4.0 | 81,432 | ±2% |
| keala | node 26 | 27,034 | ±6% |
| hono 4 | bun 1.4.0 | 82,664 | ±12% |
| hono 4 official adapter | node 26 | 28,010 | ±9% |
- keala (bun) vs raw Bun.serve: **1.04x** (±2% / ±9%)
- keala (bun) vs hono 4: **0.99x** (±2% / ±12%)
- keala (node) vs hono 4 official adapter: **0.97x** (±6% / ±9%)

## post — POST /event/abcd1234/comment

| Framework | Runtime | req/s | noise |
| --- | --- | ---: | ---: |
| raw Bun.serve | bun 1.4.0 | 75,672 | ±4% |
| keala | bun 1.4.0 | 79,376 | ±8% |
| keala | node 26 | 26,632 | ±2% |
| hono 4 | bun 1.4.0 | 81,272 | ±4% |
| hono 4 official adapter | node 26 | 23,676 | ±10% |
- keala (bun) vs raw Bun.serve: **1.05x** (±8% / ±4%)
- keala (bun) vs hono 4: **0.98x** (±8% / ±4%)
- keala (node) vs hono 4 official adapter: **1.12x** (±2% / ±10%)

## long static — GET /very/deeply/nested/route/hello/there

| Framework | Runtime | req/s | noise |
| --- | --- | ---: | ---: |
| raw Bun.serve | bun 1.4.0 | 81,832 | ±10% |
| keala | bun 1.4.0 | 86,904 | ±17% |
| keala | node 26 | 27,532 | ±2% |
| hono 4 | bun 1.4.0 | 88,704 | ±27% |
| hono 4 official adapter | node 26 | 29,106 | ±8% |
- keala (bun) vs raw Bun.serve: **1.06x** (±17% / ±10%)
- keala (bun) vs hono 4: **0.98x** (±17% / ±27%)
- keala (node) vs hono 4 official adapter: **0.95x** (±2% / ±8%)

## wildcard — GET /static/index.html

| Framework | Runtime | req/s | noise |
| --- | --- | ---: | ---: |
| raw Bun.serve | bun 1.4.0 | 80,376 | ±4% |
| keala | bun 1.4.0 | 75,374 | ±15% |
| keala | node 26 | 27,626 | ±4% |
| hono 4 | bun 1.4.0 | 82,280 | ±23% |
| hono 4 official adapter | node 26 | 28,146 | ±7% |
- keala (bun) vs raw Bun.serve: **0.94x** (±15% / ±4%)
- keala (bun) vs hono 4: **0.92x** (±15% / ±23%)
- keala (node) vs hono 4 official adapter: **0.98x** (±4% / ±7%)

## Latency under load (median of interleaved rounds)

| Framework | Runtime | scenario | p50 (ms) | p99 (ms) |
| --- | --- | --- | ---: | ---: |
| raw Bun.serve | bun 1.4.0 | short static | 2.0 | 4.0 |
| raw Bun.serve | bun 1.4.0 | static with same radix | 2.0 | 4.0 |
| raw Bun.serve | bun 1.4.0 | dynamic route | 2.0 | 4.0 |
| raw Bun.serve | bun 1.4.0 | mixed static dynamic | 2.0 | 4.0 |
| raw Bun.serve | bun 1.4.0 | post | 2.0 | 4.0 |
| raw Bun.serve | bun 1.4.0 | long static | 2.0 | 4.0 |
| raw Bun.serve | bun 1.4.0 | wildcard | 2.0 | 4.0 |
| keala | bun 1.4.0 | short static | 1.0 | 4.0 |
| keala | bun 1.4.0 | static with same radix | 2.0 | 8.0 |
| keala | bun 1.4.0 | dynamic route | 2.0 | 4.0 |
| keala | bun 1.4.0 | mixed static dynamic | 2.0 | 4.0 |
| keala | bun 1.4.0 | post | 2.0 | 4.0 |
| keala | bun 1.4.0 | long static | 1.0 | 13.0 |
| keala | bun 1.4.0 | wildcard | 2.0 | 21.0 |
| keala | node 26 | short static | 5.0 | 7.0 |
| keala | node 26 | static with same radix | 6.0 | 9.0 |
| keala | node 26 | dynamic route | 7.0 | 10.0 |
| keala | node 26 | mixed static dynamic | 7.0 | 9.0 |
| keala | node 26 | post | 7.0 | 10.0 |
| keala | node 26 | long static | 6.0 | 9.0 |
| keala | node 26 | wildcard | 6.0 | 9.0 |
| hono 4 | bun 1.4.0 | short static | 1.0 | 4.0 |
| hono 4 | bun 1.4.0 | static with same radix | 1.0 | 8.0 |
| hono 4 | bun 1.4.0 | dynamic route | 2.0 | 4.0 |
| hono 4 | bun 1.4.0 | mixed static dynamic | 2.0 | 4.0 |
| hono 4 | bun 1.4.0 | post | 2.0 | 4.0 |
| hono 4 | bun 1.4.0 | long static | 1.0 | 3.0 |
| hono 4 | bun 1.4.0 | wildcard | 2.0 | 4.0 |
| hono 4 official adapter | node 26 | short static | 5.0 | 7.0 |
| hono 4 official adapter | node 26 | static with same radix | 6.0 | 9.0 |
| hono 4 official adapter | node 26 | dynamic route | 6.0 | 10.0 |
| hono 4 official adapter | node 26 | mixed static dynamic | 6.0 | 9.0 |
| hono 4 official adapter | node 26 | post | 7.0 | 10.0 |
| hono 4 official adapter | node 26 | long static | 6.0 | 9.0 |
| hono 4 official adapter | node 26 | wildcard | 6.0 | 10.0 |

## Memory footprint (idle → steady → peak, via /debug/memory)

| Framework | Runtime | idle RSS | steady RSS | peak RSS | idle heap | steady heap |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| raw Bun.serve | bun 1.4.0 | 17.2MB | 29.1MB | 41.6MB | 0.1MB | 0.2MB |
| keala | bun 1.4.0 | 26.7MB | 37.8MB | 53.1MB | 0.7MB | 0.8MB |
| keala | node 26 | 101.0MB | 132.7MB | 139.9MB | 13.8MB | 14.0MB |
| hono 4 | bun 1.4.0 | 30.0MB | 36.5MB | 47.4MB | 0.3MB | 0.5MB |
| hono 4 official adapter | node 26 | 79.9MB | 110.9MB | 130.3MB | 15.0MB | 13.5MB |

