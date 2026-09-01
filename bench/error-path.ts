// Fresh-process error-path comparison (R4.3).
//
//   bun bench/error-path.ts <keala-error|keala-decline|keala-error-mw|keala-422|hono-error>
//
// Variants (all produce the SAME wire result where comparable):
//   keala-error    — unexpected Error + onError mapper returning a JSON envelope
//   keala-422      — c.throw(422) business error + onError mapper envelope
//   keala-decline  — c.throw(422) + registered decline mapper (built-in response)
//   keala-error-mw — koa-era shape: global try/catch middleware envelope
//   hono-error     — unexpected Error + Hono onError envelope

import { Hono } from "hono";

import { Keala } from "../src/core/app.ts";

type Variant = "keala-error" | "keala-422" | "keala-decline" | "keala-error-mw" | "hono-error";

const variant = process.argv[2] as Variant;
if (
  !(
    ["keala-error", "keala-422", "keala-decline", "keala-error-mw", "hono-error"] as const
  ).includes(variant)
) {
  throw new TypeError("unknown error-path variant");
}

const envelopeBody = '{"error":{"code":"internal"}}';

let handle: (request: Request) => Response | Promise<Response>;
let expectedStatus = 500;
let expectedBody = envelopeBody;

if (variant.startsWith("keala")) {
  const app = new Keala({ env: "test" });
  if (variant === "keala-error" || variant === "keala-422") {
    app.onError((error, c) => c.json({ error: { code: "internal" } }, error.status));
    if (variant === "keala-422") expectedStatus = 422;
  } else if (variant === "keala-decline") {
    app.onError(() => undefined);
    expectedStatus = 422;
    expectedBody = "bad input";
  } else {
    app.use(async (c, next) => {
      try {
        await next();
      } catch {
        return c.json({ error: { code: "internal" } }, 500);
      }
    });
  }
  if (variant === "keala-422" || variant === "keala-decline") {
    app.get("/boom", (c) => c.throw(422, "bad input", { expose: true }));
  } else {
    app.get("/boom", () => {
      throw new Error("boom");
    });
  }
  handle = (request) => app.handle(request);
} else {
  const app = new Hono();
  app.onError((_err, c) => c.json({ error: { code: "internal" } }, 500));
  app.get("/boom", () => {
    throw new Error("boom");
  });
  handle = (request) => app.fetch(request);
}

const shared = new Request("http://localhost/boom");
const warmup = 20_000;
const batch = 2_000;
const samples = 21;

const runOne = async (): Promise<void> => {
  const response = await handle(shared);
  if (response.status !== expectedStatus) {
    throw new Error(`unexpected status ${response.status}`);
  }
  const body = await response.text();
  if (body !== expectedBody) throw new Error(`bad body ${body}`);
};

for (let i = 0; i < warmup; i++) await runOne();
const readings: number[] = [];
for (let sample = 0; sample < samples; sample++) {
  const start = performance.now();
  for (let i = 0; i < batch; i++) await runOne();
  readings.push(((performance.now() - start) * 1e6) / batch);
}
readings.sort((a, b) => a - b);
console.log(
  JSON.stringify({
    variant,
    nsPerRequest: Math.round(readings[Math.floor(samples / 2)] as number),
    iqr: [
      Math.round(readings[Math.floor(samples / 4)] as number),
      Math.round(readings[Math.floor((samples * 3) / 4)] as number),
    ],
    samples,
    batch,
  }),
);
