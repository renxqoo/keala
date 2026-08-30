// Raw Bun.serve baseline — zero framework, same response shapes as the
// framework bench servers. Parameter extraction done by hand for fairness.
const port = Number(process.argv[2] ?? 4104);

Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch(request) {
    const url = request.url;
    const path = url.slice(url.indexOf("/", url.indexOf("://") + 3));
    if (path === "/text") {
      return new Response("hello world", {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    if (path === "/json") {
      return Response.json({ hello: "world" });
    }
    if (path.startsWith("/users/")) {
      const id = path.slice(7);
      return new Response(`user ${id}`, {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    if (path === "/mw") {
      return new Response("middleware", {
        headers: { "X-Step": "1", "X-Step-2": "2", "X-Step-3": "3" },
      });
    }
    if (path === "/debug/memory") {
      const mu = process.memoryUsage();
      return Response.json({
        rss: mu.rss,
        heapUsed: mu.heapUsed,
        heapTotal: mu.heapTotal,
        external: mu.external,
      });
    }
    return new Response("Not Found", { status: 404 });
  },
});
