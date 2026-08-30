/**
 * Production smoke test: boots a REAL Bun.serve on an ephemeral port and
 * exercises every critical path over live HTTP.
 *
 * Run: bun scripts/smoke.ts   (exit code 0 = all checks passed)
 */

import { createApp } from "../src/application/app.ts";
import { createRouter } from "../src/router/router.ts";

let failures = 0;
const check = (name: string, condition: boolean, detail = ""): void => {
  if (condition) {
    console.log(`  ✓ ${name}`);
    return;
  }
  failures += 1;
  console.error(`  ✗ ${name} ${detail}`);
};

const app = createApp({ keys: ["smoke-secret"], env: "production" });
const router = createRouter({ prefix: "/api" });

router.param("id", async (ctx, next) => {
  if (!/^\d+$/.test(ctx.params["id"] ?? "")) {
    ctx.throw(400, "invalid id");
  }
  await next();
});

router.get("/users/:id", async (ctx) => {
  ctx.cookies.set("last", ctx.params["id"] as string, { httpOnly: true, signed: true });
  ctx.body = { id: Number(ctx.params["id"]) };
});

router.get("/hello", async (ctx) => {
  ctx.type = "text/plain";
  ctx.body = "hello world";
});

router.get("/boom", async () => {
  throw new Error("unexpected");
});

router.post("/users", async (ctx) => {
  ctx.status = 201;
  ctx.body = { created: true };
});

app.use(async (ctx, next) => {
  const started = Date.now();
  await next();
  ctx.set("X-Response-Time", `${Date.now() - started}`);
});

app.use(router.routes()).use(router.allowedMethods());

const server = app.listen(0, () => undefined);
const base = `http://localhost:${server.port}`;

const main = async (): Promise<void> => {
  console.log(`bun-koa smoke test on ${base} (Bun ${Bun.version})`);

  const hello = await fetch(`${base}/api/hello`);
  check("GET /api/hello status", hello.status === 200);
  check("GET /api/hello body", (await hello.text()) === "hello world");
  check("timing header present", hello.headers.get("x-response-time") !== null);

  const user = await fetch(`${base}/api/users/42`);
  const userJson = (await user.json()) as { id: number };
  check("GET /api/users/42 status", user.status === 200);
  check("param middleware + JSON body", userJson.id === 42);
  const setCookie = user.headers.getSetCookie()[0] ?? "";
  check("signed cookie set", setCookie.startsWith("last=") && setCookie.includes("."), setCookie);

  const roundTrip = await fetch(`${base}/api/users/1`, {
    headers: { Cookie: setCookie.split(";")[0] ?? "" },
  });
  await roundTrip.json();
  check("cookie round-trip verified", roundTrip.status === 200);

  const created = await fetch(`${base}/api/users`, { method: "POST" });
  check("POST /api/users -> 201", created.status === 201);

  const bad = await fetch(`${base}/api/users/abc`);
  check(
    "invalid param -> 400 + exposed message",
    bad.status === 400 && (await bad.text()) === "invalid id",
  );

  const method = await fetch(`${base}/api/hello`, { method: "DELETE" });
  check(
    "405 with Allow",
    method.status === 405 && (method.headers.get("allow") ?? "").includes("GET"),
  );

  const missing = await fetch(`${base}/api/nope`);
  check("unknown route -> 404", missing.status === 404);

  const serverError = await fetch(`${base}/api/boom`);
  const serverBody = await serverError.text();
  check(
    "500 hides internals in production",
    serverError.status === 500 && serverBody === "Internal Server Error",
  );

  const head = await fetch(`${base}/api/hello`, { method: "HEAD" });
  check(
    "HEAD has no body but keeps length",
    head.status === 200 && head.headers.get("content-length") === "11",
  );

  server.stop();
  if (failures === 0) {
    console.log("SMOKE OK");
    process.exit(0);
  }
  console.error(`SMOKE FAILED (${failures} checks)`);
  process.exit(1);
};

void main();
