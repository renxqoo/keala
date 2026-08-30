// One-shot verification of the in-process baseline: raw vs bun-koa vs hono.
// Not part of the repo's benchmark suite; exists to re-verify claims for the
// refactor plan. Run: bun bench/verify-baseline.ts
import { createApp } from "../src/application/app.ts";
import { createRouter } from "../src/router/router.ts";
import { Hono } from "hono";

const WARM = 300_000;
const BATCH = 20_000;
const BATCHES = 40;

const rawHandler = (_req: Request): Response => new Response("hello world");

const app = createApp();
const router = createRouter();
router.get("/text", (ctx) => {
  ctx.body = "hello world";
});
router.get("/users/:id", (ctx) => {
  ctx.body = `user ${ctx.params["id"]}`;
});
app.use(router.routes());

const hono = new Hono();
hono.get("/text", (c) => c.text("hello world"));
hono.get("/users/:id", (c) => c.text(`user ${c.req.param("id")}`));

interface Suite {
  name: string;
  run: (req: Request) => Response | Promise<Response>;
}

const suites: Suite[] = [
  {
    name: "raw text",
    run: rawHandler,
  },
  {
    name: "bun-koa text",
    run: (req) => app.handle(req) as Response,
  },
  {
    name: "hono text",
    run: (req) => hono.fetch(req) as Response,
  },
  {
    name: "raw param",
    run: rawHandler,
  },
  {
    name: "bun-koa param",
    run: (req) => app.handle(req) as Response,
  },
  {
    name: "hono param",
    run: (req) => hono.fetch(req) as Response,
  },
];

const mkText = () => new Request("http://localhost/text");
const mkParam = (i: number) => new Request(`http://localhost/users/${i % 20}`);

const drain = async (res: Response | Promise<Response>): Promise<void> => {
  const r = await res;
  await r.text();
};

for (const suite of suites) {
  const mk = suite.name.endsWith("param") ? mkParam : mkText;
  // warmup
  for (let i = 0; i < WARM; i++) await drain(suite.run(mk()));
  // measured batches
  const times: number[] = [];
  for (let b = 0; b < BATCHES; b++) {
    const t0 = performance.now();
    for (let i = 0; i < BATCH; i++) await drain(suite.run(mk()));
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  const best = times[0];
  const rps = (BATCH / median) * 1000;
  const rpsBest = (BATCH / best) * 1000;
  console.log(
    `${suite.name.padEnd(16)} median ${(median / BATCH * 1000).toFixed(0)}ns/req  ${Math.round(rps).toLocaleString()} req/s  (best ${Math.round(rpsBest).toLocaleString()})`,
  );
}
