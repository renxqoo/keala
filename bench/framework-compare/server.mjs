// Each process imports only its selected framework. Keala uses freshly built JS,
// so Node's TypeScript loader is outside the measured server and memory footprint.
import { pathToFileURL, fileURLToPath } from "node:url";
import { join } from "node:path";
const [framework, suite] = process.argv.slice(2);
if (
  !["kernel", "kernel-regexp", "kernel-uws", "keala", "keala-before", "hono", "h3"].includes(
    framework,
  ) ||
  !["hello", "routes"].includes(suite)
) {
  throw new Error("usage: node|bun server.mjs keala|hono|h3 hello|routes");
}
if (process.env.NODE_ENV !== "production") throw new Error("NODE_ENV must be production");

const isBun = process.versions.bun !== undefined;
const options = { port: 0, hostname: "127.0.0.1" };
let port;
let kealaEntry;
let kernelEntry;
let transport;
let routerStrategy;

if (framework.startsWith("kernel")) {
  kernelEntry = new URL("../../kernel/kernel.js", import.meta.url).href;
  const { Kernel } = await import(kernelEntry);
  routerStrategy = framework === "kernel-regexp" ? "regexp" : "trie";
  const app = new Kernel({ router: routerStrategy });
  if (suite === "hello") app.text("GET", "/", () => "Hello World");
  else {
    app.text("GET", "/user", () => "user");
    app.text("GET", "/user/comments", () => "user/comments");
    app.text("GET", "/user/avatar", () => "user/avatar");
    app.text("GET", "/user/lookup/username/:username", (p) => p.username);
    app.text("GET", "/user/lookup/email/:address", (p) => p.address);
    app.text("GET", "/event/:id", (p) => p.id);
    app.text("GET", "/event/:id/comments", (p) => p.id);
    app.text("POST", "/event/:id/comment", (p) => `${p.id} comment`);
    app.text("GET", "/map/:location/events", (p) => p.location);
    app.text("GET", "/status", () => "status");
    app.text("GET", "/very/deeply/nested/route/hello/there", () => "hello there");
    app.text("GET", "/static/*", (p) => p.wildcard);
  }
  if (framework === "kernel-uws") {
    if (isBun) throw new Error("native text probe requires Node");
    const { createRequire } = await import("node:module");
    const uws = createRequire(import.meta.url)(
      fileURLToPath(new URL("../../native-uws/uws.js", import.meta.url)),
    );
    const { listenNativeText } = await import("./native-text.mjs");
    port = (await listenNativeText(app.build(), uws, options)).port;
    transport = "uWebSockets.js-sync-text-probe";
  } else {
    const adapter = await import(isBun ? "../../kernel/bun.js" : "../../kernel/node.js");
    const handle = await adapter[isBun ? "listenBun" : "listenNode"](app, options);
    port = handle.port;
    transport = isBun ? "Bun.serve" : "node:http";
  }
} else if (framework === "keala" || framework === "keala-before") {
  const kealaRoot = framework === "keala-before" ? process.env.BENCH_BEFORE : undefined;
  if (framework === "keala-before" && !kealaRoot) throw new Error("BENCH_BEFORE is required");
  kealaEntry = kealaRoot
    ? pathToFileURL(join(kealaRoot, "dist/index.js")).href
    : new URL("../../dist/index.js", import.meta.url).href;
  const { Keala } = await import(kealaEntry);
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
    const { listen } = await import(
      kealaRoot
        ? pathToFileURL(join(kealaRoot, "dist/adapters/node.js")).href
        : "../../dist/adapters/node.js"
    );
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

const identity = {
  kind: "ready",
  kealaEntry,
  kernelEntry,
  transport,
  routerStrategy,
  framework,
  suite,
  port,
  pid: process.pid,
  runtime: isBun ? "bun" : "node",
  version: isBun ? process.versions.bun : process.versions.node,
};
// Optional cold IPC for the resource-limited remote runner; no HTTP metrics route.
if (process.send !== undefined) {
  process.on("message", (message) => {
    if (message?.kind !== "metrics" || !Number.isSafeInteger(message.id)) return;
    process.send({
      kind: "metrics",
      id: message.id,
      metrics: {
        pid: process.pid,
        cpu: process.cpuUsage(),
        monotonicUs: Number(process.hrtime.bigint() / 1000n),
        memory: process.memoryUsage(),
      },
    });
  });
  process.once("disconnect", () => process.exit(1));
  process.send(identity);
}
console.log(JSON.stringify(identity));
