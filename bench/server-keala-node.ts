// keala bench server (Node.js runtime via the node adapter) — mirrors
// bench/server-keala.ts route for route, so the two runtimes are comparable.
// Run: node --experimental-strip-types bench/server-keala-node.ts [port]
import { createBodyParser, Keala, type Context } from "../src/index.ts";
import { listen } from "../src/adapters/node.ts";
import type { ContextWithBody } from "../src/plugins/body-parser.ts";
import { serverMetrics } from "./server-metrics.ts";

const app = new Keala({ env: "production" });

const pass = (_c: Context, next: () => Promise<void>) => next();
for (const prefix of ["/v1", "/oauth", "/admin"]) app.use(`${prefix}/*`, pass);
app.use(createBodyParser({ jsonLimit: 1024 }));

app.get("/livez", (c) => c.json({ status: "ok" }));

app.get("/text", (c) => c.text("hello world"));

app.get("/json", (c) => c.json({ hello: "world" }));

app.get("/users/:id", (c) => c.text(`user ${c.params?.["id"]}`));

app.post("/echo-safe", async (c) => c.json(await (c as ContextWithBody).req.json()));

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

app.get("/debug/memory", (c) => c.json(serverMetrics(app.env)));

const port = Number(process.argv[2] ?? 4109);
listen(app, port, "127.0.0.1");
