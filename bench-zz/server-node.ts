// Node legs. Usage: node bench-zz/server-node.ts <mode> <port>
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { Keala, type Context } from "../src/index.ts";

const mode = process.argv[2] ?? "plain";
const port = Number(process.argv[3]);

if (mode === "raw") {
  const body = "hello world";
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "content-length": body.length });
    res.end(body);
  });
  server.listen(port, "127.0.0.1");
} else {
  const app = new Keala({ env: "production" });
  if (mode === "state") {
    app.get("/text", (c: Context) => {
      c.body = "hello world";
    });
  } else if (mode === "raw-res") {
    app.get("/text", () => new Response("hello world"));
  } else {
    app.get("/text", (c) => c.text("hello world"));
  }
  const { startNodeServer } = await import("../src/adapters/node.ts");
  startNodeServer(app, { port, hostname: "127.0.0.1" });
}
console.log(`node ${mode} on ${port}`);
