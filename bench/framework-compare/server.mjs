// Each process imports only its selected framework. Keala uses freshly built JS,
// so Node's TypeScript loader is outside the measured server and memory footprint.
const [framework, suite] = process.argv.slice(2);
if (!["keala", "hono", "h3"].includes(framework) || !["hello", "routes"].includes(suite)) {
  throw new Error("usage: node|bun server.mjs keala|hono|h3 hello|routes");
}
if (process.env.NODE_ENV !== "production") throw new Error("NODE_ENV must be production");

const isBun = process.versions.bun !== undefined;
const options = { port: 0, hostname: "127.0.0.1" };
let port;

if (framework === "keala") {
  const { Keala } = await import("../../dist/index.js");
  const app = new Keala({ env: "production" });
  if (suite === "hello") {
    app.get("/", (c) => c.text("Hello World"));
  } else {
    app.get("/user", (c) => c.text("user"));
    app.get("/user/comments", (c) => c.text("user/comments"));
    app.get("/user/avatar", (c) => c.text("user/avatar"));
    app.get("/user/lookup/username/:username", (c) => c.text(c.params("username")));
    app.get("/user/lookup/email/:address", (c) => c.text(c.params("address")));
    app.get("/event/:id", (c) => c.text(c.params("id")));
    app.get("/event/:id/comments", (c) => c.text(c.params("id")));
    app.post("/event/:id/comment", (c) => c.text(`${c.params("id")} comment`));
    app.get("/map/:location/events", (c) => c.text(c.params("location")));
    app.get("/status", (c) => c.text("status"));
    app.get("/very/deeply/nested/route/hello/there", (c) => c.text("hello there"));
    app.get("/static/*", (c) => c.text(c.params("wildcard")));
  }
  if (isBun) {
    port = app.listen(options).port;
  } else {
    const { listen } = await import("../../dist/adapters/node.js");
    port = (await listen(app, options).ready()).port;
  }
} else if (framework === "hono") {
  const { Hono } = await import("hono");
  const app = new Hono();
  if (suite === "hello") {
    app.get("/", (c) => c.text("Hello World"));
  } else {
    app.get("/user", (c) => c.text("user"));
    app.get("/user/comments", (c) => c.text("user/comments"));
    app.get("/user/avatar", (c) => c.text("user/avatar"));
    app.get("/user/lookup/username/:username", (c) => c.text(c.req.param("username")));
    app.get("/user/lookup/email/:address", (c) => c.text(c.req.param("address")));
    app.get("/event/:id", (c) => c.text(c.req.param("id")));
    app.get("/event/:id/comments", (c) => c.text(c.req.param("id")));
    app.post("/event/:id/comment", (c) => c.text(`${c.req.param("id")} comment`));
    app.get("/map/:location/events", (c) => c.text(c.req.param("location")));
    app.get("/status", (c) => c.text("status"));
    app.get("/very/deeply/nested/route/hello/there", (c) => c.text("hello there"));
    app.get("/static/*", (c) => c.text(c.req.path.slice(8)));
  }
  if (isBun) {
    port = Bun.serve({ ...options, fetch: app.fetch }).port;
  } else {
    const { serve } = await import("@hono/node-server");
    port = await new Promise((resolve, reject) => {
      const server = serve({ ...options, fetch: app.fetch }, (address) => resolve(address.port));
      server.once("error", reject);
    });
  }
} else {
  const { H3, serve } = await import("h3");
  const app = new H3();
  if (suite === "hello") {
    app.get("/", () => "Hello World");
  } else {
    app.get("/user", () => "user");
    app.get("/user/comments", () => "user/comments");
    app.get("/user/avatar", () => "user/avatar");
    app.get("/user/lookup/username/:username", (event) => event.context.params.username);
    app.get("/user/lookup/email/:address", (event) => event.context.params.address);
    app.get("/event/:id", (event) => event.context.params.id);
    app.get("/event/:id/comments", (event) => event.context.params.id);
    app.post("/event/:id/comment", (event) => `${event.context.params.id} comment`);
    app.get("/map/:location/events", (event) => event.context.params.location);
    app.get("/status", () => "status");
    app.get("/very/deeply/nested/route/hello/there", () => "hello there");
    app.get("/static/**", (event) => event.context.params[0]);
  }
  const server = serve(app, { ...options, silent: true, gracefulShutdown: false });
  await server.ready();
  port = Number(new URL(server.url).port);
}

console.log(
  JSON.stringify({
    kind: "ready",
    framework,
    suite,
    port,
    pid: process.pid,
    runtime: isBun ? "bun" : "node",
    version: isBun ? process.versions.bun : process.versions.node,
  }),
);
