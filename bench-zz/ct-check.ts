// Verify: pooling wraps unknown-kind Responses -> Bun string MIME inference lost.
import { Keala } from "../src/index.ts";

const app = new Keala({ env: "production", pooling: true });
app.get("/raw", () => new Response("hello world"));
app.get("/sugar", (c) => c.text("hello world"));
Bun.serve({
  port: 7877,
  hostname: "127.0.0.1",
  fetch: (req) => app.handle(req),
});
await new Promise((r) => setTimeout(r, 200));
const a = await fetch("http://127.0.0.1:7877/raw");
const b = await fetch("http://127.0.0.1:7877/sugar");
console.log(
  `raw   Response (pooled): content-type=${JSON.stringify(a.headers.get("content-type"))} status=${a.status}`,
);
console.log(
  `sugar c.text   (pooled): content-type=${JSON.stringify(b.headers.get("content-type"))} status=${b.status}`,
);
process.exit(0);
