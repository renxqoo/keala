// Private IPC worker. Never starts a load without an explicit parent phase.
import autocannon from "autocannon";

if (process.send === undefined) throw new Error("load worker requires IPC");
if (process.versions.bun !== undefined)
  throw new Error("load worker requires real Node, not a Bun shim");
if (process.env.NODE_ENV !== "production") throw new Error("load worker must use production mode");
let phase = "ready";
let options;
const send = (message) =>
  new Promise((resolve, reject) =>
    process.send(message, (error) => (error ? reject(error) : resolve())),
  );
const assertResult = (result) => {
  if (
    result.totalCompletedRequests <= 0 ||
    result.errors !== 0 ||
    result.timeouts !== 0 ||
    result.non2xx !== 0 ||
    result.mismatches !== 0
  )
    throw new Error("load client returned failed or empty results");
};
process.once("disconnect", () => process.exit(1));
process.on("message", async (message) => {
  try {
    if (phase === "ready" && message.kind === "warmup") {
      phase = "warming";
      options = message.options;
      assertResult(
        await autocannon({ ...options, duration: 1, workers: 0, skipAggregateResult: true }),
      );
      phase = "warmed";
      await send({ kind: "warmed" });
    } else if (phase === "warmed" && message.kind === "run") {
      phase = "running";
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, message.at - Date.now())));
      const startedAt = Date.now();
      const started = process.hrtime.bigint();
      const before = process.cpuUsage();
      const result = await autocannon({ ...options, workers: 0, skipAggregateResult: true });
      const cpu = process.cpuUsage(before);
      const elapsedUs = Number(process.hrtime.bigint() - started) / 1000;
      const finishedAt = Date.now();
      assertResult(result);
      await send({
        kind: "result",
        sample: {
          pid: process.pid,
          env: process.env.NODE_ENV,
          runtimeVersion: process.version,
          connections: options.connections,
          startedAt,
          finishedAt,
          cpu: { ...cpu, elapsedUs },
          result,
        },
      });
      process.exit(0);
    } else throw new Error("invalid load worker phase");
  } catch (error) {
    await send({ kind: "error", error: String(error) }).catch(() => undefined);
    process.exit(1);
  }
});
await send({ kind: "ready" });
