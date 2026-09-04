# route shootout — the 12-route table, 6 stacks

Generated: 2026-09-04T20:16:03.368Z

- Load: autocannon, 200 connections, 8s/fire, 4 interleaved rounds, 4 client workers
- ABAB-interleaved: all servers resident, rotating first-fire order per round
- Correctness asserted for every server×scenario BEFORE any load (identical bodies)
- Runtimes: bun 1.4.0 (raw / keala / hono) vs node 22 (keala / hono) vs go 1.27
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
| raw Bun.serve | bun 1.4.0 | 221,120 | ±24% |
| keala | bun 1.4.0 | 241,232 | ±28% |
| keala | node 22 | 92,104 | ±4% |
| hono 4 | bun 1.4.0 | 216,752 | ±28% |
| hono 4 official adapter | node 22 | 93,224 | ±5% |
| go net/http | go 1.27 | 178,000 | ±8% |
- keala (bun) vs raw Bun.serve: **1.09x** (±28% / ±24%)
- keala (bun) vs hono 4: **1.11x** (±28% / ±28%)
- keala (bun) vs go net/http: **1.36x** (±28% / ±8%)
- keala (node) vs hono 4 official adapter: **0.99x** (±4% / ±5%)

## static with same radix — GET /user/comments

| Framework | Runtime | req/s | noise |
| --- | --- | ---: | ---: |
| raw Bun.serve | bun 1.4.0 | 243,072 | ±3% |
| keala | bun 1.4.0 | 248,448 | ±2% |
| keala | node 22 | 92,672 | ±0% |
| hono 4 | bun 1.4.0 | 244,656 | ±2% |
| hono 4 official adapter | node 22 | 92,368 | ±1% |
| go net/http | go 1.27 | 185,216 | ±4% |
- keala (bun) vs raw Bun.serve: **1.02x** (±2% / ±3%)
- keala (bun) vs hono 4: **1.02x** (±2% / ±2%)
- keala (bun) vs go net/http: **1.34x** (±2% / ±4%)
- keala (node) vs hono 4 official adapter: **1.00x** (±0% / ±1%)

## dynamic route — GET /user/lookup/username/hey

| Framework | Runtime | req/s | noise |
| --- | --- | ---: | ---: |
| raw Bun.serve | bun 1.4.0 | 241,488 | ±31% |
| keala | bun 1.4.0 | 230,368 | ±23% |
| keala | node 22 | 86,400 | ±5% |
| hono 4 | bun 1.4.0 | 238,016 | ±33% |
| hono 4 official adapter | node 22 | 89,552 | ±3% |
| go net/http | go 1.27 | 186,496 | ±1% |
- keala (bun) vs raw Bun.serve: **0.95x** (±23% / ±31%)
- keala (bun) vs hono 4: **0.97x** (±23% / ±33%)
- keala (bun) vs go net/http: **1.24x** (±23% / ±1%)
- keala (node) vs hono 4 official adapter: **0.96x** (±5% / ±3%)

## mixed static dynamic — GET /event/abcd1234/comments

| Framework | Runtime | req/s | noise |
| --- | --- | ---: | ---: |
| raw Bun.serve | bun 1.4.0 | 240,352 | ±2% |
| keala | bun 1.4.0 | 239,312 | ±2% |
| keala | node 22 | 90,224 | ±1% |
| hono 4 | bun 1.4.0 | 238,352 | ±2% |
| hono 4 official adapter | node 22 | 91,064 | ±24% |
| go net/http | go 1.27 | 186,592 | ±7% |
- keala (bun) vs raw Bun.serve: **1.00x** (±2% / ±2%)
- keala (bun) vs hono 4: **1.00x** (±2% / ±2%)
- keala (bun) vs go net/http: **1.28x** (±2% / ±7%)
- keala (node) vs hono 4 official adapter: **0.99x** (±1% / ±24%)

## post — POST /event/abcd1234/comment

| Framework | Runtime | req/s | noise |
| --- | --- | ---: | ---: |
| raw Bun.serve | bun 1.4.0 | 238,704 | ±0% |
| keala | bun 1.4.0 | 238,896 | ±2% |
| keala | node 22 | 88,432 | ±1% |
| hono 4 | bun 1.4.0 | 241,216 | ±2% |
| hono 4 official adapter | node 22 | 84,680 | ±1% |
| go net/http | go 1.27 | 185,936 | ±2% |
- keala (bun) vs raw Bun.serve: **1.00x** (±2% / ±0%)
- keala (bun) vs hono 4: **0.99x** (±2% / ±2%)
- keala (bun) vs go net/http: **1.28x** (±2% / ±2%)
- keala (node) vs hono 4 official adapter: **1.04x** (±1% / ±1%)

## long static — GET /very/deeply/nested/route/hello/there

| Framework | Runtime | req/s | noise |
| --- | --- | ---: | ---: |
| raw Bun.serve | bun 1.4.0 | 244,288 | ±1% |
| keala | bun 1.4.0 | 244,256 | ±3% |
| keala | node 22 | 92,416 | ±1% |
| hono 4 | bun 1.4.0 | 246,016 | ±2% |
| hono 4 official adapter | node 22 | 90,680 | ±2% |
| go net/http | go 1.27 | 186,192 | ±2% |
- keala (bun) vs raw Bun.serve: **1.00x** (±3% / ±1%)
- keala (bun) vs hono 4: **0.99x** (±3% / ±2%)
- keala (bun) vs go net/http: **1.31x** (±3% / ±2%)
- keala (node) vs hono 4 official adapter: **1.02x** (±1% / ±2%)

## wildcard — GET /static/index.html

| Framework | Runtime | req/s | noise |
| --- | --- | ---: | ---: |
| raw Bun.serve | bun 1.4.0 | 242,048 | ±2% |
| keala | bun 1.4.0 | 236,448 | ±1% |
| keala | node 22 | 88,784 | ±1% |
| hono 4 | bun 1.4.0 | 241,584 | ±2% |
| hono 4 official adapter | node 22 | 90,968 | ±1% |
| go net/http | go 1.27 | 185,488 | ±1% |
- keala (bun) vs raw Bun.serve: **0.98x** (±1% / ±2%)
- keala (bun) vs hono 4: **0.98x** (±1% / ±2%)
- keala (bun) vs go net/http: **1.27x** (±1% / ±1%)
- keala (node) vs hono 4 official adapter: **0.98x** (±1% / ±1%)

## Latency under load (median of interleaved rounds)

| Framework | Runtime | scenario | p50 (ms) | p99 (ms) |
| --- | --- | --- | ---: | ---: |
| raw Bun.serve | bun 1.4.0 | short static | 0.0 | 1.0 |
| raw Bun.serve | bun 1.4.0 | static with same radix | 0.0 | 1.0 |
| raw Bun.serve | bun 1.4.0 | dynamic route | 0.0 | 1.0 |
| raw Bun.serve | bun 1.4.0 | mixed static dynamic | 0.0 | 1.0 |
| raw Bun.serve | bun 1.4.0 | post | 0.0 | 1.0 |
| raw Bun.serve | bun 1.4.0 | long static | 0.0 | 1.0 |
| raw Bun.serve | bun 1.4.0 | wildcard | 0.0 | 1.0 |
| keala | bun 1.4.0 | short static | 0.0 | 2.0 |
| keala | bun 1.4.0 | static with same radix | 0.0 | 1.0 |
| keala | bun 1.4.0 | dynamic route | 0.0 | 2.0 |
| keala | bun 1.4.0 | mixed static dynamic | 0.0 | 1.0 |
| keala | bun 1.4.0 | post | 0.0 | 1.0 |
| keala | bun 1.4.0 | long static | 0.0 | 1.0 |
| keala | bun 1.4.0 | wildcard | 0.0 | 1.0 |
| keala | node 22 | short static | 2.0 | 2.0 |
| keala | node 22 | static with same radix | 2.0 | 2.0 |
| keala | node 22 | dynamic route | 2.0 | 4.0 |
| keala | node 22 | mixed static dynamic | 2.0 | 2.0 |
| keala | node 22 | post | 2.0 | 2.0 |
| keala | node 22 | long static | 2.0 | 2.0 |
| keala | node 22 | wildcard | 2.0 | 2.0 |
| hono 4 | bun 1.4.0 | short static | 0.0 | 2.0 |
| hono 4 | bun 1.4.0 | static with same radix | 0.0 | 1.0 |
| hono 4 | bun 1.4.0 | dynamic route | 0.0 | 2.0 |
| hono 4 | bun 1.4.0 | mixed static dynamic | 0.0 | 1.0 |
| hono 4 | bun 1.4.0 | post | 0.0 | 1.0 |
| hono 4 | bun 1.4.0 | long static | 0.0 | 1.0 |
| hono 4 | bun 1.4.0 | wildcard | 0.0 | 1.0 |
| hono 4 official adapter | node 22 | short static | 2.0 | 4.0 |
| hono 4 official adapter | node 22 | static with same radix | 2.0 | 2.0 |
| hono 4 official adapter | node 22 | dynamic route | 2.0 | 4.0 |
| hono 4 official adapter | node 22 | mixed static dynamic | 2.0 | 2.0 |
| hono 4 official adapter | node 22 | post | 2.0 | 2.0 |
| hono 4 official adapter | node 22 | long static | 2.0 | 2.0 |
| hono 4 official adapter | node 22 | wildcard | 2.0 | 2.0 |
| go net/http | go 1.27 | short static | 1.0 | 3.0 |
| go net/http | go 1.27 | static with same radix | 1.0 | 3.0 |
| go net/http | go 1.27 | dynamic route | 1.0 | 3.0 |
| go net/http | go 1.27 | mixed static dynamic | 1.0 | 3.0 |
| go net/http | go 1.27 | post | 1.0 | 3.0 |
| go net/http | go 1.27 | long static | 1.0 | 3.0 |
| go net/http | go 1.27 | wildcard | 1.0 | 3.0 |

## Memory footprint (idle → steady → peak, via /debug/memory)

| Framework | Runtime | idle RSS | steady RSS | peak RSS | idle heap | steady heap |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| raw Bun.serve | bun 1.4.0 | 14.0MB | 33.9MB | 42.2MB | 0.1MB | 0.2MB |
| keala | bun 1.4.0 | 25.6MB | 48.3MB | 57.4MB | 0.6MB | 0.8MB |
| keala | node 22 | 100.2MB | 107.4MB | 133.9MB | 11.7MB | 16.4MB |
| hono 4 | bun 1.4.0 | 27.2MB | 43.0MB | 47.4MB | 0.3MB | 0.5MB |
| hono 4 official adapter | node 22 | 80.7MB | 101.8MB | 120.1MB | 11.9MB | 16.2MB |
| go net/http | go 1.27 | 11.7MB | 28.4MB | 28.4MB | 0.3MB | 4.6MB |

