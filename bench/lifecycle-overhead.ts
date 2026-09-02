// Fresh-process lifecycle overhead probe (R4.6).
//
//   bun bench/lifecycle-overhead.ts [plain|overload|timeout|queue|probe]
//
// One app per variant, one warm JSON-ish handler, N sequential app.handle
// calls. Reports median + IQR per request. The `plain` variant is the
// zero-config hot path (admission gate check + counter inc/dec + settle-tail
// release); `overload` adds the per-request admission arithmetic; `timeout`
// adds the per-request setTimeout/unref race; `queue` drives a saturated
// burst cycle (admit → queue → slot transfer) to expose the pooled-waiter
// steady state; `probe` micro-times the raw fast-path operations
// (2 loads + branch + increment + guarded decrement) in isolation — the
// <5ns unconfigured budget of DESIGN §7.1.

import { Keala } from "../src/core/app.ts";

const variant = (process.argv[2] ?? "plain") as
  | "plain"
  | "overload"
  | "timeout"
  | "queue"
  | "probe";

/** Settle-tail release, hoisted: the probe's isolated replica of the
 * releaseInFlight guards (captures nothing). */
const release = (state: { inFlight: number; queue: unknown[]; closeWaiters: (() => void)[] }): void => {
  state.inFlight--;
  if (state.queue.length > 0) return;
  if (state.inFlight === 0 && state.closeWaiters.length > 0) return;
};

const percentile = (samples: number[], q: number): string =>
  (samples.toSorted((a, b) => a - b)[Math.floor(q * (samples.length - 1))]! * 1e6).toFixed(0);

if (variant === "probe") {
  // The C1 fast path in isolation: the exact field loads, branch and
  // increment the gate performs, plus the settle-tail release — timed as a
  // paired loop so the harness cost amortizes.
  const lc = {
    overload: null,
    draining: false,
    inFlight: 0,
    queue: [] as unknown[],
    closeWaiters: [] as (() => void)[],
  };
  const iterations = 5_000_000;
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) {
    if (!lc.draining && lc.overload === null) lc.inFlight++;
    release(lc);
  }
  const perOpNs = ((performance.now() - t0) * 1e6) / iterations;
  process.stdout.write(
    `lifecycle-overhead probe: fast-path ops ${perOpNs.toFixed(2)}ns/op (admit+release, n=${iterations})\n`,
  );
  process.exit(0);
}

const app =
  variant === "overload"
    ? new Keala({ env: "test", overload: { maxConcurrency: 4096 } })
    : variant === "timeout"
      ? new Keala({ env: "test", requestTimeout: 10_000 })
      : variant === "queue"
        ? new Keala({ env: "test", overload: { maxConcurrency: 1, maxQueue: 4 } })
        : new Keala({ env: "test" });

app.use(async (_c, next) => {
  await next();
});
app.get("/x", (c) => {
  c.body = { ok: true };
});

const request = new Request("http://localhost/x");
const run = async (): Promise<void> => {
  const res = await app.handle(request);
  await res.text();
};

// Warm-up (JIT + response shape settling).
for (let i = 0; i < 3000; i++) await run();

if (variant === "queue") {
  // Saturated burst cycle: one in-flight park per round-trip is impossible
  // sequentially — instead drive the queue through a parked leader.
  const N = 2000;
  const samples: number[] = [];
  let gate: (() => void) | undefined;
  app.get("/leader", () => new Promise<void>((resolve) => (gate = resolve)).then(() => undefined));
  for (let i = 0; i < N; i++) {
    const leader = app.handle(new Request("http://localhost/leader"));
    const t0 = performance.now();
    const queued = app.handle(request); // parks in the queue
    (gate as unknown as () => void)?.();
    await leader;
    const res = await queued; // slot transfer serves it
    await res.text();
    samples.push(performance.now() - t0);
  }
  process.stdout.write(
    `lifecycle-overhead queue: p50 ${percentile(samples, 0.5)}ns  IQR [${percentile(samples, 0.25)}, ${percentile(samples, 0.75)}]  (n=${N})\n`,
  );
  process.exit(0);
}

const N = 30_000;
const samples: number[] = [];
for (let i = 0; i < N; i++) {
  const t0 = performance.now();
  await run();
  samples.push(performance.now() - t0);
}
process.stdout.write(
  `lifecycle-overhead ${variant}: p50 ${percentile(samples, 0.5)}ns  IQR [${percentile(samples, 0.25)}, ${percentile(samples, 0.75)}]  (n=${N})\n`,
);
