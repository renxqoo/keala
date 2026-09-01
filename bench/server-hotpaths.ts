// Live-HTTP counterpart of verify-hotpaths.ts. Intended for autocannon/wrk;
// KEALA_SOURCE can target a detached main worktree for an exact A/B.

import { pathToFileURL } from "node:url";

import type { Context } from "../src/core/context/context.ts";
import type { Plugin } from "../src/types.ts";

type Handler = (c: Context, next: () => Promise<void>) => unknown;
interface BenchApp {
  use(...middleware: (string | Handler | Plugin)[]): BenchApp;
  get(path: string, handler: Handler): BenchApp;
  post(path: string, handler: Handler): BenchApp;
  handle(request: Request): Promise<Response>;
}
interface BenchModule {
  Keala: new (options?: { env?: string }) => BenchApp;
  createBodyParser(options?: { jsonLimit?: number }): Plugin;
}

const source = process.env["KEALA_SOURCE"] ?? new URL("../src/index.ts", import.meta.url).pathname;
const { Keala, createBodyParser } = (await import(pathToFileURL(source).href)) as BenchModule;
const caseName = process.argv[2];
const scopeMode = process.argv[3];
const port = Number(process.env["KEALA_BENCH_PORT"] ?? "9820");
const app = new Keala({ env: "production" });
const pass: Handler = (_c, next) => next();

if (caseName === "body") {
  app.use(createBodyParser({ jsonLimit: 1024 }));
  app.post("/v1/echo", async (c) => {
    const req = (c as Context & { req: { json(): Promise<unknown> } }).req;
    return c.json(await req.json());
  });
} else if (caseName === "scope") {
  for (const prefix of ["/v1", "/oauth", "/admin"]) {
    if (scopeMode === "legacy") {
      app.use((c, next) =>
        c.path === prefix || c.path.startsWith(`${prefix}/`) ? pass(c, next) : next(),
      );
    } else if (scopeMode === "scoped") {
      app.use(`${prefix}/*`, pass);
    } else {
      throw new TypeError("scope case requires legacy or scoped mode");
    }
  }
  app.get("/livez", (c) => c.json({ status: "ok" }));
} else if (caseName === "dirty") {
  app.use(async (c, next) => {
    await next();
    c.set("x-late", "1");
  });
  app.get("/text", (c) => c.text("hello"));
} else {
  throw new TypeError("usage: server-hotpaths.ts <body|scope|dirty> [legacy|scoped]");
}

const server = Bun.serve({ port, fetch: (request) => app.handle(request) });
console.log(JSON.stringify({ ready: true, port: server.port, case: caseName, mode: scopeMode }));
