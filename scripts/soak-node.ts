/**
 * Memory-leak soak, NODE leg (R4.10): the Bun soak never validated the Node
 * adapter's writeResponse/native-source bridging under sustained load. Same
 * shape as scripts/soak.ts — sustained mixed traffic against a real
 * node:http server, forced-GC heap sampling, a retained-drift budget.
 *
 * Run: node scripts/soak-node.mjs
 */

import { Keala } from "../src/core/app.ts";
import { startNodeServer } from "../src/adapters/node.ts";

const ROUNDS = 12;
const PER_ROUND = 10_000;
const DRIFT_BUDGET_BYTES = 1_500; // allowed retained growth per request

const app = new Keala({ keys: ["soak"], env: "test" });
app.use(async (c, next) => {
  c.setHeader("X-Soak", "1");
  await next();
});
app.get("/text", (c) => c.text("hello world"));
app.get("/json", (c) => c.json({ hello: "world", list: [1, 2, 3] }));
app.get("/users/:id", (c) => c.text(`user ${c.params?.["id"]}`));
app.get("/boom", () => {
  throw new Error("soak-boom");
});
app.get("/cookies", (c) => {
  c.cookies.set("sid", "x".repeat(24), { signed: true });
  c.body = "ok";
});
app.get("/committed", () => new Response("foreign body", { headers: { "x-kind": "foreign" } }));

const paths = ["/text", "/json", "/users/7", "/boom", "/cookies", "/committed"] as const;

// --experimental-keep-alive or global.gc via --expose-gc; soak honestly with
// whichever the process has.
const gc = globalThis.gc ?? (() => undefined);
const sample = () => process.memoryUsage().heapUsed;

const server = startNodeServer(app, { port: 0, hostname: "127.0.0.1" });
await server.ready();
const base = `http://127.0.0.1:${server.port}`;

const failures = [];
for (let round = 0; round < ROUNDS; round++) {
  gc();
  const before = sample();
  for (let i = 0; i < PER_ROUND; i++) {
    const res = await fetch(`${base}${paths[i % paths.length]}`);
    await res.text();
  }
  gc();
  const drift = (sample() - before) / PER_ROUND;
  const pass = drift <= DRIFT_BUDGET_BYTES;
  console.log(
    `${pass ? "✓" : "✗"} round ${round}: ${PER_ROUND.toLocaleString()} req over node:http, retained drift ${drift.toFixed(1)} B/req (budget ${DRIFT_BUDGET_BYTES})`,
  );
  if (!pass) failures.push(round);
}

server.stop(true);
if (failures.length > 0) {
  console.error(`SOAK-NODE FAILED — rounds over budget: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("SOAK-NODE OK — no retained-heap growth beyond budget");
