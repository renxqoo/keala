// honu scale server: 1000 static routes only (dedicated process so the
// base scenarios stay unpolluted).
import { createApp } from "../src/index.ts";

const app = createApp();
for (let i = 0; i < 1000; i++) {
  app.get(`/route-${i}`, (c) => c.text(`route-${i}`));
}
app.get("/debug/memory", (c) => c.json(process.memoryUsage()));

const port = Number(process.argv[2] ?? 4113);
app.listen(port, "127.0.0.1");
