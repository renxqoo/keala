// Fresh-process route-scale matrix cell (R4.2).
//
//   bun bench/router-scale.ts <keala|hono> <static|param-distinct|param-shared> <size>
//
// One invocation builds ONE route table of `size` routes for one framework,
// asserts every probe's status/body/params, then reports per-probe ns/req
// medians plus registration wall time, first-request latency (where a lazy
// router pays its compile) and post-build heap delta. The runner spawns this
// in rotating fresh processes and aggregates; never treat one sample as
// evidence.

import { Hono } from "hono";

import { Keala } from "../src/core/app.ts";

type Framework = "keala" | "hono";
type Kind = "static" | "param-distinct" | "param-shared";

const framework = process.argv[2] as Framework;
const kind = process.argv[3] as Kind;
const size = Number(process.argv[4]);
if (!(["keala", "hono"] as const).includes(framework)) {
  throw new TypeError("framework must be keala or hono");
}
if (!(["static", "param-distinct", "param-shared"] as const).includes(kind)) {
  throw new TypeError("kind must be static, param-distinct or param-shared");
}
if (!Number.isInteger(size) || size < 1 || size > 100_000) {
  throw new TypeError("size must be an integer in [1, 100000]");
}

const mid = size >> 1;
const last = size - 1;

// Route paths and handler bodies per kind. Param handlers echo BOTH the
// route's static tail and the captured value so probe assertions prove the
// RIGHT route (and param) matched — a wrong-route hit must fail loudly.
const routePath = (i: number): string =>
  kind === "static"
    ? `/res-${i}`
    : kind === "param-distinct"
      ? `/res-${i}/:id`
      : `/items/:id/item-${i}`;
const hitPath = (i: number): string =>
  kind === "static"
    ? `/res-${i}`
    : kind === "param-distinct"
      ? `/res-${i}/42`
      : `/items/7/item-${i}`;
const bodyForRoute = (i: number): string =>
  kind === "static" ? `res-${i}` : kind === "param-distinct" ? `r${i}:42` : `it${i}:7`;

interface Probe {
  name: string;
  path: string;
  status: number;
  body: string | null;
}

const probes: Probe[] = [
  { name: "hit-mid", path: hitPath(mid), status: 200, body: bodyForRoute(mid) },
  { name: "hit-last", path: hitPath(last), status: 200, body: bodyForRoute(last) },
  { name: "miss-global", path: "/definitely-missing", status: 404, body: null },
  {
    name: "miss-deep",
    path:
      kind === "static"
        ? `/res-${mid}/extra`
        : kind === "param-distinct"
          ? `/res-${mid}/42/extra`
          : `/items/7/item-${mid}/extra`,
    status: 404,
    body: null,
  },
];

const gc = (): void => {
  if (typeof Bun !== "undefined") Bun.gc(true);
};

gc();
const heapBefore = process.memoryUsage().heapUsed;

let handle: (request: Request) => Response | Promise<Response>;

const buildStart = performance.now();
if (framework === "keala") {
  const app = new Keala({ env: "production" });
  for (let i = 0; i < size; i++) {
    const index = i;
    app.get(routePath(index), (c) =>
      kind === "static"
        ? c.text(bodyForRoute(index))
        : c.text(`${kind === "param-distinct" ? "r" : "it"}${index}:${c.params("id") ?? "?"}`),
    );
  }
  handle = (request) => app.handle(request);
} else {
  const app = new Hono();
  for (let i = 0; i < size; i++) {
    const index = i;
    app.get(routePath(index), (c) =>
      kind === "static"
        ? c.text(bodyForRoute(index))
        : c.text(`${kind === "param-distinct" ? "r" : "it"}${index}:${c.req.param("id") ?? "?"}`),
    );
  }
  handle = (request) => app.fetch(request);
}
const regMs = performance.now() - buildStart;

gc();
const heapMB = (process.memoryUsage().heapUsed - heapBefore) / (1024 * 1024);

// First request pays any lazy index build (Hono's RegExpRouter compiles on
// first match); eager routers pay theirs inside regMs. Report both.
const firstStart = performance.now();
const first = await handle(new Request(`http://localhost${probes[0]!.path}`));
const firstMs = performance.now() - firstStart;
if (first.status !== 200) throw new Error(`first request status ${first.status}`);

const warmup = 3_000;
const batch = 3_000;
const samples = 15;

const results: Record<string, { median: number; p25: number; p75: number }> = {};
for (const probe of probes) {
  const shared = new Request(`http://localhost${probe.path}`);
  // Correctness BEFORE timing: each probe must hit the intended route.
  const check = await handle(shared);
  if (check.status !== probe.status) {
    throw new Error(`${probe.name}: status ${check.status}, want ${probe.status}`);
  }
  if (probe.body !== null) {
    const text = await check.text();
    if (text !== probe.body) throw new Error(`${probe.name}: body ${text}, want ${probe.body}`);
  }

  const runOne = async (): Promise<void> => {
    const response = await handle(shared);
    if (response.status !== probe.status) {
      throw new Error(`${probe.name}: status ${response.status} inside timing loop`);
    }
    await response.text();
  };
  for (let i = 0; i < warmup; i++) await runOne();
  const readings: number[] = [];
  for (let sample = 0; sample < samples; sample++) {
    const start = performance.now();
    for (let i = 0; i < batch; i++) await runOne();
    readings.push(((performance.now() - start) * 1e6) / batch);
  }
  readings.sort((a, b) => a - b);
  results[probe.name] = {
    median: Math.round(readings[Math.floor(samples / 2)] as number),
    p25: Math.round(readings[Math.floor(samples / 4)] as number),
    p75: Math.round(readings[Math.floor((samples * 3) / 4)] as number),
  };
}

console.log(
  JSON.stringify({
    framework,
    kind,
    size,
    regMs: Math.round(regMs * 100) / 100,
    firstMs: Math.round(firstMs * 100) / 100,
    heapMB: Math.round(heapMB * 10) / 10,
    probes: results,
  }),
);
