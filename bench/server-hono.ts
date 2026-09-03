// Hono baseline server (Bun runtime) — mirrors the other bench servers.
import { Hono } from "hono";

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
  const bytes = await (c.req.raw as Request & { bytes(): Promise<Uint8Array> }).bytes();
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
