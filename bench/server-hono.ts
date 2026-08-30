// Hono baseline server (Bun runtime) — mirrors the other bench servers.
import { Hono } from "hono";

const app = new Hono();
app.get("/text", (c) => c.text("hello world"));

app.get("/json", (c) => c.json({ hello: "world" }));

app.get("/users/:id", (c) => c.text(`user ${c.req.param("id")}`));

app.use("/mw", async (c, next) => {
  c.header("X-Step", "1");
  await next();
  c.header("X-Step-3", "3");
});
app.use("/mw", async (c, next) => {
  c.header("X-Step-2", "2");
  await next();
});
app.get("/mw", (c) => c.text("middleware"));

app.get("/debug/memory", (c) => {
  const mu = process.memoryUsage();
  return c.json({
    rss: mu.rss,
    heapUsed: mu.heapUsed,
    heapTotal: mu.heapTotal,
    external: mu.external,
  });
});

const port = Number(process.argv[2] ?? 4102);
export default {
  port,
  hostname: "127.0.0.1",
  fetch: app.fetch,
};
