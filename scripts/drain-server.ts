/**
 * Drain-verification server — the CHILD process for scripts/drain-verify.ts.
 *
 * Runs under Bun against the framework sources:
 *
 *   bun scripts/drain-server.ts <port>
 *
 * Contract with the verifier: prints "LISTENING <port>" once bound, answers
 * /fast, /slow/<ms> and /stream/<chunks>, drains on SIGTERM/SIGINT (the
 * listen signal bridge), prints "CLOSED <json>" with the CloseStatus, and
 * exits 0 on a clean drain / 1 on a forced one.
 */

import { Keala } from "../src/core/app.ts";
import { streamText } from "../src/helpers/streams.ts";

const port = Number(process.argv[2] ?? 0) || 0;

const app = new Keala({ env: "production" });

app.get("/fast", (c) => c.text("fast"));

app.get("/slow/:ms", async (c) => {
  const ms = Number(c.params("ms") ?? 50);
  await new Promise((resolve) => setTimeout(resolve, ms));
  return c.text(`slow-${ms}`);
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

const server = app.listen(port, "127.0.0.1", { signals: true });
console.log(`LISTENING ${server.port}`);

// The bridge registered its own drain-on-SIGTERM; observe the same close
// (idempotent promise) for the verifier's verdict line + exit code.
process.once("SIGTERM", () => {
  void app.close().then((status) => {
    console.log(`CLOSED ${JSON.stringify(status)}`);
    process.exit(status.timedOut ? 1 : 0);
  });
});
process.on("exit", (code) => {
  console.log(`EXIT ${code}`);
});
