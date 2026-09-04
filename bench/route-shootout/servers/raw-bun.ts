// Raw Bun.serve shootout baseline — zero framework, hand-rolled matching for
// the shared 12-route table (the runtime's ceiling, not a router's).
const port = Number(process.argv[2] ?? 4201);

Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch(request) {
    const url = request.url;
    const path = url.slice(url.indexOf("/", url.indexOf("://") + 3));
    const query = path.indexOf("?");
    const p = query === -1 ? path : path.slice(0, query);
    if (p === "/user") return text("user");
    if (p === "/user/comments") return text("user/comments");
    if (p === "/user/avatar") return text("user/avatar");
    if (p === "/status") return text("status");
    if (p === "/very/deeply/nested/route/hello/there") return text("hello there");
    if (p.startsWith("/user/lookup/username/")) return text(p.slice(22));
    if (p.startsWith("/user/lookup/email/")) return text(p.slice(19));
    if (p.startsWith("/static/")) return text(p.slice(8));
    if (p.startsWith("/map/") && p.endsWith("/events")) return text(p.slice(5, -7));
    if (p.startsWith("/event/")) {
      const rest = p.slice(7);
      const slash = rest.indexOf("/");
      if (slash === -1) return text(rest);
      const id = rest.slice(0, slash);
      if (rest.endsWith("/comments")) return text(id);
      if (rest.endsWith("/comment")) {
        return request.method === "POST" ? text(`${id} comment`) : notAllowed();
      }
    }
    if (p === "/debug/memory") return Response.json(process.memoryUsage());
    return new Response("Not Found", { status: 404 });
  },
});

const text = (body: string): Response =>
  new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
const notAllowed = (): Response => new Response(null, { status: 405 });
