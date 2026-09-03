// Bare-runtime control server (Bun) — no framework in the request path.
// Mirrors the official scenarios route for route so the runner can measure
// the runtime floor under measurement protocol 2. Run: bun bench/server-bare.ts [port]
import { serverMetrics } from "./server-metrics.ts";

const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const text = (value: string) => new Response(value, { headers: { "content-type": "text/plain" } });
const failure = (value: string, status: 400 | 413) =>
  new Response(value, { status, headers: { "content-type": "text/plain" } });
const jsonLimit = 1024;

Bun.serve({
  port: Number(process.argv[2] ?? 4111),
  hostname: "127.0.0.1",
  fetch(request) {
    const { pathname } = new URL(request.url);
    switch (pathname) {
      case "/livez":
        return json({ status: "ok" });
      case "/text":
        return text("hello world");
      case "/json":
        return json({ hello: "world" });
      case "/mw":
        return new Response("middleware", {
          headers: {
            "content-type": "text/plain",
            "x-step": "1",
            "x-step-2": "2",
            "x-step-3": "3",
          },
        });
      case "/debug/memory":
        return json(serverMetrics("production"));
    }
    const user = /^\/users\/([^/]+)$/.exec(pathname);
    if (user !== null) return text(`user ${user[1]}`);
    if (pathname === "/echo-safe" && request.method === "POST") {
      // Same observable contract as the body-safe fixtures: over the limit
      // answers 413 (declared length short-circuits the read), malformed
      // JSON answers 400, anything else echoes as JSON.
      const declared = Number(request.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > jsonLimit) return failure("too large", 413);
      return request.arrayBuffer().then(
        (buffer) => {
          if (buffer.byteLength > jsonLimit) return failure("too large", 413);
          try {
            return json(JSON.parse(new TextDecoder().decode(buffer)));
          } catch {
            return failure("malformed JSON body", 400);
          }
        },
        () => failure("unreadable body", 400),
      );
    }
    return new Response("not found", { status: 404 });
  },
});
