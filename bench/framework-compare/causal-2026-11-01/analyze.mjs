import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { median } from "../report.mjs";

// Exploratory bootstrap of adjacent reverse-round blocks, never individual requests.
const bootstrap = (values) => {
  let seed = 0x5eed1234;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 2 ** 32;
  };
  assert(values.length % 2 === 0, "complete reverse-round blocks required");
  const blocks = Array.from({ length: values.length / 2 }, (_, i) =>
    values.slice(i * 2, i * 2 + 2),
  );
  const estimates = Array.from({ length: 10000 }, () =>
    median(
      Array.from(
        { length: blocks.length },
        () => blocks[Math.floor(random() * blocks.length)],
      ).flat(),
    ),
  ).toSorted((a, b) => a - b);
  return {
    median: median(values),
    min: Math.min(...values),
    max: Math.max(...values),
    bootstrap95: [estimates[249], estimates[9749]],
    positive: values.filter((x) => x > 0).length,
    negative: values.filter((x) => x < 0).length,
    ties: values.filter((x) => x === 0).length,
  };
};
const cpu = (s) => s.serverCpu.nsPerRequest / 1000;
const pairs = (data, a, b, scenario) => {
  const rows = data.samples.filter((s) => s.stack === a && s.scenario === scenario);
  return rows.map((x) => {
    const y = data.samples.find(
      (s) => s.stack === b && s.scenario === scenario && s.round === x.round,
    );
    assert(y, "missing paired round");
    return [x, y];
  });
};
const compare = (data, a, b, scenario) => {
  const rows = pairs(data, a, b, scenario);
  assert(rows.length > 0);
  return {
    a,
    b,
    scenario,
    rounds: rows.length,
    rpsPercent: bootstrap(rows.map(([x, y]) => 100 * (x.load.rps / y.load.rps - 1))),
    cpuPercent: bootstrap(rows.map(([x, y]) => 100 * (cpu(x) / cpu(y) - 1))),
    cpuUsDifference: bootstrap(rows.map(([x, y]) => cpu(x) - cpu(y))),
    userUsDifference: bootstrap(
      rows.map(([x, y]) => x.serverCpu.user / x.load.total - y.serverCpu.user / y.load.total),
    ),
    systemUsDifference: bootstrap(
      rows.map(([x, y]) => x.serverCpu.system / x.load.total - y.serverCpu.system / y.load.total),
    ),
    p99MsDifference: bootstrap(rows.map(([x, y]) => x.load.latency.p99 - y.load.latency.p99)),
    byRound: rows.map(([x, y]) => ({
      round: x.round,
      rpsPercent: 100 * (x.load.rps / y.load.rps - 1),
      cpuPercent: 100 * (cpu(x) / cpu(y) - 1),
      p99Difference: x.load.latency.p99 - y.load.latency.p99,
    })),
  };
};
const file = process.argv[2];
const data = JSON.parse(await readFile(file));
assert(data.finishedAt && !data.failure);
assert.deepEqual(data.cleanup.livePids, []);
assert.equal(data.samples.length, data.stacks.length * data.scenarios.length * data.config.rounds);
const checks = data.verification.reduce((n, v) => n + v.checks, 0);
for (const s of data.samples) {
  assert.equal(
    s.serverCpu.nsPerRequest,
    ((s.serverCpu.user + s.serverCpu.system) * 1000) / s.load.total,
  );
  assert.equal(s.load.errors, 0);
  assert.equal(s.load.non2xx, 0);
}
const comparisons = [];
if (data.source.beforeKind === "same-entry-AA")
  for (const runtime of new Set(data.stacks.map((s) => s.runtime))) {
    const periods = [
      ...new Set(data.stacks.filter((s) => s.runtime === runtime).map((s) => s.cpuPeriodUs)),
    ];
    for (const period of periods)
      for (const scenario of data.scenarios) {
        const suffix = period === undefined ? "" : `-cfs${period}us`;
        const k = `keala-${runtime}${suffix}`;
        const b = `keala-before-${runtime}${suffix}`;
        const h = `hono-${runtime}${suffix}`;
        comparisons.push(compare(data, k, b, scenario.id));
        if (data.stacks.some((s) => s.id === h)) comparisons.push(compare(data, k, h, scenario.id));
      }
  }
else
  for (const scenario of data.scenarios)
    comparisons.push(compare(data, "keala-before-bun", "keala-bun", scenario.id));
const withinFrameworkPeriods = [];
if (data.stacks.some((s) => s.cpuPeriodUs === 1000))
  for (const framework of ["keala-before", "keala", "hono"])
    for (const scenario of data.scenarios)
      withinFrameworkPeriods.push(
        compare(data, `${framework}-node-cfs1000us`, `${framework}-node-cfs10000us`, scenario.id),
      );
console.log(
  JSON.stringify(
    {
      diagnosticOnly: true,
      experiment: data.experiment,
      checks,
      samples: data.samples.length,
      requests: data.samples.reduce((n, s) => n + s.load.total, 0),
      ownedPids: data.cleanup.ownedPids.length,
      livePids: data.cleanup.livePids,
      comparisons,
      withinFrameworkPeriods,
    },
    null,
    2,
  ),
);
