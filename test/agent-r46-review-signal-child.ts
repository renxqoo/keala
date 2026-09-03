/**
 * Child process for test/agent-r46-review-bugs.test.ts REVIEW-BUG-1.
 *
 * Started with `node --experimental-strip-types` (NOT by vitest — the include
 * pattern only picks *.test.ts). Boots a real Keala node:http server with the
 * R4.6 signal bridge installed (`signals: true`), exposes a probe route and a
 * route that parks forever (holds one in-flight slot so the first signal's
 * drain cannot complete before the second signal arrives), then waits.
 */

import { Keala } from "../src/core/app.ts";
import { startNodeServer } from "../src/adapters/node.ts";

const app = new Keala({ env: "test" });
app.get("/health", (c) => {
  c.body = "up";
});
app.get("/stuck", async () => {
  await new Promise<never>(() => {}); // parks forever: app.inFlight stays 1
});

const server = await startNodeServer(app, {
  port: 0,
  hostname: "127.0.0.1",
  signals: true,
}).ready();
process.stdout.write(`PORT=${server.port}\n`);
