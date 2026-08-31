// honu bench server (Bun runtime) — mirrors the other bench servers.
import { createApp } from "../src/index.ts";

const app = createApp();

app.get("/text", (c) => c.text("hello world"));

app.get("/json", (c) => c.json({ hello: "world" }));

app.get("/users/:id", (c) => c.text(`user ${c.params?.["id"]}`));

app.get(
  "/mw",
  async (c, next) => {
    c.set("X-Step", "1");
    await next();
    c.set("X-Step-3", "3");
  },
  async (c, next) => {
    c.set("X-Step-2", "2");
    await next();
  },
  (c) => {
    c.type = "text/plain";
    c.body = "middleware";
  },
);

app.get("/debug/memory", (c) =>
  c.json({
    rss: process.memoryUsage().rss,
    heapUsed: process.memoryUsage().heapUsed,
    heapTotal: process.memoryUsage().heapTotal,
    external: process.memoryUsage().external,
  }),
);

const port = Number(process.argv[2] ?? 4103);
app.listen(port, "127.0.0.1");
