/**
 * Drain-verification server (Node child) — the dist-built twin of
 * scripts/drain-server.ts, run against the compiled package:
 *
 *   node scripts/drain-server-node.mjs <port>
 *
 * Requires `npm run build` first (the verifier runs it if dist is missing).
 */

import { Keala } from "../dist/index.js";
import { listen } from "../dist/adapters/node.js";
import { streamText } from "../dist/helpers/streams.js";

const port = Number(process.argv[2] ?? 0) || 0;

const app = new Keala({ env: "production" });

app.get("/fast", (c) => {
  c.body = "fast";
});

app.get("/slow/:ms", async (c) => {
  const ms = Number(c.params("ms") ?? 50);
  await new Promise((resolve) => setTimeout(resolve, ms));
  c.body = `slow-${ms}`;
});

app.get("/stream/:chunks", (c) => {
  const chunks = Number(c.params("chunks") ?? 5);
  return streamText(c, async (w) => {
    for (let i = 0; i < chunks; i++) {
      await new Promise((resolve) => setTimeout(resolve, 15));
      w.write(`s${i};`);
    }
  });
});

const server = listen(app, { port, hostname: "127.0.0.1", signals: true });
await server.ready();
console.log(`LISTENING ${server.port}`);

// Same observation hook as the Bun twin (the bridge already drains).
process.once("SIGTERM", () => {
  void app.close().then((status) => {
    console.log(`CLOSED ${JSON.stringify(status)}`);
    process.exit(status.timedOut ? 1 : 0);
  });
});
process.on("exit", (code) => {
  console.log(`EXIT ${code}`);
});
