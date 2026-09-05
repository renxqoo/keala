// One-shot verification of the in-process baseline: raw vs keala vs hono.
// Not part of the repo's benchmark suite; exists to re-verify claims for the
// refactor plan. Run: bun bench/verify-baseline.ts
import { Keala } from "../src/index.ts";
import { Hono } from "hono";

// Per-suite measured requests: BATCHES rounds x SUB interleaved sub-batches.
const WARM = 300_000;
const BATCHES = 40;

const rawHandler = (_req: Request): Response => new Response("hello world");

const app = new Keala();
app.get("/text", (c) => c.text("hello world"));
app.get("/users/:id", (c) => c.text(`user ${c.params("id")}`));

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
    name: "keala text",
    run: (req) => app.handle(req),
  },
  {
    name: "hono text",
    run: (req) => hono.fetch(req),
  },
  {
    name: "raw param",
    run: rawHandler,
  },
  {
    name: "keala param",
    run: (req) => app.handle(req),
  },
  {
    name: "hono param",
    run: (req) => hono.fetch(req),
  },
];

const mkText = () => new Request("http://localhost/text");
const mkParam = (i: number) => new Request(`http://localhost/users/${(i % 20) + 1}`);
const requestFor = (name: string, i: number): Request =>
  name.endsWith("param") ? mkParam(i) : mkText();

const drain = async (res: Response | Promise<Response>): Promise<void> => {
  const r = await res;
  await r.text();
};

// Sequential warmup brings every suite to the same JIT state first.
for (const suite of suites) {
  for (let i = 0; i < WARM; i++) await drain(suite.run(requestFor(suite.name, i)));
}

// INTERLEAVED measurement: round-robin sub-batches across suites so no
// framework benefits from being measured in a systematically different
// machine/thermal window (order bias).
const SUB = 5_000;
const times = new Map<string, number[]>(suites.map((s) => [s.name, []]));
for (let round = 0; round < BATCHES; round++) {
  // rotate the starting suite every round
  const order = [...suites.slice(round % suites.length), ...suites.slice(0, round % suites.length)];
  for (const suite of order) {
    const t0 = performance.now();
    for (let i = 0; i < SUB; i++) await drain(suite.run(requestFor(suite.name, i)));
    (times.get(suite.name) as number[]).push(performance.now() - t0);
  }
}
for (const suite of suites) {
  const sorted = (times.get(suite.name) as number[]).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] as number;
  const best = sorted[0] as number;
  const nsPerReq = (median / SUB) * 1e6;
  const rps = (SUB / median) * 1000;
  const rpsBest = (SUB / best) * 1000;
  console.log(
    `${suite.name.padEnd(16)} median ${nsPerReq.toFixed(0)}ns/req  ${Math.round(rps).toLocaleString()} req/s  (best ${Math.round(rpsBest).toLocaleString()})`,
  );
}
