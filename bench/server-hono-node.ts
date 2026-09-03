// Hono's official Node adapter baseline. Routes intentionally mirror the
// Keala Node process so the orchestrator compares transports and framework
// work under the same runtime, payloads and middleware shape.
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { serverMetrics } from "./server-metrics.ts";

const app = new Hono();
const decoder = new TextDecoder();

for (const prefix of ["/v1", "/oauth", "/admin"]) {
  app.use(`${prefix}/*`, (_c, next) => next());
}

app.get("/livez", (c) => c.json({ status: "ok" }));

app.get("/text", (c) => c.text("hello world"));

app.get("/json", (c) => c.json({ hello: "world" }));

app.get("/users/:id", (c) => c.text(`user ${c.req.param("id")}`));

app.post("/echo-safe", async (c) => {
  const limit = 1024;
  const declared = Number(c.req.header("content-length"));
  if (Number.isFinite(declared) && declared > limit) return c.text("too large", 413);
  // @hono/node-server 2.1.1 does not yet install a lightweight `bytes()`
  // method on its Request proxy (calling Node 22's inherited method fails
  // the native brand check). arrayBuffer() is its official direct-body path.
  const bytes = new Uint8Array(await c.req.raw.arrayBuffer());
  if (bytes.byteLength > limit) return c.text("too large", 413);
  try {
    return c.json(JSON.parse(decoder.decode(bytes)));
  } catch {
    return c.text("malformed JSON body", 400);
  }
});

app.get(
  "/mw",
  async (c, next) => {
    c.header("X-Step", "1");
    await next();
    c.header("X-Step-3", "3");
  },
  async (c, next) => {
    c.header("X-Step-2", "2");
    await next();
  },
  (c) => c.text("middleware"),
);

app.get("/debug/memory", (c) => c.json(serverMetrics(process.env["NODE_ENV"] ?? "unset")));

const port = Number(process.argv[2] ?? 4110);
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
