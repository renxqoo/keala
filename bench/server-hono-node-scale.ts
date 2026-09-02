import { serve } from "@hono/node-server";
import { Hono } from "hono";

const app = new Hono();

for (let index = 0; index < 1_000; index++) {
  const body = `route-${index}`;
  app.get(`/${body}`, (c) => c.text(body));
}

app.get("/debug/memory", (c) =>
  c.json({
    rss: process.memoryUsage().rss,
    heapUsed: process.memoryUsage().heapUsed,
    heapTotal: process.memoryUsage().heapTotal,
    external: process.memoryUsage().external,
  }),
);

const port = Number(process.argv[2] ?? 4120);
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
