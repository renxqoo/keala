// Raw Bun.serve baselines. Usage: bun bench-zz/server-raw-bun.ts <mode> <port>
const mode = process.argv[2] ?? "plain";
const port = Number(process.argv[3]);

if (mode === "static") {
  Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch: (req) => new Response(Bun.file(`/tmp/zbench/static${new URL(req.url).pathname}`)),
  });
} else if (mode === "gzip") {
  // pre-compressed static payload served verbatim (compression ceiling)
  const body = JSON.stringify({ rows: "x".repeat(1024) });
  Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch: () =>
      new Response(body, {
        headers: { "content-type": "application/json", "content-encoding": "gzip-mock" },
      }),
  });
} else {
  Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch: () => new Response("hello world"),
  });
}
console.log(`raw ${mode} on ${port}`);
