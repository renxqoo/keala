// Hono shootout server (Node.js runtime via the official adapter) — the
// shared 12-route table, so hono-node compares transport against keala-node.
import { serve } from "@hono/node-server";
import { Hono } from "hono";

const app = new Hono();

app.get("/user", (c) => c.text("user"));
app.get("/user/comments", (c) => c.text("user/comments"));
app.get("/user/avatar", (c) => c.text("user/avatar"));
app.get("/user/lookup/username/:username", (c) => c.text(c.req.param("username")!));
app.get("/user/lookup/email/:address", (c) => c.text(c.req.param("address")!));
app.get("/event/:id", (c) => c.text(c.req.param("id")!));
app.get("/event/:id/comments", (c) => c.text(c.req.param("id")!));
app.post("/event/:id/comment", (c) => c.text(`${c.req.param("id")!} comment`));
app.get("/map/:location/events", (c) => c.text(c.req.param("location")!));
app.get("/status", (c) => c.text("status"));
app.get("/very/deeply/nested/route/hello/there", (c) => c.text("hello there"));
app.get("/static/*", (c) => c.text(c.req.path.slice(8)));

app.get("/debug/memory", (c) => c.json(process.memoryUsage()));

const port = Number(process.argv[2] ?? 4205);
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
