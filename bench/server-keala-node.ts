// keala bench server (Node.js runtime via the node adapter) — mirrors
// bench/server-keala.ts route for route, so the two runtimes are comparable.
// Run: node --experimental-strip-types bench/server-keala-node.ts [port]
import { Keala } from "../src/index.ts";
import { listen } from "../src/adapters/node.ts";

const app = new Keala();

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

const port = Number(process.argv[2] ?? 4109);
listen(app, port, "127.0.0.1");
