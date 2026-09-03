// keala bench server (Bun runtime) — mirrors the other bench servers.
import { createBodyParser, Keala, type Context } from "../src/index.ts";
import type { ContextWithBody } from "../src/plugins/body-parser.ts";
import { serverMetrics } from "./server-metrics.ts";

// KEALA_POOLING=1 runs the pooled leg of the matrix (opt-in guarded context
// pool); the metrics endpoint reports it, so every sample carries proof.
const pooling = process.env["KEALA_POOLING"] === "1";
const app = new Keala({ env: "production", pooling });

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

app.get("/debug/memory", (c) => c.json(serverMetrics(app.env, { pooling })));

const port = Number(process.argv[2] ?? 4103);
app.listen(port, "127.0.0.1");
