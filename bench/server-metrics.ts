/** Cold diagnostic endpoint only; no hooks in timed request handlers. */
export const serverMetrics = (applicationEnv: string) => ({
  protocol: 2,
  pid: process.pid,
  env: process.env["NODE_ENV"],
  applicationEnv,
  runtime: typeof Bun === "undefined" ? "node" : "bun",
  runtimeVersion: typeof Bun === "undefined" ? process.version : Bun.version,
  cpu: process.cpuUsage(),
  monotonicUs: Number(process.hrtime.bigint() / 1000n),
  ...process.memoryUsage(),
});

/** Old baseline fixtures must adopt this protocol, never silently lose CPU/mode checks. */
export const validateServerMetrics = (
  value: unknown,
  pid: number,
  runtime: string,
): ReturnType<typeof serverMetrics> => {
  if (
    value === null ||
    typeof value !== "object" ||
    !("protocol" in value) ||
    value.protocol !== 2
  ) {
    throw new Error(
      "server requires measurement protocol 2; update baseline fixture and metrics helper",
    );
  }
  const snapshot = value as ReturnType<typeof serverMetrics>;
  if (
    snapshot.pid !== pid ||
    snapshot.runtime !== runtime ||
    snapshot.env !== "production" ||
    snapshot.applicationEnv !== "production" ||
    typeof snapshot.runtimeVersion !== "string"
  ) {
    throw new Error("server PID/runtime/production mode mismatch");
  }
  for (const number of [
    snapshot.cpu?.user,
    snapshot.cpu?.system,
    snapshot.monotonicUs,
    snapshot.rss,
    snapshot.heapUsed,
    snapshot.heapTotal,
    snapshot.external,
  ]) {
    if (!Number.isSafeInteger(number) || number < 0)
      throw new Error("invalid server CPU/memory snapshot");
  }
  return snapshot;
};
