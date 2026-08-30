// fastify scale server: 1000 routes.
import Fastify from "fastify";

const app = Fastify({ logger: false });
for (let i = 0; i < 1000; i++) {
  const path = `/route-${i}`;
  app.get(path, () => `route-${i}`);
}
app.get("/debug/memory", () => process.memoryUsage());

const port = Number(process.argv[2] ?? 4115);
await app.listen({ port, host: "127.0.0.1" });
