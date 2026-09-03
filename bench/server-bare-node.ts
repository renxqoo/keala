// Bare-runtime control server (Node.js) — no framework in the request path.
// Mirrors the official scenarios route for route so the runner can measure
// the runtime floor under measurement protocol 2.
// Run: node bench/server-bare-node.ts [port]
import { createServer } from "node:http";
import { serverMetrics } from "./server-metrics.ts";

const jsonLimit = 1024;
const send = (
  res: import("node:http").ServerResponse,
  status: number,
  type: "application/json" | "text/plain",
  body: string,
) => {
  res.writeHead(status, { "content-type": type });
  res.end(body);
};

const server = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0]!.split("#")[0]!;
  switch (path) {
    case "/livez":
      send(res, 200, "application/json", JSON.stringify({ status: "ok" }));
      return;
    case "/text":
      send(res, 200, "text/plain", "hello world");
      return;
    case "/json":
      send(res, 200, "application/json", JSON.stringify({ hello: "world" }));
      return;
    case "/mw":
      res.writeHead(200, {
        "content-type": "text/plain",
        "x-step": "1",
        "x-step-2": "2",
        "x-step-3": "3",
      });
      res.end("middleware");
      return;
    case "/debug/memory":
      send(res, 200, "application/json", JSON.stringify(serverMetrics("production")));
      return;
  }
  const user = /^\/users\/([^/]+)$/.exec(path);
  if (user !== null) {
    send(res, 200, "text/plain", `user ${user[1]}`);
    return;
  }
  const search = /^\/search\/([^/]+)$/.exec(path);
  if (search !== null) {
    const query = new URL(req.url ?? "/", "http://localhost").searchParams;
    res.writeHead(200, { "content-type": "text/plain", "x-query": "hit" });
    res.end(`${search[1]} ${query.get("name")} ${query.get("page")}`);
    return;
  }
  if (path === "/echo-safe" && req.method === "POST") {
    // Same observable contract as the body-safe fixtures: over the limit
    // answers 413 (declared length short-circuits the read), malformed
    // JSON answers 400, anything else echoes as JSON.
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > jsonLimit) {
      send(res, 413, "text/plain", "too large");
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      if (body.byteLength > jsonLimit) {
        send(res, 413, "text/plain", "too large");
        return;
      }
      try {
        send(res, 200, "application/json", JSON.stringify(JSON.parse(body.toString("utf8"))));
      } catch {
        send(res, 400, "text/plain", "malformed JSON body");
      }
    });
    return;
  }
  send(res, 404, "text/plain", "not found");
});

server.listen(Number(process.argv[2] ?? 4112), "127.0.0.1");
