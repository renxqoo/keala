// Error-path cost decomposition (R4.3 review follow-up).
//
//   bun bench/error-profile.ts <a|b|c|d|e|f>
//
// Isolates where the keala-vs-Hono error-path gap lives:
//   A  keala happy: handler returns a PREBUILT envelope Response   (machinery floor)
//   B  keala error: mapper returns the same PREBUILT Response      (funnel minus c.json)
//   C  keala error: mapper builds the envelope via c.json          (full shape)
//   D  hono  happy: handler returns the PREBUILT envelope
//   E  hono  error: onError returns the PREBUILT Response
//   F  hono  error: onError builds the envelope via c.json

import { Hono } from "hono";

import { Keala } from "../src/core/app.ts";

type Variant = "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h";
const variant = process.argv[2] as Variant;
if (!(["a", "b", "c", "d", "e", "f", "g", "h"] as const).includes(variant)) {
  throw new TypeError("unknown profile variant");
}

const envelopeBody = '{"error":{"code":"internal"}}';
const prebuilt = (): Response =>
  new Response(envelopeBody, {
    status: 500,
    headers: { "content-type": "application/json" },
  });

let handle: (request: Request) => Response | Promise<Response>;

if (variant === "g") {
  // keala error: mapper builds the envelope via RAW Response.json (no sugar)
  const app = new Keala({ env: "test" });
  app.onError(() => Response.json({ error: { code: "internal" } }, { status: 500 }));
  app.get("/boom", () => {
    throw new Error("boom");
  });
  handle = (request) => app.handle(request);
} else if (variant === "h") {
  // keala error, PRE-STATUSSED duck-typed HttpError: toHttpError is a pure
  // passthrough (no in-place classification writes) — isolates classify.
  const res = prebuilt();
  const app = new Keala({ env: "test" });
  app.onError(() => res);
  app.get("/boom", () => {
    throw Object.assign(new Error("boom"), { status: 500, expose: false });
  });
  handle = (request) => app.handle(request);
} else if (variant === "a" || variant === "b" || variant === "c") {
  const app = new Keala({ env: "test" });
  if (variant === "a") {
    const res = prebuilt();
    app.get("/boom", () => res);
  } else {
    if (variant === "b") {
      const res = prebuilt();
      app.onError(() => res);
    } else {
      app.onError((_error, c) => c.json({ error: { code: "internal" } }, 500));
    }
    app.get("/boom", () => {
      throw new Error("boom");
    });
  }
  handle = (request) => app.handle(request);
} else {
  const app = new Hono();
  if (variant === "d") {
    const res = prebuilt();
    app.get("/boom", () => res);
  } else {
    if (variant === "e") {
      const res = prebuilt();
      app.onError(() => res);
    } else {
      app.onError((_err, c) => c.json({ error: { code: "internal" } }, 500));
    }
    app.get("/boom", () => {
      throw new Error("boom");
    });
  }
  handle = (request) => app.fetch(request);
}

const shared = new Request("http://localhost/boom");
const warmup = 20_000;
const batch = 2_000;
const samples = 21;

// Status + content-type only: reading the body would consume the SHARED
// prebuilt Responses of variants b/e (the bodyUsed guard would rightly
// fire) and pollute every variant with stream-pump noise. Body correctness
// is locked by the test suite; this harness isolates machinery cost.
const runOne = async (): Promise<void> => {
  const response = await handle(shared);
  if (response.status !== 500) throw new Error(`unexpected status ${response.status}`);
  if (!String(response.headers.get("content-type")).startsWith("application/json")) {
    throw new Error("bad content-type");
  }
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
  }),
);
