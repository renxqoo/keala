// Fastify 5 baseline server (Node runtime) — mirrors the other bench servers.
import Fastify from "fastify";

const app = Fastify({
  logger: false,
  genReqId: () => "r",
});

app.get("/text", async (_req, reply) => {
  reply.header("Content-Type", "text/plain; charset=utf-8");
  return "hello world";
});

app.get("/json", async () => ({ hello: "world" }));

app.get("/users/:id", async (req, reply) => {
  reply.header("Content-Type", "text/plain; charset=utf-8");
  return `user ${req.params.id}`;
});

app.get("/mw", async () => "middleware");

app.addHook("onRequest", async (req, reply) => {
  reply.header("X-Step", "1");
});
app.addHook("preHandler", async (_req, reply) => {
  reply.header("X-Step-2", "2");
});
app.addHook("onSend", async (_req, reply) => {
  reply.header("X-Step-3", "3");
});

app.get("/debug/memory", async () => {
  const mu = process.memoryUsage();
  return {
    rss: mu.rss,
    heapUsed: mu.heapUsed,
    heapTotal: mu.heapTotal,
    external: mu.external,
  };
});

const port = Number(process.argv[2] ?? 4105);
await app.listen({ port, host: "127.0.0.1" });
console.log(`fastify ready on ${port}`);
