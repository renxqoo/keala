const path = process.argv[2];
const { Keala } = await import(path);
const original = Bun.serve;
let keys;
function serve(options) {
  const fetch = options.fetch;
  return original({
    ...options,
    fetch(request, server) {
      const response = fetch(request, server);
      keys = Reflect.ownKeys(request);
      return response;
    },
  });
}
Bun.serve = serve.bind(Bun);
Object.defineProperty(Bun.serve, "name", { value: "serve" });
const app = new Keala({ env: "test" });
app.get("/", (c) => c.text("ok"));
try {
  const server = app.listen({ port: 0, hostname: "127.0.0.1" });
  const response = await server.fetch(new Request("http://example.test/"));
  console.log(
    JSON.stringify({
      source: path,
      signature: Function.prototype.toString.call(Bun.serve),
      body: await response.text(),
      keys,
    }),
  );
} finally {
  Bun.serve = original;
  await app.close({ drain: 100 });
}
