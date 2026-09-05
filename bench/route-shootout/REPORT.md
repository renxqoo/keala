# route shootout — the 12-route table, 6 stacks

Generated: 2026-09-05T16:41:40.976Z

- Load: autocannon, 200 connections, 8s/fire, 4 interleaved rounds, 4 client workers
- ABAB-interleaved: all servers resident, rotating first-fire order per round
- Correctness asserted for every server×scenario BEFORE any load (identical bodies)
- Runtimes: bun 1.4.2 (raw / keala / hono) vs node 26 (keala / hono)
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
| raw Bun.serve | bun 1.4.2 | 85,816 | ±13% |
| keala | bun 1.4.2 | 97,040 | ±4% |
| keala | node 26 | 35,671 | ±20% |
| hono 4 | bun 1.4.2 | 96,312 | ±15% |
| hono 4 official adapter | node 26 | 35,267 | ±5% |
- keala (bun) vs raw Bun.serve: **1.13x** (±4% / ±13%)
- keala (bun) vs hono 4: **1.01x** (±4% / ±15%)
- keala (node) vs hono 4 official adapter: **1.01x** (±20% / ±5%)

## static with same radix — GET /user/comments

| Framework | Runtime | req/s | noise |
| --- | --- | ---: | ---: |
| raw Bun.serve | bun 1.4.2 | 84,496 | ±11% |
| keala | bun 1.4.2 | 91,024 | ±12% |
| keala | node 26 | 29,028 | ±8% |
| hono 4 | bun 1.4.2 | 93,192 | ±7% |
| hono 4 official adapter | node 26 | 29,720 | ±10% |
- keala (bun) vs raw Bun.serve: **1.08x** (±12% / ±11%)
- keala (bun) vs hono 4: **0.98x** (±12% / ±7%)
- keala (node) vs hono 4 official adapter: **0.98x** (±8% / ±10%)

## dynamic route — GET /user/lookup/username/hey

| Framework | Runtime | req/s | noise |
| --- | --- | ---: | ---: |
| raw Bun.serve | bun 1.4.2 | 85,032 | ±6% |
| keala | bun 1.4.2 | 88,464 | ±7% |
| keala | node 26 | 27,662 | ±5% |
| hono 4 | bun 1.4.2 | 85,680 | ±5% |
| hono 4 official adapter | node 26 | 28,026 | ±5% |
- keala (bun) vs raw Bun.serve: **1.04x** (±7% / ±6%)
- keala (bun) vs hono 4: **1.03x** (±7% / ±5%)
- keala (node) vs hono 4 official adapter: **0.99x** (±5% / ±5%)

## mixed static dynamic — GET /event/abcd1234/comments

| Framework | Runtime | req/s | noise |
| --- | --- | ---: | ---: |
| raw Bun.serve | bun 1.4.2 | 80,480 | ±36% |
| keala | bun 1.4.2 | 85,888 | ±33% |
| keala | node 26 | 27,456 | ±6% |
| hono 4 | bun 1.4.2 | 85,216 | ±29% |
| hono 4 official adapter | node 26 | 27,198 | ±10% |
- keala (bun) vs raw Bun.serve: **1.07x** (±33% / ±36%)
- keala (bun) vs hono 4: **1.01x** (±33% / ±29%)
- keala (node) vs hono 4 official adapter: **1.01x** (±6% / ±10%)

## post — POST /event/abcd1234/comment

| Framework | Runtime | req/s | noise |
| --- | --- | ---: | ---: |
| raw Bun.serve | bun 1.4.2 | 80,608 | ±4% |
| keala | bun 1.4.2 | 80,488 | ±47% |
| keala | node 26 | 26,750 | ±9% |
| hono 4 | bun 1.4.2 | 88,240 | ±51% |
| hono 4 official adapter | node 26 | 23,516 | ±5% |
- keala (bun) vs raw Bun.serve: **1.00x** (±47% / ±4%)
- keala (bun) vs hono 4: **0.91x** (±47% / ±51%)
- keala (node) vs hono 4 official adapter: **1.14x** (±9% / ±5%)

## long static — GET /very/deeply/nested/route/hello/there

| Framework | Runtime | req/s | noise |
| --- | --- | ---: | ---: |
| raw Bun.serve | bun 1.4.2 | 85,896 | ±49% |
| keala | bun 1.4.2 | 91,960 | ±51% |
| keala | node 26 | 29,242 | ±13% |
| hono 4 | bun 1.4.2 | 93,504 | ±47% |
| hono 4 official adapter | node 26 | 28,718 | ±11% |
- keala (bun) vs raw Bun.serve: **1.07x** (±51% / ±49%)
- keala (bun) vs hono 4: **0.98x** (±51% / ±47%)
- keala (node) vs hono 4 official adapter: **1.02x** (±13% / ±11%)

## wildcard — GET /static/index.html

| Framework | Runtime | req/s | noise |
| --- | --- | ---: | ---: |
| raw Bun.serve | bun 1.4.2 | 87,296 | ±15% |
| keala | bun 1.4.2 | 82,632 | ±54% |
| keala | node 26 | 28,322 | ±6% |
| hono 4 | bun 1.4.2 | 87,784 | ±50% |
| hono 4 official adapter | node 26 | 27,388 | ±2% |
- keala (bun) vs raw Bun.serve: **0.95x** (±54% / ±15%)
- keala (bun) vs hono 4: **0.94x** (±54% / ±50%)
- keala (node) vs hono 4 official adapter: **1.03x** (±6% / ±2%)

## Latency under load (median of interleaved rounds)

| Framework | Runtime | scenario | p50 (ms) | p99 (ms) |
| --- | --- | --- | ---: | ---: |
| raw Bun.serve | bun 1.4.2 | short static | 1.0 | 4.0 |
| raw Bun.serve | bun 1.4.2 | static with same radix | 1.0 | 4.0 |
| raw Bun.serve | bun 1.4.2 | dynamic route | 2.0 | 4.0 |
| raw Bun.serve | bun 1.4.2 | mixed static dynamic | 2.0 | 5.0 |
| raw Bun.serve | bun 1.4.2 | post | 2.0 | 4.0 |
| raw Bun.serve | bun 1.4.2 | long static | 1.0 | 20.0 |
| raw Bun.serve | bun 1.4.2 | wildcard | 2.0 | 4.0 |
| keala | bun 1.4.2 | short static | 1.0 | 3.0 |
| keala | bun 1.4.2 | static with same radix | 1.0 | 3.0 |
| keala | bun 1.4.2 | dynamic route | 2.0 | 4.0 |
| keala | bun 1.4.2 | mixed static dynamic | 1.0 | 4.0 |
| keala | bun 1.4.2 | post | 2.0 | 4.0 |
| keala | bun 1.4.2 | long static | 1.0 | 16.0 |
| keala | bun 1.4.2 | wildcard | 2.0 | 4.0 |
| keala | node 26 | short static | 6.0 | 7.0 |
| keala | node 26 | static with same radix | 6.0 | 9.0 |
| keala | node 26 | dynamic route | 6.0 | 9.0 |
| keala | node 26 | mixed static dynamic | 6.0 | 10.0 |
| keala | node 26 | post | 7.0 | 10.0 |
| keala | node 26 | long static | 6.0 | 9.0 |
| keala | node 26 | wildcard | 6.0 | 9.0 |
| hono 4 | bun 1.4.2 | short static | 1.0 | 3.0 |
| hono 4 | bun 1.4.2 | static with same radix | 1.0 | 3.0 |
| hono 4 | bun 1.4.2 | dynamic route | 1.0 | 4.0 |
| hono 4 | bun 1.4.2 | mixed static dynamic | 1.0 | 4.0 |
| hono 4 | bun 1.4.2 | post | 1.0 | 4.0 |
| hono 4 | bun 1.4.2 | long static | 1.0 | 6.0 |
| hono 4 | bun 1.4.2 | wildcard | 1.0 | 20.0 |
| hono 4 official adapter | node 26 | short static | 5.0 | 7.0 |
| hono 4 official adapter | node 26 | static with same radix | 6.0 | 9.0 |
| hono 4 official adapter | node 26 | dynamic route | 6.0 | 9.0 |
| hono 4 official adapter | node 26 | mixed static dynamic | 6.0 | 10.0 |
| hono 4 official adapter | node 26 | post | 7.0 | 11.0 |
| hono 4 official adapter | node 26 | long static | 6.0 | 9.0 |
| hono 4 official adapter | node 26 | wildcard | 6.0 | 9.0 |

## Memory footprint (idle → steady → peak, via /debug/memory)

| Framework | Runtime | idle RSS | steady RSS | peak RSS | idle heap | steady heap |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| raw Bun.serve | bun 1.4.2 | 17.8MB | 30.5MB | 44.0MB | 0.1MB | 0.2MB |
| keala | bun 1.4.2 | 28.2MB | 40.1MB | 57.5MB | 0.7MB | 0.8MB |
| keala | node 26 | 101.3MB | 131.3MB | 137.8MB | 13.8MB | 16.7MB |
| hono 4 | bun 1.4.2 | 31.2MB | 38.4MB | 54.4MB | 0.3MB | 0.4MB |
| hono 4 official adapter | node 26 | 80.3MB | 112.1MB | 130.0MB | 15.2MB | 11.0MB |

