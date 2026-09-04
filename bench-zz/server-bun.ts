// E2E servers for the perf review. One process serves one leg; the runner
// spawns/interleaves them. Usage: bun bench-zz/server-bun.ts <mode> <port>
import { Keala, type Context } from "../src/index.ts";
import { etag, compress } from "../src/middleware/etag.ts";
import { serveStatic } from "../src/middleware/serve-static.ts";

const mode = process.argv[2] ?? "plain";
const port = Number(process.argv[3]);

const app = new Keala({ env: "production", pooling: mode.startsWith("pooled") });

if (mode === "raw-res" || mode === "pooled-raw") {
  app.get("/text", () => new Response("hello world"));
} else if (mode === "state") {
  app.get("/text", (c: Context) => {
    c.body = "hello world";
  });
} else if (mode === "compress") {
  app.use(compress());
  app.get("/json", (c) => c.json({ rows: "x".repeat(1024) }));
} else if (mode === "nocompress") {
  app.get("/json", (c) => c.json({ rows: "x".repeat(1024) }));
} else if (mode === "etagleg") {
  app.use(etag());
  app.get("/text", (c) => c.text("hello world"));
} else if (mode === "static") {
  app.use(serveStatic({ root: "/tmp/zbench/static" }));
} else if (mode === "static-nosymlink") {
  app.use(serveStatic({ root: "/tmp/zbench/static", followSymlinks: true }));
} else {
  app.get("/text", (c) => c.text("hello world"));
}
app.get("/livez", (c) => c.text("ok"));
app.listen(port, "127.0.0.1");
console.log(`${mode} on ${port}`);
