# srvx transport migration and contract repairs

Status: complete. Implementation, independent review and release verification passed; measured performance tradeoffs are recorded below. Baseline: 337b67c plus the existing working-tree router/sink/static fixes. User authorization: refactor and repair all findings from the whole-project review; evaluate and use srvx as the transport foundation.

## Decisions and boundaries

- Preserve Keala's public routing, middleware, response, Node/Bun listener and shutdown APIs. Keep its precompiled chains, hybrid router, lazy RequestSource and opt-in pooling.
- Adopt pinned srvx 1.0.8 for the runtime transport boundary. Keala owns application admission, trusted hosts, deadlines, error envelopes, HTTP framing policy and native-sink eligibility. srvx does not replace these policies.
- Preserve the process-global Request/Response constructors. Keep native/Bun handle access and existing injected-serve tests through the compatibility facade.
- Runtime request protection must apply independently of the selected route backend. Native routes fall back to the JS mirror when an application policy cannot run natively; scoped authentication overlap is rejected at registration.
- Preserve encoded-separator, malformed-escape and trailing-slash contracts. Static file serving rejects dot-segment aliases that would resolve to a different authorization scope.
- Response serialization belongs to the response being built. Handler settlement, transport completion and WebSocket closure are distinct facts; close waits for transport completion or forces it at the configured deadline.
- Runtime dependencies change from zero to the pinned srvx package. Node minimum compatibility is tested and declared consistently with srvx (>=20.16.0).

## Architectural choice

Use the Fetch-handler boundary also found in Hono and h3, while retaining Keala's public onion middleware and router contracts. srvx supplies runtime listener creation, native transport access, sending/backpressure and native close. It is not a router, an authentication layer or a shared-state service. Replacing Keala with another full framework would change its API and add an unnecessary second routing/middleware layer.

Keep a narrow compatibility layer for Keala's established framing and pre-header error contract. In particular, srvx infers Content-Length for finite bodies, defaults status 0 to 200 and inherits HOST; the facade prevents ambiguous framing, rejects error responses and preserves native default binding. It also retains lazy response plans rather than constructing native Response/Headers objects on the bare response path.

## Behavior and verification matrix

| Baseline evidence                                              | Target                                                                       | Implementation/consumer boundary                       | Acceptance evidence                                          |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------ |
| Directory sink returns protected file where mirror returns 401 | Reject overlapping exact/deep prefix middleware in either registration order | PatternIR / scoped middleware / sink guards            | New registration regression                                  |
| Node dot-segment aliases bypass scoped auth                    | Refuse aliases before resolving files                                        | Static file path-safety boundary                       | Real raw HTTP regression                                     |
| Second JSON constructor reuses earlier object serialization    | Last response owns bytes and metadata                                        | Sugar / response facts / etag / compress               | Fetch + real Node replacement regression                     |
| Bun close returns before an existing SSE ends                  | Wait for native stop and application settlement; retain force deadline       | srvx/Bun compatibility facade                          | Existing-stream drain and force regressions                  |
| Node raw Request body bypasses configured cap                  | All raw/clone/stream/framework reads observe cap                             | srvx body stream boundary / RequestSource              | Real HTTP body-reader matrix                                 |
| Native sinks bypass trustedHosts/overload/deadline             | Policy-bearing apps serve the JS mirror                                      | One native eligibility decision, including late reload | Host and concurrency/deadline regressions                    |
| Node 20 lacks Promise.withResolvers                            | Compatible resolver helper and supported runtime declaration                 | Deadline / admission queue                             | Resolver fallback and Node 20 process check                  |
| HEAD SSE retains producer/timer                                | Cancel discarded body and contain cancellation errors                        | Response finalizer                                     | Abort/cleanup regression on Node and Bun                     |
| Cookie requests replay anonymous cache                         | Cookie/Authorization requests bypass replay and storage                      | Cache request eligibility                              | Anonymous warmup then authenticated regression               |
| Redirect parameter segment swallows query/fragment             | Parse route parameter syntax and URI suffix separately                       | Named URL / redirect parser                            | App and Router redirect matrix                               |
| Node listener starts after app.close                           | Refuse closed or duplicate starts at shared boundary                         | Server registration / listener facades                 | Public listener regression                                   |
| Node static GET/Range buffers whole file                       | Stream selected byte range with cancellation                                 | Static file response transport                         | Existing static/range matrix plus large sparse-file probe    |
| Raw upload readers remain active after an early timeout        | Close after the answer flushes, abort all active reader variants             | Node source / wire completion                          | Raw, clone, stream and headers-first regressions             |
| Client disconnect precedes a late streaming response           | Cancel before attempting its first read                                      | Node response preparation                              | Real client-disconnect cancellation regression               |
| Error takeover drops the previously committed stream           | Cancel discarded bodies while preserving body transfers                      | Shared error funnel                                    | Built-in, sync/async takeover and mapper-failure regressions |
| Empty foreign response declares a nonzero length               | Correct GET framing; preserve HEAD representation length                     | Node response preparation                              | Wire header regression and independent pipeline probe        |
| Shared rate-limit store accepts synchronous values only        | Support asynchronous atomic stores while retaining sync fast path            | RateLimitStore / middleware                            | Async admission/count regression                             |

## Test migration and release checks

Existing behavioral tests remain authoritative where behavior is retained. Changed expectations must be tied to a corrected behavior in the table above; private transport construction assertions may be adapted to observe the same public laziness/identity contract. No coverage threshold reductions or skipped failures.

Run focused regressions first, then format, lint, types/build, Node coverage suite, real Bun suite, smoke/examples, soak and process checks as defined by package.json/CI. Perform an independent read-only migration review before final acceptance. Record actual results below.

Rollback is code/dependency-only: restore the pre-migration implementation and lockfile together; this change has no persisted data or external deployment step. Existing user working-tree changes are retained throughout. No commit, push or deployment is part of this task.

Changed test expectations are explicit: exported static path resolution now rejects `.`/`..` aliases; the native-table comparison uses distinct applications because a second listener on one application is rejected; mocked native Bun handles expose their native URL for srvx's server URL inspection. No public behavioral assertion was removed to make the migration pass. Two existing long source files were shortened/extracted to meet the existing 500-line rule; native-sink test commentary was condensed after adding contract assertions.

## Evidence

- Previous read-only review: Node 26.9.0 and Bun 1.4.4 suites passed; targeted real-socket probes reproduced the listed defects. Lint had two max-lines failures in existing working-tree changes.
- srvx inspection: runtime-native access and graceful close are available; request body limits cover raw body streams. Keala's pre-header error envelope and strict framing require an explicit compatibility layer rather than trusting the upstream sender's defaults.

- New defect tests were run against the pre-fix implementations: 16 contract regressions and the async-store regression failed before their fixes; all 8 initial cancellation regressions reproduced before cancellation repairs. Additional transport review findings gained targeted regression/probe evidence.
- Independent read-only reviews covered srvx public API usage, authorization boundaries, framing, cancellation, shutdown and response ownership. Reported findings were repaired and independently rechecked on the final implementation. Reviewers did not claim full-suite or performance validation.
- Node 26.9.0 full suite: 175 files passed, 1 runtime-conditional file skipped; 2947 tests passed, 16 skipped. Coverage: statements 95.61%, branches 91.29%, functions 96.25%, lines 97.37%; all existing 90% thresholds passed.
- Targeted real transport boundaries: 18 Node body/response cancellation and framing tests; 6 Bun policy/drain/default-bind tests passed. Independent raw-body cap/IP and deadline probes passed on Node 20.16.0 and 26.9.0.

- Bun 1.4.4 full suite: 174 files passed, 2 runtime-conditional files skipped; 2876 tests passed, 87 skipped. No thresholds or test selection changed.
- Published-artifact smoke, examples, Node/Bun × source/dist process checks, and compiled runtime contracts on Node 20.16.0 passed.
- Real SIGTERM with active mixed traffic: Bun 120 and Node 120 complete responses, zero truncated responses; both exited 0 with `timedOut:false` (264/266 ms drain windows).
- Both existing memory soaks passed unchanged: Bun 24 × 20,000 in-process requests plus HTTP/concurrent legs; Node 12 × 10,000 real HTTP requests. All retained growth stayed within their existing 1500 B/request budgets.
- Real Node sparse-file probe: a 2 GiB file served `bytes=123-123` as one byte with the correct Content-Range; array-buffer growth was 120,362 bytes, confirming that a tiny Range does not buffer the whole file.

- Final Node sender optimization only shares **unobserved private** planned header snapshots. Public live Headers are copied before async sending; microtask mutation of those Headers cannot reintroduce TE + CL. The unsafe optimization reproduced in two wire tests before narrowing the fast path, and the final version passed independent real HTTP rechecks (201 and materialized 200 responses). Same-body error takeover remains consumable rather than being cancelled.

- Declared Bun minimum 1.4.0 and CI's Bun 1.4.2 each passed the 24 targeted real transport/body/framing/lifecycle regressions. Full-suite counts above are from Bun 1.4.4.

## Performance evidence and tradeoff

Follow-up Node optimization (2026-11-01): the origin-form listener now avoids an unused
srvx Request wrapper, and unobserved default buffered responses use `end(body)` while general
responses/streams keep the srvx sender. Explicit custom ServerResponse classes retain the
original sender contract. The original measurements below remain historical; see the
[Node CPU analysis and same-parameter A/B](../bench/keala-ab/node-optimization/ANALYSIS.md)
for current results, behavioral validation and the remaining pre-migration comparison limits.

Same-machine fresh-process, rotating paired comparison using the existing official runner: Apple M4, Node 26.9.0 as orchestrator/load generator, 100 connections split across four clients, 1 second warmup + 3 seconds measurement, five rounds per scenario, no pipelining. Hono 4.13.5 / @hono/node-server 2.1.1 are the installed comparison versions. All completed samples had zero errors/timeouts/non-2xx; no client was classified as capacity constrained.

| Runtime | Scenario | Keala median req/s | Median p99 ms | Paired ratio vs pre-migration | Ratio min–max | Paired ratio vs Hono |
| ------- | -------- | -----------------: | ------------: | ----------------------------: | ------------: | -------------------: |
| Node    | text     |            140,941 |             1 |                         0.862 |   0.763–0.876 |                0.851 |
| Node    | json     |            136,433 |             1 |                         0.871 |   0.781–0.895 |                0.868 |
| Bun     | text     |            201,893 |             1 |                         0.939 |   0.858–1.039 |                1.173 |
| Bun     | json     |            104,861 |             3 |                         1.277 |   0.445–1.497 |                1.009 |

Node text/JSON show about 13–14% lower paired throughput than the pre-migration snapshot, with higher server CPU cost per request. This is a measured cost of the srvx request/response boundary; the existing performance-budget tests still pass. Treat the migration as an architecture/correctness change with this explicit tradeoff. Bun sample ranges are wide, especially JSON, and do not establish a reliable improvement. Its measurements precede the final Node-only header preparation optimization; the Bun transport and kernel were unchanged by that optimization.

One intermediate Node text run was rejected by the existing wall-clock/monotonic-window consistency check. Its partial results were not counted as a successful run; both final Node scenarios were rerun in full with the original validation and parameters. No measurement tolerance was relaxed.

Final Node source fingerprint: `a18ed34c29109dd84ac264b614bac61d1419ff9bd0b7cff575295d9dc641c1fe`. Pre-migration snapshot fingerprint: `ba68e9e83fb99bdbf6d197cb8b5468b71ba61ea3bfcbdc4c454514ac184835c9`; both are based on HEAD `337b67c` with their recorded working-tree changes.

Raw measurements retained locally: `/tmp/keala-srvx-node-{text,json}-final2.jsonl` and `/tmp/keala-srvx-bun-{text,json}.jsonl`. Reproduce with:

```sh
KEALA_BENCH_BASELINE=/path/to/pre-migration node bench/run-node-hotpaths.mjs 100 3 5 text
KEALA_BENCH_BASELINE=/path/to/pre-migration node bench/run-node-hotpaths.mjs 100 3 5 json
KEALA_BENCH_RUNTIME=bun KEALA_BENCH_BASELINE=/path/to/pre-migration node bench/run-node-hotpaths.mjs 100 3 5 text
KEALA_BENCH_RUNTIME=bun KEALA_BENCH_BASELINE=/path/to/pre-migration node bench/run-node-hotpaths.mjs 100 3 5 json
```

These local short runs are not production capacity or availability guarantees. Production failover still needs multiple instances and a load balancer; cross-instance rate limits need an atomic shared store. Per-process memory stores and admission limits remain per process by design.
