// keala bench server (Node.js runtime via the node adapter) — mirrors
// bench/server-keala.ts route for route, so the two runtimes are comparable.
// Run: node --experimental-strip-types bench/server-keala-node.ts [port]
import { createBodyParser, Keala, type Context } from "../src/index.ts";
import { bodyLimit } from "../src/middleware/limits.ts";
import { listen } from "../src/adapters/node.ts";
import type { ContextWithBody } from "../src/plugins/body-parser.ts";
import { serverMetrics } from "./server-metrics.ts";

// KEALA_POOLING=1 runs the pooled leg of the matrix (opt-in guarded context
// pool); the metrics endpoint reports it, so every sample carries proof.
const pooling = process.env["KEALA_POOLING"] === "1";
// KEALA_SINK reroutes one scenario into the native routes table:
//  "param" -> /users/:id as a FUNCTION sink (the sinking mechanism);
//  "text"  -> /text as a STATIC sink behind declared-transparent global
//             bodyLimit (the noOpFor gate). Everything else stays ordinary.
const sink = process.env["KEALA_SINK"];
const app = new Keala({ env: "production", pooling });
if (sink === "text") app.use(bodyLimit(1024 * 1024));

const pass = (_c: Context, next: () => Promise<void>) => next();
for (const prefix of ["/v1", "/oauth", "/admin"]) app.use(`${prefix}/*`, pass);
app.use(createBodyParser({ jsonLimit: 1024 }));

app.get("/livez", (c) => c.json({ status: "ok" }));

if (sink === "text") {
  app.sink("/text", new Response("hello world"));
} else {
  app.get("/text", (c) => c.text("hello world"));
}

app.get("/json", (c) => c.json({ hello: "world" }));

if (sink === "param") {
  app.sink("/users/:id", (_request, params) => new Response(`user ${params["id"]}`));
} else {
  app.get("/users/:id", (c) => c.text(`user ${c.params?.["id"]}`));
}

app.get("/search/:id", (c) => {
  c.setHeader("X-Query", "hit");
  return c.text(`${c.params?.["id"]} ${c.query("name")} ${c.query("page")}`);
});

app.post("/echo-safe", async (c) => c.json(await (c as ContextWithBody).req.json()));

app.get(
  "/mw",
  async (c, next) => {
    c.setHeader("X-Step", "1");
    await next();
    c.setHeader("X-Step-3", "3");
  },
  async (c, next) => {
    c.setHeader("X-Step-2", "2");
    await next();
  },
  (c) => {
    c.type = "text/plain";
    c.body = "middleware";
  },
);

app.get("/debug/memory", (c) =>
  c.json(
    serverMetrics(app.env, { pooling, sink: sink === "param" || sink === "text" ? sink : false }),
  ),
);

const port = Number(process.argv[2] ?? 4109);
listen(app, port, "127.0.0.1");
