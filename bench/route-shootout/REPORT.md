# route shootout — the 12-route table, 6 stacks

Generated: 2026-09-05T23:27:20.028Z

> Post-migration re-run (U4 of docs/KEALA-NATIVE-API-MIGRATION.md, clean window
> on 192.168.31.149 after the native-API migration). This file is round 2 of 2
> — the runner overwrites REPORT.md per run. Both rounds' keala(bun)/hono(bun)
> ratios: R1 0.97/0.97/1.02/0.97/0.89(±23%)/1.35(±66%)/0.96 → median 0.97x;
> R2 (below) → median 0.97x. Recorded as a noise-band tie against the 0.98x
> budget line — see the migration doc's U4 record for the full adjudication
> and the isolated (adapter-level) numbers that carry the framework signal.
> The go leg is absent: the server has no go toolchain (run.mjs skips it).

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
| raw Bun.serve | bun 1.4.2 | 88,448 | ±18% |
| keala | bun 1.4.2 | 92,712 | ±17% |
| keala | node 26 | 36,164 | ±3% |
| hono 4 | bun 1.4.2 | 96,040 | ±25% |
| hono 4 official adapter | node 26 | 36,276 | ±14% |
- keala (bun) vs raw Bun.serve: **1.05x** (±17% / ±18%)
- keala (bun) vs hono 4: **0.97x** (±17% / ±25%)
- keala (node) vs hono 4 official adapter: **1.00x** (±3% / ±14%)

## static with same radix — GET /user/comments

| Framework | Runtime | req/s | noise |
| --- | --- | ---: | ---: |
| raw Bun.serve | bun 1.4.2 | 60,489 | ±60% |
| keala | bun 1.4.2 | 67,106 | ±89% |
| keala | node 26 | 29,440 | ±7% |
| hono 4 | bun 1.4.2 | 61,953 | ±53% |
| hono 4 official adapter | node 26 | 28,528 | ±3% |
- keala (bun) vs raw Bun.serve: **1.11x** (±89% / ±60%)
- keala (bun) vs hono 4: **1.08x** (±89% / ±53%)
- keala (node) vs hono 4 official adapter: **1.03x** (±7% / ±3%)

## dynamic route — GET /user/lookup/username/hey

| Framework | Runtime | req/s | noise |
| --- | --- | ---: | ---: |
| raw Bun.serve | bun 1.4.2 | 83,304 | ±6% |
| keala | bun 1.4.2 | 59,290 | ±47% |
| keala | node 26 | 27,722 | ±3% |
| hono 4 | bun 1.4.2 | 82,318 | ±57% |
| hono 4 official adapter | node 26 | 28,334 | ±55% |
- keala (bun) vs raw Bun.serve: **0.71x** (±47% / ±6%)
- keala (bun) vs hono 4: **0.72x** (±47% / ±57%)
- keala (node) vs hono 4 official adapter: **0.98x** (±3% / ±55%)

## mixed static dynamic — GET /event/abcd1234/comments

| Framework | Runtime | req/s | noise |
| --- | --- | ---: | ---: |
| raw Bun.serve | bun 1.4.2 | 55,311 | ±70% |
| keala | bun 1.4.2 | 82,114 | ±39% |
| keala | node 26 | 26,316 | ±64% |
| hono 4 | bun 1.4.2 | 79,504 | ±24% |
| hono 4 official adapter | node 26 | 27,146 | ±61% |
- keala (bun) vs raw Bun.serve: **1.48x** (±39% / ±70%)
- keala (bun) vs hono 4: **1.03x** (±39% / ±24%)
- keala (node) vs hono 4 official adapter: **0.97x** (±64% / ±61%)

## post — POST /event/abcd1234/comment

| Framework | Runtime | req/s | noise |
| --- | --- | ---: | ---: |
| raw Bun.serve | bun 1.4.2 | 82,016 | ±4% |
| keala | bun 1.4.2 | 51,701 | ±85% |
| keala | node 26 | 25,378 | ±53% |
| hono 4 | bun 1.4.2 | 54,580 | ±79% |
| hono 4 official adapter | node 26 | 25,592 | ±6% |
- keala (bun) vs raw Bun.serve: **0.63x** (±85% / ±4%)
- keala (bun) vs hono 4: **0.95x** (±85% / ±79%)
- keala (node) vs hono 4 official adapter: **0.99x** (±53% / ±6%)

## long static — GET /very/deeply/nested/route/hello/there

| Framework | Runtime | req/s | noise |
| --- | --- | ---: | ---: |
| raw Bun.serve | bun 1.4.2 | 84,432 | ±44% |
| keala | bun 1.4.2 | 75,358 | ±22% |
| keala | node 26 | 28,216 | ±57% |
| hono 4 | bun 1.4.2 | 69,739 | ±52% |
| hono 4 official adapter | node 26 | 29,710 | ±10% |
- keala (bun) vs raw Bun.serve: **0.89x** (±22% / ±44%)
- keala (bun) vs hono 4: **1.08x** (±22% / ±52%)
- keala (node) vs hono 4 official adapter: **0.95x** (±57% / ±10%)

## wildcard — GET /static/index.html

| Framework | Runtime | req/s | noise |
| --- | --- | ---: | ---: |
| raw Bun.serve | bun 1.4.2 | 84,240 | ±60% |
| keala | bun 1.4.2 | 75,531 | ±31% |
| keala | node 26 | 26,804 | ±56% |
| hono 4 | bun 1.4.2 | 81,446 | ±64% |
| hono 4 official adapter | node 26 | 28,304 | ±8% |
- keala (bun) vs raw Bun.serve: **0.90x** (±31% / ±60%)
- keala (bun) vs hono 4: **0.93x** (±31% / ±64%)
- keala (node) vs hono 4 official adapter: **0.95x** (±56% / ±8%)

## Latency under load (median of interleaved rounds)

| Framework | Runtime | scenario | p50 (ms) | p99 (ms) |
| --- | --- | --- | ---: | ---: |
| raw Bun.serve | bun 1.4.2 | short static | 1.0 | 8.0 |
| raw Bun.serve | bun 1.4.2 | static with same radix | 2.0 | 30.0 |
| raw Bun.serve | bun 1.4.2 | dynamic route | 2.0 | 4.0 |
| raw Bun.serve | bun 1.4.2 | mixed static dynamic | 2.0 | 29.0 |
| raw Bun.serve | bun 1.4.2 | post | 2.0 | 4.0 |
| raw Bun.serve | bun 1.4.2 | long static | 2.0 | 21.0 |
| raw Bun.serve | bun 1.4.2 | wildcard | 2.0 | 4.0 |
| keala | bun 1.4.2 | short static | 1.0 | 4.0 |
| keala | bun 1.4.2 | static with same radix | 1.0 | 22.0 |
| keala | bun 1.4.2 | dynamic route | 2.0 | 31.0 |
| keala | bun 1.4.2 | mixed static dynamic | 2.0 | 18.0 |
| keala | bun 1.4.2 | post | 2.0 | 31.0 |
| keala | bun 1.4.2 | long static | 1.0 | 23.0 |
| keala | bun 1.4.2 | wildcard | 2.0 | 18.0 |
| keala | node 26 | short static | 5.0 | 8.0 |
| keala | node 26 | static with same radix | 6.0 | 9.0 |
| keala | node 26 | dynamic route | 7.0 | 9.0 |
| keala | node 26 | mixed static dynamic | 7.0 | 9.0 |
| keala | node 26 | post | 7.0 | 10.0 |
| keala | node 26 | long static | 6.0 | 9.0 |
| keala | node 26 | wildcard | 7.0 | 10.0 |
| hono 4 | bun 1.4.2 | short static | 1.0 | 3.0 |
| hono 4 | bun 1.4.2 | static with same radix | 1.0 | 27.0 |
| hono 4 | bun 1.4.2 | dynamic route | 2.0 | 29.0 |
| hono 4 | bun 1.4.2 | mixed static dynamic | 2.0 | 26.0 |
| hono 4 | bun 1.4.2 | post | 2.0 | 22.0 |
| hono 4 | bun 1.4.2 | long static | 1.0 | 20.0 |
| hono 4 | bun 1.4.2 | wildcard | 2.0 | 28.0 |
| hono 4 official adapter | node 26 | short static | 5.0 | 7.0 |
| hono 4 official adapter | node 26 | static with same radix | 6.0 | 9.0 |
| hono 4 official adapter | node 26 | dynamic route | 6.0 | 9.0 |
| hono 4 official adapter | node 26 | mixed static dynamic | 6.0 | 9.0 |
| hono 4 official adapter | node 26 | post | 7.0 | 10.0 |
| hono 4 official adapter | node 26 | long static | 6.0 | 9.0 |
| hono 4 official adapter | node 26 | wildcard | 6.0 | 9.0 |

## Memory footprint (idle → steady → peak, via /debug/memory)

| Framework | Runtime | idle RSS | steady RSS | peak RSS | idle heap | steady heap |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| raw Bun.serve | bun 1.4.2 | 16.9MB | 28.3MB | 42.6MB | 0.1MB | 0.2MB |
| keala | bun 1.4.2 | 26.6MB | 38.4MB | 54.4MB | 0.7MB | 1.4MB |
| keala | node 26 | 101.8MB | 118.5MB | 138.2MB | 13.8MB | 17.3MB |
| hono 4 | bun 1.4.2 | 29.8MB | 36.2MB | 49.9MB | 0.3MB | 0.4MB |
| hono 4 official adapter | node 26 | 80.2MB | 111.5MB | 130.1MB | 14.7MB | 11.6MB |

