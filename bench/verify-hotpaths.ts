// Focused, fresh-process hot-path probe for HOTPATH-R3.
//
// Examples:
//   bun bench/verify-hotpaths.ts body
//   bun bench/verify-hotpaths.ts scope legacy
//   bun bench/verify-hotpaths.ts scope scoped
//
// KEALA_SOURCE may point at another checkout's src/index.ts, which lets the
// same harness compare main and a working branch without copying code.

import { pathToFileURL } from "node:url";

import type { Context } from "../src/core/context/context.ts";
import type { Plugin } from "../src/types.ts";

type Handler = (c: Context, next: () => Promise<void>) => unknown;

interface BenchApp {
  use(...middleware: (string | Handler | Plugin)[]): BenchApp;
  get(path: string, ...handlers: Handler[]): BenchApp;
  post(path: string, handler: Handler): BenchApp;
  handle(request: Request): Promise<Response>;
}

interface BenchModule {
  Keala: new (options?: { env?: string }) => BenchApp;
  createBodyParser(options?: { jsonLimit?: number }): Plugin;
}

const pass: Handler = (_c, next) => next();

const source = process.env["KEALA_SOURCE"] ?? new URL("../src/index.ts", import.meta.url).pathname;
const module = (await import(pathToFileURL(source).href)) as BenchModule;
const { Keala, createBodyParser } = module;

const caseName = process.argv[2];
const scopeMode = process.argv[3];
if (caseName !== "body" && caseName !== "scope" && caseName !== "mix") {
  throw new TypeError("usage: verify-hotpaths.ts <body|scope|mix> [legacy|scoped]");
}

const app = new Keala({ env: "production" });
let makeRequest: (index: number) => Request;
let consumeBody = true;

if (caseName === "body") {
  app.use(createBodyParser({ jsonLimit: 1024 }));
  app.post("/v1/echo", async (c) => {
    const req = (c as Context & { req: { json(): Promise<unknown> } }).req;
    return c.json(await req.json());
  });
  makeRequest = () =>
    new Request("http://localhost/v1/echo", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "25" },
      body: '{"message":"hello world"}',
    });
} else if (caseName === "scope") {
  const prefixes = ["/v1", "/oauth", "/admin"];
  if (scopeMode === "legacy") {
    for (const prefix of prefixes) {
      app.use((c, next) => {
        const path = c.path;
        if (path !== prefix && !path.startsWith(`${prefix}/`)) return next();
        return pass(c, next);
      });
    }
  } else if (scopeMode === "scoped") {
    for (const prefix of prefixes) app.use(`${prefix}/*`, pass);
  } else {
    throw new TypeError("scope case requires legacy or scoped mode");
  }
  app.get("/livez", (c) => c.json({ status: "ok" }));
  const shared = new Request("http://localhost/livez");
  makeRequest = () => shared;
} else {
  app.get("/text", (c) => c.text("hello world"));
  app.get("/json", (c) => c.json({ hello: "world" }));
  app.get("/users/:id", (c) => c.text(`user ${c.params("id")}`));
  app.get(
    "/mw",
    async (c, next) => {
      c.setHeader("x-step", "1");
      await next();
      c.setHeader("x-step-3", "3");
    },
    async (c, next) => {
      c.setHeader("x-step-2", "2");
      await next();
    },
    (c) => c.text("middleware"),
  );
  const requests = ["/text", "/json", "/users/7", "/mw"].map(
    (path) => new Request(`http://localhost${path}`),
  );
  makeRequest = (index) => requests[index % requests.length] as Request;
  consumeBody = false;
}

const warmup = caseName === "body" ? 20_000 : 60_000;
const batch = caseName === "body" ? 2_000 : 5_000;
const samples = 21;

const runOne = async (index: number): Promise<void> => {
  const response = await app.handle(makeRequest(index));
  if (consumeBody) await response.text();
};

for (let i = 0; i < warmup; i++) await runOne(i);

const readings: number[] = [];
for (let sample = 0; sample < samples; sample++) {
  const start = performance.now();
  for (let i = 0; i < batch; i++) await runOne(i);
  readings.push(((performance.now() - start) * 1e6) / batch);
}
readings.sort((a, b) => a - b);
const median = readings[Math.floor(readings.length / 2)] as number;
const p25 = readings[Math.floor(readings.length / 4)] as number;
const p75 = readings[Math.floor((readings.length * 3) / 4)] as number;
console.log(
  JSON.stringify({
    case: caseName,
    mode: caseName === "scope" ? scopeMode : caseName === "body" ? "facade" : "mixed-routes",
    nsPerRequest: Math.round(median),
    iqr: [Math.round(p25), Math.round(p75)],
    samples,
    batch,
  }),
);
