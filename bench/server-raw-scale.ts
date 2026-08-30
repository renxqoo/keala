// raw Bun.serve scale server: 1000 routes via the native routes table.
const port = Number(process.argv[2] ?? 4114);

const routes: Record<string, () => Response> = {};
for (let i = 0; i < 1000; i++) {
  routes[`/route-${i}`] = () => new Response(`route-${i}`);
}
routes["/debug/memory"] = () => Response.json(process.memoryUsage());

Bun.serve({ port, hostname: "127.0.0.1", routes, fetch: () => new Response("x", { status: 404 }) });
