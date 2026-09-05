// keala shootout server (Node.js runtime via the node adapter) — the SAME
// app as servers/keala-bun.ts so the shootout isolates the transport.
// Run: node bench/route-shootout/servers/keala-node.ts [port]
import { Keala } from "../../../src/index.ts";
import { listen } from "../../../src/adapters/node.ts";

const app = new Keala({ env: "production" });

app.get("/user", (c) => c.text("user"));
app.get("/user/comments", (c) => c.text("user/comments"));
app.get("/user/avatar", (c) => c.text("user/avatar"));
app.get("/user/lookup/username/:username", (c) => c.text(c.params("username")!));
app.get("/user/lookup/email/:address", (c) => c.text(c.params("address")!));
app.get("/event/:id", (c) => c.text(c.params("id")!));
app.get("/event/:id/comments", (c) => c.text(c.params("id")!));
app.post("/event/:id/comment", (c) => c.text(`${c.params("id")} comment`));
app.get("/map/:location/events", (c) => c.text(c.params("location")!));
app.get("/status", (c) => c.text("status"));
app.get("/very/deeply/nested/route/hello/there", (c) => c.text("hello there"));
app.get("/static/*", (c) => c.text(c.params("wildcard")!));

app.get("/debug/memory", (c) => c.json(process.memoryUsage()));

const port = Number(process.argv[2] ?? 4203);
listen(app, { port, hostname: "127.0.0.1" });
