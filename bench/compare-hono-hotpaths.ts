// Fresh-process comparison against the installed Hono version.
//
//   bun bench/compare-hono-hotpaths.ts <keala|hono> <probe|body|text|text-dirty|text-dirty-correct>

// Each invocation owns one framework/JIT instance. Run variants in A-B-B-A
// order and compare process medians; never treat one best sample as evidence.

import { Hono } from "hono";

import { Keala } from "../src/core/app.ts";
import type { Context } from "../src/core/context/context.ts";
import { createBodyParser, type ContextWithBody } from "../src/plugins/body-parser.ts";

type Framework = "keala" | "hono";
type CaseName = "probe" | "body" | "text" | "text-dirty" | "text-dirty-correct";
const pass = (_c: Context, next: () => Promise<void>) => next();

const framework = process.argv[2] as Framework;
const caseName = process.argv[3] as CaseName;
if (!(["keala", "hono"] as const).includes(framework)) {
  throw new TypeError("framework must be keala or hono");
}
if (!(["probe", "body", "text", "text-dirty", "text-dirty-correct"] as const).includes(caseName)) {
  throw new TypeError("unknown comparison case");
}

let handle: (request: Request) => Response | Promise<Response>;
let makeRequest: (index: number) => Request;

if (framework === "keala") {
  const app = new Keala({ env: "production" });
  if (caseName === "probe") {
    for (const prefix of ["/v1", "/oauth", "/admin"]) app.use(`${prefix}/*`, pass);
    app.get("/livez", (c) => c.json({ status: "ok" }));
  } else if (caseName === "body") {
    app.use(createBodyParser({ jsonLimit: 1024 }));
    app.post("/v1/echo", async (c0) => {
      const c = c0 as ContextWithBody;
      return c.json(await c.req.json());
    });
  } else {
    if (caseName === "text-dirty" || caseName === "text-dirty-correct") {
      app.use(async (c, next) => {
        await next();
        c.set("x-late", "1");
      });
    }
    app.get("/text", (c) => c.text("hello"));
  }
  handle = (request) => app.handle(request);
} else {
  const app = new Hono();
  if (caseName === "probe") {
    for (const prefix of ["/v1", "/oauth", "/admin"]) {
      app.use(`${prefix}/*`, (_c, next) => next());
    }
    app.get("/livez", (c) => c.json({ status: "ok" }));
  } else if (caseName === "body") {
    app.post("/v1/echo", async (c) => c.json(await c.req.json()));
  } else {
    if (caseName === "text-dirty" || caseName === "text-dirty-correct") {
      app.use("*", async (c, next) => {
        await next();
        c.header("x-late", "1");
      });
    }
    app.get("/text", (c) => {
      // Hono's bare dirty response is incorrect on Bun 1.4. This variant
      // pays Hono's public-API cost to produce the same text/plain contract
      // keala now restores internally.
      if (caseName === "text-dirty-correct") c.header("content-type", "text/plain; charset=utf-8");
      return c.text("hello");
    });
  }
  handle = (request) => app.fetch(request);
}

if (caseName === "body") {
  makeRequest = () =>
    new Request("http://localhost/v1/echo", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "25" },
      body: '{"message":"hello world"}',
    });
} else {
  const path = caseName === "probe" ? "/livez" : "/text";
  const shared = new Request(`http://localhost${path}`);
  makeRequest = () => shared;
}

const warmup = caseName === "body" ? 20_000 : 60_000;
const batch = caseName === "body" ? 2_000 : 5_000;
const samples = 21;

const runOne = async (index: number): Promise<void> => {
  const response = await handle(makeRequest(index));
  if (response.status !== 200) throw new Error(`unexpected status ${response.status}`);
  await response.text();
};

for (let index = 0; index < warmup; index++) await runOne(index);

const readings: number[] = [];
for (let sample = 0; sample < samples; sample++) {
  const start = performance.now();
  for (let index = 0; index < batch; index++) await runOne(index);
  readings.push(((performance.now() - start) * 1e6) / batch);
}
readings.sort((a, b) => a - b);
console.log(
  JSON.stringify({
    framework,
    case: caseName,
    nsPerRequest: Math.round(readings[Math.floor(samples / 2)] as number),
    iqr: [
      Math.round(readings[Math.floor(samples / 4)] as number),
      Math.round(readings[Math.floor((samples * 3) / 4)] as number),
    ],
    samples,
    batch,
  }),
);
