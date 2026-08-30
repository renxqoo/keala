// hono scale server: 1000 static routes only.
import { Hono } from "hono";

const app = new Hono();
for (let i = 0; i < 1000; i++) {
  app.get(`/route-${i}`, (c) => c.text(`route-${i}`));
}
app.get("/debug/memory", (c) => c.json(process.memoryUsage()));

const port = Number(process.argv[2] ?? 4112);
export default { port, hostname: "127.0.0.1", fetch: app.fetch };
