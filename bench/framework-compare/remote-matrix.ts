import assert from "node:assert/strict";
import { resolve } from "node:path";
import { HELLO, ROUTES } from "./scenarios.mjs";

const selection = (value: string | undefined, available: string[], label: string): string[] => {
  if (value === undefined) return available;
  const selected = value.split(",");
  assert(selected.length && new Set(selected).size === selected.length, `duplicate ${label}`);
  assert(
    selected.every((x) => available.includes(x)),
    `unknown ${label}: ${value}`,
  );
  return selected;
};

/** Explicit subsets and scheduling factors for isolated diagnostic runs. */
export const remoteMatrix = ({
  runtimes,
  before,
  pilot,
  helloOnly,
  env,
}: {
  runtimes: string[];
  before: boolean;
  pilot: boolean;
  helloOnly: boolean;
  env: Record<string, string | undefined>;
}) => {
  const frameworks = selection(
    env.BENCH_FRAMEWORKS,
    [...(before ? ["keala-before"] : []), "keala", "hono", "h3"],
    "framework",
  );
  const periods = env.BENCH_CPU_PERIODS_US?.split(",").map(Number) ?? [undefined];
  assert(new Set(periods).size === periods.length && periods.length > 0, "duplicate CPU period");
  for (const period of periods)
    assert(
      period === undefined || (Number.isInteger(period) && period >= 1000 && period <= 1000000),
      "invalid CPU period",
    );
  const stacks = runtimes.flatMap((runtime) =>
    frameworks.flatMap((framework) =>
      periods.map((cpuPeriodUs) => ({
        id: `${framework}-${runtime}${cpuPeriodUs === undefined ? "" : `-cfs${cpuPeriodUs}us`}`,
        framework,
        runtime,
        cpuPeriodUs,
      })),
    ),
  );
  assert(stacks.length > 0, "benchmark matrix must include at least one stack");
  const hello = HELLO[0];
  assert(hello, "Hello workload is required");
  const all = [
    { ...hello, id: "hello", suite: "hello" },
    ...(pilot || helloOnly
      ? []
      : ROUTES.map((s, i) => ({ ...s, id: `route-${i + 1}`, suite: "routes" }))),
  ];
  const ids = selection(
    env.BENCH_SCENARIOS,
    all.map((s) => s.id),
    "scenario",
  );
  return { stacks, scenarios: all.filter((s) => ids.includes(s.id)) };
};

/** Visit every starting position, with an exact reverse partner each time. */
export const balancedOrder = <T>(
  stacks: readonly T[],
  scenarioIndex: number,
  round: number,
): T[] => {
  const offset = (scenarioIndex + Math.floor((round - 1) / 2)) % stacks.length;
  const order = [...stacks.slice(offset), ...stacks.slice(0, offset)];
  return round % 2 === 0 ? order.toReversed() : order;
};

export const setOwnCpuPeriod = async (
  cg: string,
  limits: { cpuMax: string },
  period: number | undefined,
  read: (path: string) => Promise<string>,
  write: (path: string, value: string) => Promise<unknown>,
): Promise<void> => {
  if (period === undefined) return;
  assert(Number.isInteger(period) && period >= 1000 && period <= 1000000, "invalid CPU period");
  const [quota, previousPeriod] = limits.cpuMax.split(" ").map(Number);
  assert(quota !== undefined && previousPeriod !== undefined);
  const next = Math.floor((period * quota) / previousPeriod);
  assert(next >= 1000 && next / period <= 1.5, "CPU factor exceeds the original safe budget");
  const value = `${next} ${period}`;
  await write(`${cg}/cpu.max`, value);
  assert.equal((await read(`${cg}/cpu.max`)).trim(), value, "CPU period was not applied");
};

type BuildIdentity = { sourceSha256: string; distSha256: string };
export const beforeMetadata = (
  manifest: BuildIdentity & { before?: BuildIdentity },
  beforeRoot: string | undefined,
  root: string,
) => {
  const shared = beforeRoot !== undefined && resolve(beforeRoot) === resolve(root);
  return {
    before: shared
      ? { sourceSha256: manifest.sourceSha256, distSha256: manifest.distSha256 }
      : manifest.before,
    beforeKind: beforeRoot === undefined ? "none" : shared ? "same-entry-AA" : "packaged-before",
  };
};
