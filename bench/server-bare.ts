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
    const url = new URL(request.url);
    switch (url.pathname) {
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
    const user = /^\/users\/([^/]+)$/.exec(url.pathname);
    if (user !== null) return text(`user ${user[1]}`);
    // The composite control for the query scenario: URLSearchParams is the
    // natural no-framework way to read the query string.
    const search = /^\/search\/([^/]+)$/.exec(url.pathname);
    if (search !== null) {
      return new Response(
        `${search[1]} ${url.searchParams.get("name")} ${url.searchParams.get("page")}`,
        { headers: { "content-type": "text/plain", "x-query": "hit" } },
      );
    }
    if (url.pathname === "/echo-safe" && request.method === "POST") {
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
