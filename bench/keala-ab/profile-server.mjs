// Diagnostic-only inspector hooks; the normal A/B server has no profiler.
import { Session } from "node:inspector";
import { writeFile } from "node:fs/promises";
await import("./server.mjs");

const session = new Session();
session.connect();
const post = (method, params = {}) =>
  new Promise((resolve, reject) =>
    session.post(method, params, (error, result) => (error ? reject(error) : resolve(result))),
  );
process.on("message", async (message) => {
  if (message?.kind !== "profile") return;
  try {
    if (message.action === "start") {
      await post("Profiler.enable");
      await post("Profiler.setSamplingInterval", { interval: 500 });
      await post("Profiler.start");
    } else {
      const { profile } = await post("Profiler.stop");
      await writeFile(message.file, JSON.stringify(profile));
    }
    process.send({ kind: "profile", id: message.id });
  } catch (error) {
    process.send({ kind: "profile", id: message.id, error: String(error) });
  }
});
