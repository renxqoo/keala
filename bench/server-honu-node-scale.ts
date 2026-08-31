// honu scale server (Node.js runtime): 1000 static routes only — dedicated
// process so the base scenarios stay unpolluted. Mirrors the Bun variant.
// Run: node --experimental-strip-types bench/server-honu-node-scale.ts [port]
import { Honu } from "../src/index.ts";
import { listen } from "../src/adapters/node.ts";

const app = new Honu();
for (let i = 0; i < 1000; i++) {
  app.get(`/route-${i}`, (c) => c.text(`route-${i}`));
}
app.get("/debug/memory", (c) => c.json(process.memoryUsage()));

const port = Number(process.argv[2] ?? 4119);
listen(app, port, "127.0.0.1");
