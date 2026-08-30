// koa scale server: 1000 routes through @koa/router (linear layer walk).
import Koa from "koa";
import Router from "@koa/router";

const app = new Koa();
const router = new Router();
for (let i = 0; i < 1000; i++) {
  router.get(`/route-${i}`, (ctx) => {
    ctx.body = `route-${i}`;
  });
}
router.get("/debug/memory", (ctx) => {
  ctx.body = process.memoryUsage();
});
app.use(router.routes()).use(router.allowedMethods());

const port = Number(process.argv[2] ?? 4111);
app.listen(port, "127.0.0.1");
