/**
 * Production smoke test: boots a REAL Bun.serve on an ephemeral port and
 * exercises every critical path over live HTTP.
 *
 * Run: bun scripts/smoke.ts   (exit code 0 = all checks passed)
 */

import { dirname } from "node:path";

import { Keala } from "../src/core/app.ts";
import { Router } from "../src/router/group.ts";
import { createError } from "../src/http/errors.ts";

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
  if (!/^\d+$/.test(c.params("id") ?? "")) {
    c.throw(400, "invalid id");
  }
  await next();
});

api.get("/users/:id", async (c) => {
  c.cookies.set("last", c.params("id") ?? "", { signed: true, httpOnly: true });
  return c.json({ id: Number(c.params("id")) });
});

api.get("/hello", (c) => c.text("hello world"));
api.get("/boom", () => {
  throw new Error("boom");
});
api.post("/users", (c) => {
  c.setHeader("Location", "/api/users/42");
  return c.json({ created: true }, 201);
});
api.get("/query", (c) => c.json({ q: c.query("q") ?? null, n: c.queries("n").length }));
api.get("/teapot", (c) => c.throw(418, "short and stout"));

app.use(async (c, next) => {
  const start = Date.now();
  await next();
  c.setHeader("X-Response-Time", `${Date.now() - start}ms`);
});
app.mount("/", api);
app.get("/redirect", (c) => c.redirect("/api/hello"));
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

  // Guarded pooling over a REAL Bun.serve: snapshot-body responses retire
  // unwrapped, so Bun's serve-time string MIME inference must survive —
  // the first pooling A/B matrix shipped pooled /text with NO content-type.
  // Second pass rides a recycled context.
  const pooledApp = new Keala({ env: "production", pooling: true });
  pooledApp.get("/t", (c) => c.text("hello world"));
  pooledApp.get("/j", (c) => c.json({ hello: "world" }));
  pooledApp.get("/s", (c) => c.text("state"));
  const pooledServer = pooledApp.listen({ port: 0, hostname: "127.0.0.1" });
  const pb = `http://127.0.0.1:${pooledServer.port}`;
  for (let pass = 0; pass < 2; pass++) {
    const text = await fetch(`${pb}/t`);
    const textCt = text.headers.get("content-type") ?? "";
    check(
      `pooled text content-type (pass ${pass})`,
      text.status === 200 &&
        (await text.text()) === "hello world" &&
        textCt.startsWith("text/plain"),
      `${text.status} ${textCt}`,
    );
    const json = await fetch(`${pb}/j`);
    const jsonCt = json.headers.get("content-type") ?? "";
    check(
      `pooled json content-type (pass ${pass})`,
      json.status === 200 && jsonCt.startsWith("application/json"),
      `${json.status} ${jsonCt}`,
    );
    const state = await fetch(`${pb}/s`);
    const stateCt = state.headers.get("content-type") ?? "";
    check(
      `pooled state-mode content-type (pass ${pass})`,
      state.status === 200 && (await state.text()) === "state" && stateCt.startsWith("text/plain"),
      `${state.status} ${stateCt}`,
    );
  }
  pooledServer.stop(true);

  // --- Sink parity legs (real Bun.serve) ----------------------------------
  // L2: the native routes table against the mirror's predictions, including
  // the LEDGERED divergences pinned by direction (docs/PARITY.md): malformed
  // escapes decode to U+FFFD natively and pass through verbatim on the
  // mirror; bun#37603 raw-byte misses self-heal through fetch. L3: the
  // nativeRoutes:false opt-out equals the mirror exactly.
  {
    const sunkApp = new Keala({ env: "production" });
    sunkApp.sink("/sp-health", new Response("fine"));
    sunkApp.sink(
      "/sp/h",
      () => new Response("b", { headers: { "content-type": "text/plain; charset=utf-8" } }),
    );
    sunkApp.sink("/sp/users/:id", (_request, params) =>
      Response.json({ id: params["id"] ?? null }),
    );
    sunkApp.sink("/sp/teapot", () => {
      throw createError(418, "short and stout", { expose: true });
    });
    // @ts-expect-error -- runtime contract check: never Bun's 200 help page
    sunkApp.sink("/sp/bad", () => "not-a-response");
    const sunkServer = sunkApp.listen({ port: 0, hostname: "127.0.0.1" });
    const sb = `http://127.0.0.1:${sunkServer.port}`;

    const nativeRow = async (
      path: string,
      init?: RequestInit,
    ): Promise<[number, string, string | null, string | null]> => {
      const res = await fetch(`${sb}${path}`, init);
      return [
        res.status,
        await res.text(),
        res.headers.get("content-type"),
        res.headers.get("allow"),
      ];
    };
    const parityRow = async (
      name: string,
      path: string,
      expect:
        | [number, string]
        | ((observed: [number, string, string | null, string | null]) => boolean),
      init?: RequestInit,
    ): Promise<void> => {
      const observed = await nativeRow(path, init);
      const ok =
        typeof expect === "function"
          ? expect(observed)
          : observed[0] === expect[0] && observed[1] === expect[1];
      check(`sink native ${name}`, ok, `${path} -> ${JSON.stringify(observed)}`);
    };

    await parityRow("GET static", "/sp-health", [200, "fine"]);
    await parityRow("GET fn", "/sp/h", [200, "b"]);
    await parityRow("GET param plain", "/sp/users/12345", [200, '{"id":"12345"}']);
    await parityRow("GET param unicode", "/sp/users/caf%C3%A9", [
      200,
      JSON.stringify({ id: "café" }),
    ]);
    await parityRow("GET param digits", "/sp/users/%31%32%33", [200, '{"id":"123"}']);
    await parityRow("GET param %2F decoded", "/sp/users/a%2Fb", [200, '{"id":"a/b"}']);
    // LEDGERED: native substitutes U+FFFD for malformed escapes; the mirror
    // passes them through verbatim (asserted on the L3 leg below).
    await parityRow("GET param malformed → U+FFFD", "/sp/users/%zz", [
      200,
      JSON.stringify({ id: "�" }),
    ]);
    await parityRow("empty param misses to fetch 404", "/sp/users/", [404, "Not Found"]);
    // bun#37603: the native table matches raw bytes — the encoded variant
    // misses the table, falls through fetch, and the decoding router serves
    // it anyway (final behavior identical, mechanism ledgered).
    await parityRow("raw-byte miss self-heals", "/sp%2Dhealth", [200, "fine"]);
    await parityRow("HEAD rides GET", "/sp/h", [200, ""], { method: "HEAD" });
    await parityRow(
      "POST falls through to 405",
      "/sp/h",
      ([status, , , allow]) => status === 405 && (allow ?? "").includes("GET"),
      { method: "POST" },
    );
    await parityRow(
      "OPTIONS falls through with Allow",
      "/sp/h",
      ([status, , , allow]) => status === 200 && (allow ?? "").includes("GET"),
      { method: "OPTIONS" },
    );
    await parityRow("exposed 4xx through the builtin funnel", "/sp/teapot", [
      418,
      "short and stout",
    ]);
    await parityRow("non-Response return is a loud 500", "/sp/bad", [500, "Internal Server Error"]);
    sunkServer.stop(true);

    // L3: the JS-mirror contract under nativeRoutes:false — including the
    // OTHER side of the malformed-escape ledger row.
    const mirrorApp = new Keala({ env: "production" });
    mirrorApp.sink("/sp/users/:id", (_request, params) =>
      Response.json({ id: params["id"] ?? null }),
    );
    const mirrorServer = mirrorApp.listen({ port: 0, hostname: "127.0.0.1", nativeRoutes: false });
    const mb = `http://127.0.0.1:${mirrorServer.port}`;
    const mirrorRes = await fetch(`${mb}/sp/users/%zz`);
    check(
      "sink mirror malformed passes through verbatim",
      mirrorRes.status === 200 && (await mirrorRes.text()) === JSON.stringify({ id: "%zz" }),
      `${mirrorRes.status}`,
    );
    mirrorServer.stop(true);
  }
}

server.stop(true);
if (failures === 0) {
  console.log("SMOKE OK");
  process.exit(0);
}
console.error(`SMOKE FAILED: ${failures} check(s)`);
process.exit(1);
