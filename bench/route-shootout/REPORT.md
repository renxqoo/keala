# route shootout — the 12-route table, 6 stacks

Generated: 2026-09-05T09:53:33.742Z

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
| raw Bun.serve | bun 1.4.0 | 195,504 | ±12% |
| keala | bun 1.4.0 | 239,440 | ±33% |
| keala | node 22 | 90,848 | ±5% |
| hono 4 | bun 1.4.0 | 205,584 | ±34% |
| hono 4 official adapter | node 22 | 94,544 | ±6% |
| go net/http | go 1.27 | 171,472 | ±8% |
- keala (bun) vs raw Bun.serve: **1.22x** (±33% / ±12%)
- keala (bun) vs hono 4: **1.16x** (±33% / ±34%)
- keala (bun) vs go net/http: **1.40x** (±33% / ±8%)
- keala (node) vs hono 4 official adapter: **0.96x** (±5% / ±6%)

## static with same radix — GET /user/comments

| Framework | Runtime | req/s | noise |
| --- | --- | ---: | ---: |
| raw Bun.serve | bun 1.4.0 | 208,160 | ±28% |
| keala | bun 1.4.0 | 194,016 | ±40% |
| keala | node 22 | 89,856 | ±5% |
| hono 4 | bun 1.4.0 | 231,968 | ±31% |
| hono 4 official adapter | node 22 | 90,712 | ±4% |
| go net/http | go 1.27 | 166,032 | ±11% |
- keala (bun) vs raw Bun.serve: **0.93x** (±40% / ±28%)
- keala (bun) vs hono 4: **0.84x** (±40% / ±31%)
- keala (bun) vs go net/http: **1.17x** (±40% / ±11%)
- keala (node) vs hono 4 official adapter: **0.99x** (±5% / ±4%)

## dynamic route — GET /user/lookup/username/hey

| Framework | Runtime | req/s | noise |
| --- | --- | ---: | ---: |
| raw Bun.serve | bun 1.4.0 | 243,808 | ±3% |
| keala | bun 1.4.0 | 239,168 | ±3% |
| keala | node 22 | 85,848 | ±3% |
| hono 4 | bun 1.4.0 | 238,800 | ±3% |
| hono 4 official adapter | node 22 | 90,864 | ±1% |
| go net/http | go 1.27 | 182,624 | ±3% |
- keala (bun) vs raw Bun.serve: **0.98x** (±3% / ±3%)
- keala (bun) vs hono 4: **1.00x** (±3% / ±3%)
- keala (bun) vs go net/http: **1.31x** (±3% / ±3%)
- keala (node) vs hono 4 official adapter: **0.94x** (±3% / ±1%)

## mixed static dynamic — GET /event/abcd1234/comments

| Framework | Runtime | req/s | noise |
| --- | --- | ---: | ---: |
| raw Bun.serve | bun 1.4.0 | 244,000 | ±5% |
| keala | bun 1.4.0 | 243,984 | ±7% |
| keala | node 22 | 88,712 | ±2% |
| hono 4 | bun 1.4.0 | 237,968 | ±4% |
| hono 4 official adapter | node 22 | 90,720 | ±2% |
| go net/http | go 1.27 | 180,096 | ±4% |
- keala (bun) vs raw Bun.serve: **1.00x** (±7% / ±5%)
- keala (bun) vs hono 4: **1.03x** (±7% / ±4%)
- keala (bun) vs go net/http: **1.35x** (±7% / ±4%)
- keala (node) vs hono 4 official adapter: **0.98x** (±2% / ±2%)

## post — POST /event/abcd1234/comment

| Framework | Runtime | req/s | noise |
| --- | --- | ---: | ---: |
| raw Bun.serve | bun 1.4.0 | 233,920 | ±3% |
| keala | bun 1.4.0 | 236,320 | ±30% |
| keala | node 22 | 89,072 | ±18% |
| hono 4 | bun 1.4.0 | 238,512 | ±30% |
| hono 4 official adapter | node 22 | 83,632 | ±6% |
| go net/http | go 1.27 | 183,456 | ±16% |
- keala (bun) vs raw Bun.serve: **1.01x** (±30% / ±3%)
- keala (bun) vs hono 4: **0.99x** (±30% / ±30%)
- keala (bun) vs go net/http: **1.29x** (±30% / ±16%)
- keala (node) vs hono 4 official adapter: **1.07x** (±18% / ±6%)

## long static — GET /very/deeply/nested/route/hello/there

| Framework | Runtime | req/s | noise |
| --- | --- | ---: | ---: |
| raw Bun.serve | bun 1.4.0 | 246,384 | ±3% |
| keala | bun 1.4.0 | 247,168 | ±3% |
| keala | node 22 | 90,672 | ±1% |
| hono 4 | bun 1.4.0 | 242,384 | ±1% |
| hono 4 official adapter | node 22 | 90,512 | ±2% |
| go net/http | go 1.27 | 187,872 | ±1% |
- keala (bun) vs raw Bun.serve: **1.00x** (±3% / ±3%)
- keala (bun) vs hono 4: **1.02x** (±3% / ±1%)
- keala (bun) vs go net/http: **1.32x** (±3% / ±1%)
- keala (node) vs hono 4 official adapter: **1.00x** (±1% / ±2%)

## wildcard — GET /static/index.html

| Framework | Runtime | req/s | noise |
| --- | --- | ---: | ---: |
| raw Bun.serve | bun 1.4.0 | 244,784 | ±30% |
| keala | bun 1.4.0 | 237,264 | ±20% |
| keala | node 22 | 89,208 | ±2% |
| hono 4 | bun 1.4.0 | 237,648 | ±29% |
| hono 4 official adapter | node 22 | 89,880 | ±5% |
| go net/http | go 1.27 | 186,848 | ±9% |
- keala (bun) vs raw Bun.serve: **0.97x** (±20% / ±30%)
- keala (bun) vs hono 4: **1.00x** (±20% / ±29%)
- keala (bun) vs go net/http: **1.27x** (±20% / ±9%)
- keala (node) vs hono 4 official adapter: **0.99x** (±2% / ±5%)

## Latency under load (median of interleaved rounds)

| Framework | Runtime | scenario | p50 (ms) | p99 (ms) |
| --- | --- | --- | ---: | ---: |
| raw Bun.serve | bun 1.4.0 | short static | 1.0 | 2.0 |
| raw Bun.serve | bun 1.4.0 | static with same radix | 0.0 | 2.0 |
| raw Bun.serve | bun 1.4.0 | dynamic route | 0.0 | 1.0 |
| raw Bun.serve | bun 1.4.0 | mixed static dynamic | 0.0 | 1.0 |
| raw Bun.serve | bun 1.4.0 | post | 0.0 | 1.0 |
| raw Bun.serve | bun 1.4.0 | long static | 0.0 | 1.0 |
| raw Bun.serve | bun 1.4.0 | wildcard | 0.0 | 1.0 |
| keala | bun 1.4.0 | short static | 0.0 | 1.0 |
| keala | bun 1.4.0 | static with same radix | 0.0 | 2.0 |
| keala | bun 1.4.0 | dynamic route | 0.0 | 1.0 |
| keala | bun 1.4.0 | mixed static dynamic | 0.0 | 1.0 |
| keala | bun 1.4.0 | post | 0.0 | 1.0 |
| keala | bun 1.4.0 | long static | 0.0 | 1.0 |
| keala | bun 1.4.0 | wildcard | 0.0 | 1.0 |
| keala | node 22 | short static | 2.0 | 4.0 |
| keala | node 22 | static with same radix | 2.0 | 4.0 |
| keala | node 22 | dynamic route | 2.0 | 2.0 |
| keala | node 22 | mixed static dynamic | 2.0 | 2.0 |
| keala | node 22 | post | 2.0 | 3.0 |
| keala | node 22 | long static | 2.0 | 2.0 |
| keala | node 22 | wildcard | 2.0 | 2.0 |
| hono 4 | bun 1.4.0 | short static | 0.0 | 2.0 |
| hono 4 | bun 1.4.0 | static with same radix | 1.0 | 2.0 |
| hono 4 | bun 1.4.0 | dynamic route | 0.0 | 1.0 |
| hono 4 | bun 1.4.0 | mixed static dynamic | 0.0 | 1.0 |
| hono 4 | bun 1.4.0 | post | 0.0 | 2.0 |
| hono 4 | bun 1.4.0 | long static | 0.0 | 1.0 |
| hono 4 | bun 1.4.0 | wildcard | 0.0 | 1.0 |
| hono 4 official adapter | node 22 | short static | 2.0 | 4.0 |
| hono 4 official adapter | node 22 | static with same radix | 2.0 | 4.0 |
| hono 4 official adapter | node 22 | dynamic route | 2.0 | 2.0 |
| hono 4 official adapter | node 22 | mixed static dynamic | 2.0 | 2.0 |
| hono 4 official adapter | node 22 | post | 2.0 | 4.0 |
| hono 4 official adapter | node 22 | long static | 2.0 | 2.0 |
| hono 4 official adapter | node 22 | wildcard | 2.0 | 4.0 |
| go net/http | go 1.27 | short static | 1.0 | 3.0 |
| go net/http | go 1.27 | static with same radix | 1.0 | 4.0 |
| go net/http | go 1.27 | dynamic route | 1.0 | 3.0 |
| go net/http | go 1.27 | mixed static dynamic | 1.0 | 3.0 |
| go net/http | go 1.27 | post | 1.0 | 3.0 |
| go net/http | go 1.27 | long static | 1.0 | 3.0 |
| go net/http | go 1.27 | wildcard | 1.0 | 3.0 |

## Memory footprint (idle → steady → peak, via /debug/memory)

| Framework | Runtime | idle RSS | steady RSS | peak RSS | idle heap | steady heap |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| raw Bun.serve | bun 1.4.0 | 14.1MB | 33.4MB | 43.0MB | 0.1MB | 0.2MB |
| keala | bun 1.4.0 | 27.7MB | 47.3MB | 56.0MB | 0.6MB | 0.8MB |
| keala | node 22 | 99.3MB | 106.6MB | 130.3MB | 11.7MB | 22.0MB |
| hono 4 | bun 1.4.0 | 28.4MB | 42.0MB | 47.7MB | 0.3MB | 0.5MB |
| hono 4 official adapter | node 22 | 80.8MB | 102.6MB | 120.7MB | 11.9MB | 11.6MB |
| go net/http | go 1.27 | 11.6MB | 28.7MB | 28.7MB | 0.3MB | 4.6MB |

