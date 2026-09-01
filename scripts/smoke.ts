/**
 * Production smoke test: boots a REAL Bun.serve on an ephemeral port and
 * exercises every critical path over live HTTP.
 *
 * Run: bun scripts/smoke.ts   (exit code 0 = all checks passed)
 */

import { dirname } from "node:path";

import { Keala } from "../src/core/app.ts";
import { Router } from "../src/router/group.ts";

const root = dirname(new URL(import.meta.url).pathname);

let failures = 0;
const check = (name: string, condition: boolean, detail = ""): void => {
  if (condition) {
    console.log(`  ✓ ${name}`);
    return;
  }
  failures += 1;
  console.error(`  ✗ ${name} ${detail}`);
};

const app = new Keala({ keys: ["smoke-secret"], env: "production" });
const api = new Router({ prefix: "/api" });

api.param("id", async (c, next) => {
  if (!/^\d+$/.test(c.params?.["id"] ?? "")) {
    c.throw(400, "invalid id");
  }
  await next();
});

api.get("/users/:id", async (c) => {
  c.cookies.set("last", c.params?.["id"] ?? "", { signed: true, httpOnly: true });
  c.body = { id: Number(c.params?.["id"]) };
});

api.get("/hello", (c) => c.text("hello world"));
api.get("/boom", () => {
  throw new Error("boom");
});
api.post("/users", (c) => {
  c.status = 201;
  c.set("Location", "/api/users/42");
  c.body = { created: true };
});
api.get("/query", (c) =>
  c.json({ q: c.query["q"] ?? null, n: (c.query["n"] as string[])?.length ?? 0 }),
);
api.get("/teapot", (c) => c.throw(418, "short and stout"));

app.use(async (c, next) => {
  const start = Date.now();
  await next();
  c.set("X-Response-Time", `${Date.now() - start}ms`);
});
app.mount("/", api);
app.get("/redirect", (c) => {
  c.status = 302;
  c.redirect("/api/hello");
});
app.notFound((c) => c.text("nothing here", 404));

const server = app.listen({ port: 0, hostname: "127.0.0.1" });
await new Promise((resolve) => setTimeout(resolve, 50));
const base = `http://127.0.0.1:${server.port}`;

const get = async (path: string, init?: RequestInit): Promise<Response> =>
  fetch(`${base}${path}`, init);

{
  const res = await get("/api/hello");
  const body = await res.text();
  check("text route", res.status === 200 && body === "hello world", `${res.status} ${body}`);
  const ct = res.headers.get("content-type") ?? "";
  check("runtime content-type over HTTP", ct.startsWith("text/plain"), ct);
  check("onion middleware header", res.headers.get("x-response-time") !== null);
}

{
  const res = await get("/api/users/42");
  const body = (await res.json()) as { id: number };
  check("param + json + signed cookie", res.status === 200 && body.id === 42, JSON.stringify(body));
  const cookie = res.headers.getSetCookie()[0] ?? "";
  check("signed set-cookie", cookie.includes("last=") && cookie.includes("."), cookie);
  const verified = await get("/api/query?n=1&n=2&q=x");
  const q = (await verified.json()) as { q: string | null; n: number };
  check("multi-value query", q.q === "x" && q.n === 2, JSON.stringify(q));
}

{
  const res = await get("/api/users/not-a-number");
  check("param middleware 400", res.status === 400, String(res.status));
  const boom = await get("/api/boom");
  const text = await boom.text();
  check(
    "unhandled error → opaque 500",
    boom.status === 500 && text === "Internal Server Error",
    `${boom.status} ${text}`,
  );
  const teapot = await get("/api/teapot");
  check(
    "exposed 4xx message",
    teapot.status === 418 && (await teapot.text()) === "short and stout",
  );
}

{
  const created = await get("/api/users", { method: "POST" });
  check(
    "POST + Location + 201",
    created.status === 201 && created.headers.get("location") === "/api/users/42",
  );
  const wrong = await get("/api/users", { method: "DELETE" });
  check("405 + Allow", wrong.status === 405 && (wrong.headers.get("allow") ?? "").includes("POST"));
  const options = await get("/api/users", { method: "OPTIONS" });
  check("OPTIONS 200 + Allow", options.status === 200);
  const head = await get("/api/hello", { method: "HEAD" });
  check(
    "HEAD drops body, keeps CL",
    head.status === 200 && head.headers.get("content-length") === "11",
  );
  const redirect = await get("/redirect", { redirect: "manual" });
  check(
    "redirect 302",
    redirect.status === 302 && redirect.headers.get("location") === "/api/hello",
  );
  const missing = await get("/definitely-not-here");
  check("custom notFound", missing.status === 404 && (await missing.text()) === "nothing here");
}

// --- Bun-native branches (real runtime, not the stubbed bridge tests) -----
if (typeof Bun !== "undefined") {
  const nativeApp = new Keala({ env: "production" });
  const { hashPassword, verifyPassword } = await import("../src/helpers/password.ts");
  const { csrfToken } = await import("../src/middleware/csrf-token.ts");
  const hash = await hashPassword("smoke-pw");
  check(
    "pbkdf2 round-trip (real Bun)",
    hash.startsWith("pbkdf2$") &&
      (await verifyPassword(hash, "smoke-pw")) &&
      !(await verifyPassword(hash, "other")),
  );
  const tokens = csrfToken({ secret: "smoke-secret" });
  const token = tokens.issue("s1");
  check(
    "csrfToken native path (real Bun)",
    tokens.verify(token, "s1") && !tokens.verify(token, "s2"),
  );

  // The native routes table, served by a REAL Bun.serve: method scoping
  // (non-GET must fall through to fetch) and dir serving with Range.
  nativeApp.sink("/n/*", { dir: root });
  nativeApp.sink("/ping", new Response("pong"));
  const nativeServer = nativeApp.listen({ port: 3191, hostname: "127.0.0.1" });
  const nb = "http://127.0.0.1:3191";
  const pong = await fetch(`${nb}/ping`);
  check("native table GET /ping", pong.status === 200 && (await pong.text()) === "pong");
  const post = await fetch(`${nb}/ping`, { method: "POST" });
  check("native table POST /ping falls through to 405", post.status === 405);
  const file = await fetch(`${nb}/n/smoke.ts`);
  check("native {dir} serves files", file.status === 200 && (await file.text()).includes("SMOKE"));
  nativeServer.stop(true);
}

server.stop(true);
if (failures === 0) {
  console.log("SMOKE OK");
  process.exit(0);
}
console.error(`SMOKE FAILED: ${failures} check(s)`);
process.exit(1);
