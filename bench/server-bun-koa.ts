// bun-koa bench server (Bun runtime) — mirrors the other bench servers.
import { createApp } from "../src/application/app.ts";
import { createRouter } from "../src/router/router.ts";

const app = createApp();
const router = createRouter();

router.get("/text", (ctx) => {
  ctx.body = "hello world";
});

router.get("/json", (ctx) => {
  ctx.body = { hello: "world" };
});

router.get("/users/:id", (ctx) => {
  ctx.body = `user ${ctx.params["id"]}`;
});

router.get(
  "/mw",
  async (ctx, next) => {
    ctx.set("X-Step", "1");
    await next();
    ctx.set("X-Step-3", "3");
  },
  async (ctx, next) => {
    ctx.set("X-Step-2", "2");
    await next();
  },
  (ctx) => {
    ctx.type = "text/plain";
    ctx.body = "middleware";
  },
);

const port = Number(process.argv[2] ?? 4103);
router.get("/debug/memory", (ctx) => {
  const mu = process.memoryUsage();
  ctx.body = { rss: mu.rss, heapUsed: mu.heapUsed, heapTotal: mu.heapTotal, external: mu.external };
});

app.use(router.routes());
app.listen(port, "127.0.0.1");
