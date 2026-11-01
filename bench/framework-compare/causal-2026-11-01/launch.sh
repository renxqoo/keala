#!/bin/sh
set -eu
base=/tmp/keala-causal.aTIQdg
bundle=$base/bundle
export NODE_OPTIONS=--max-old-space-size=128 UV_THREADPOOL_SIZE=2
export LD_LIBRARY_PATH=$bundle/runtime
export BENCH_NATIVE_CLIENT=$bundle/runtime/native-client BENCH_BUN=/usr/local/bin/bun
export BENCH_SERVER_CPU=0 BENCH_CLIENT_CPU=1
run() { /usr/bin/taskset --cpu-list 1 "$bundle/runtime/node" "$bundle/bench/framework-compare/remote-run.mjs"; }
export BENCH_EXPERIMENT='A/A same Xi entry, complete 8 starting positions plus reversals; diagnostic only'
export BENCH_BEFORE=$bundle BENCH_RUNTIMES=node,bun BENCH_ROUNDS=16
export BENCH_FRAMEWORKS=keala-before,keala,hono,h3 BENCH_SCENARIOS=hello
export BENCH_OUTPUT=$base/calibration-aa
run
export BENCH_EXPERIMENT='Bun subtractive ablation: keala-before removes only native raw Request extensions; incompatible diagnostic, never a product candidate'
export BENCH_BEFORE=$bundle/before BENCH_RUNTIMES=bun BENCH_ROUNDS=12
export BENCH_FRAMEWORKS=keala-before,keala BENCH_SCENARIOS=hello,route-2,route-12
export BENCH_OUTPUT=$base/bun-extensions
run
export BENCH_EXPERIMENT='Node POST scheduling: same Xi A/A entry and Hono, only owned cgroup period 1ms/10ms changes, total quota remains 150%'
export BENCH_BEFORE=$bundle BENCH_RUNTIMES=node BENCH_ROUNDS=12
export BENCH_FRAMEWORKS=keala-before,keala,hono BENCH_SCENARIOS=route-8
export BENCH_CPU_PERIODS_US=1000,10000 BENCH_OUTPUT=$base/node-scheduling
run
