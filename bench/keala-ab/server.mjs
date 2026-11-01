// Only GET / is registered. CPU snapshots use cold IPC, outside the HTTP path.
import { pathToFileURL } from "node:url";
import { join } from "node:path";

if (process.send === undefined) throw new Error("server requires an IPC parent");
if (process.env.NODE_ENV !== "production") throw new Error("server requires production mode");
const [snapshot] = process.argv.slice(2);
if (!snapshot) throw new Error("missing compiled snapshot directory");
const { Keala } = await import(pathToFileURL(join(snapshot, "dist/index.js")).href);
const app = new Keala({ env: "production", pooling: false });
app.get("/", (c) => c.text("Hello World"));
const options = { port: 0, hostname: "127.0.0.1" };
const runtime = process.versions.bun === undefined ? "node" : "bun";
const metrics = () => ({
  protocol: 2,
  pid: process.pid,
  env: process.env.NODE_ENV,
  applicationEnv: app.env,
  pooling: false,
  sink: false,
  runtime,
  runtimeVersion: runtime === "bun" ? process.versions.bun : process.version,
  cpu: process.cpuUsage(),
  monotonicUs: Number(process.hrtime.bigint() / 1000n),
  ...process.memoryUsage(),
});
let server;
if (runtime === "bun") server = app.listen(options);
else {
  const { listen } = await import(pathToFileURL(join(snapshot, "dist/adapters/node.js")).href);
  server = await listen(app, options).ready();
}
process.on("message", (message) => {
  if (message?.kind !== "metrics" || !Number.isSafeInteger(message.id)) return;
  process.send({ kind: "metrics", id: message.id, metrics: metrics() });
});
process.once("disconnect", () => process.exit(1));
process.send({ kind: "ready", port: server.port, ...metrics() });
