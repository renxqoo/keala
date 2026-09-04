// Fresh-process comparison against the installed Hono version.
//
//   bun bench/compare-hono-hotpaths.ts <keala|hono> <case>

// Each invocation owns one framework/JIT instance. Run variants in A-B-B-A
// order and compare process medians; never treat one best sample as evidence.

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import { Keala } from "../src/core/app.ts";
import type { Context } from "../src/core/context/context.ts";
import { createBodyParser, type ContextWithBody } from "../src/plugins/body-parser.ts";

type Framework = "keala" | "hono";
type CaseName =
  | "probe"
  | "probe-global-1"
  | "probe-global-3"
  | "probe-global-6"
  | "probe-global-1-async"
  | "probe-global-3-async"
  | "probe-global-6-async"
  | "body"
  | "body-limited"
  | "body-safe"
  | "body-raw-safe"
  | "text"
  | "query"
  | "text-dirty"
  | "text-dirty-correct"
  | "text-dirty-fallback"
  | "error"
  | "error-mw";
const pass = (_c: Context, next: () => Promise<void>) => next();
const asyncPass = async (_c: Context, next: () => Promise<void>): Promise<void> => {
  await next();
};
// Kept local so the same harness can run against the R3 worktree, where the
// capability constant does not exist and this unused bit is harmless.
const FORCE_IMMUTABLE_HEADERS = 1 << 13;

const framework = process.argv[2] as Framework;
const caseName = process.argv[3] as CaseName;
if (!(["keala", "hono"] as const).includes(framework)) {
  throw new TypeError("framework must be keala or hono");
}
if (
  !(
    [
      "probe",
      "probe-global-1",
      "probe-global-3",
      "probe-global-6",
      "probe-global-1-async",
      "probe-global-3-async",
      "probe-global-6-async",
      "body",
      "body-limited",
      "body-safe",
      "body-raw-safe",
      "text",
      "query",
      "text-dirty",
      "text-dirty-correct",
      "text-dirty-fallback",
      "error",
      "error-mw",
    ] as const
  ).includes(caseName)
) {
  throw new TypeError("unknown comparison case");
}

let handle: (request: Request) => Response | Promise<Response>;
let makeRequest: (index: number) => Request;

if (framework === "keala") {
  const app = new Keala({ env: "production" });
  if (caseName === "probe") {
    for (const prefix of ["/v1", "/oauth", "/admin"]) app.use(`${prefix}/*`, pass);
    app.get("/livez", (c) => c.json({ status: "ok" }));
  } else if (caseName.startsWith("probe-global-")) {
    const count = Number.parseInt(caseName.slice("probe-global-".length), 10);
    for (let index = 0; index < count; index++) {
      app.use(caseName.endsWith("-async") ? asyncPass : pass);
    }
    app.get("/livez", (c) => c.json({ status: "ok" }));
  } else if (caseName === "body-raw-safe") {
    const limit = 1024;
    const decoder = new TextDecoder();
    app.post("/v1/echo", async (c) => {
      const raw = c.raw;
      const declared = Number(raw.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > limit) return c.text("too large", 413);
      const bytes = await (raw as Request & { bytes(): Promise<Uint8Array> }).bytes();
      if (bytes.byteLength > limit) return c.text("too large", 413);
      try {
        return c.json(JSON.parse(decoder.decode(bytes)));
      } catch {
        return c.text("malformed JSON body", 400);
      }
    });
  } else if (caseName === "body" || caseName === "body-limited" || caseName === "body-safe") {
    app.use(createBodyParser({ jsonLimit: 1024 }));
    app.post("/v1/echo", async (c0) => {
      const c = c0 as ContextWithBody;
      return c.json(await c.req.json());
    });
  } else if (caseName === "error") {
    // R4.3: the error mapper builds the enterprise envelope centrally —
    // no onion layer, no promise guard on healthy requests.
    app.onError((error, c) => c.json({ error: { code: "internal" } }, error.status));
    app.get("/boom", () => {
      throw new Error("boom");
    });
  } else if (caseName === "error-mw") {
    // The koa-era shape this replaces: a global try/catch middleware that
    // catches before the funnel and hand-builds the same envelope.
    app.use(async (c, next) => {
      try {
        await next();
      } catch {
        return c.json({ error: { code: "internal" } }, 500);
      }
    });
    app.get("/boom", () => {
      throw new Error("boom");
    });
  } else if (caseName === "query") {
    app.get("/search/:id", (c) => {
      c.setHeader("X-Query", "hit");
      return c.text(`${c.params?.["id"]} ${c.query("name")} ${c.query("page")}`);
    });
  } else {
    if (
      caseName === "text-dirty" ||
      caseName === "text-dirty-correct" ||
      caseName === "text-dirty-fallback"
    ) {
      app.use(async (c, next) => {
        await next();
        // R4's immutable-capability flag. R3 ignores this unused bit and
        // naturally rebuilds, giving the fallback path an equal harness.
        if (caseName === "text-dirty-fallback") c.flags |= FORCE_IMMUTABLE_HEADERS;
        c.setHeader("x-late", "1");
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
  } else if (caseName.startsWith("probe-global-")) {
    const count = Number.parseInt(caseName.slice("probe-global-".length), 10);
    for (let index = 0; index < count; index++) {
      if (caseName.endsWith("-async")) {
        app.use("*", async (_c, next) => {
          await next();
        });
      } else {
        app.use("*", (_c, next) => next());
      }
    }
    app.get("/livez", (c) => c.json({ status: "ok" }));
  } else if (caseName === "body-limited") {
    // Fair parity via Hono's OFFICIAL body-limit middleware (R4.2 §4): declared
    // Content-Length over maxSize -> 413 without reading; streamed byte count
    // over maxSize -> 413; the downstream reader gets a rebuilt stream. This
    // is the shape a production Hono user deploys, not a hand-rolled loop.
    // NOTE the semantics gap: on the happy declared path it TRUSTS the header
    // and never re-checks actual bytes — a lying Content-Length slips through.
    app.use("/v1/echo", bodyLimit({ maxSize: 1024 }));
    app.post("/v1/echo", async (c) => c.json(await c.req.json()));
  } else if (caseName === "body-safe" || caseName === "body-raw-safe") {
    // Strictest fair parity: keala re-checks ACTUAL bytes even when
    // Content-Length is declared (its bytes() fast path). This handler is the
    // cheapest reasonable Hono equivalent of that lying-length guard — one
    // native bytes() read, actual BYTE-length check, decode and manual parse.
    const LIMIT = 1024;
    const decoder = new TextDecoder();
    app.post("/v1/echo", async (c) => {
      const raw = c.req.raw;
      const declared = Number(raw.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > LIMIT) {
        return c.text("request body exceeds the 1024 byte limit", 413);
      }
      const bytes = await (raw as Request & { bytes(): Promise<Uint8Array> }).bytes();
      if (bytes.byteLength > LIMIT) {
        return c.text("request body exceeds the 1024 byte limit", 413);
      }
      try {
        return c.json(JSON.parse(decoder.decode(bytes)));
      } catch {
        return c.text("malformed JSON body", 400);
      }
    });
  } else if (caseName === "error") {
    app.onError((_err, c) => c.json({ error: { code: "internal" } }, 500));
    app.get("/boom", () => {
      throw new Error("boom");
    });
  } else if (caseName === "query") {
    app.get("/search/:id", (c) => {
      const id = c.req.param("id");
      const name = c.req.query("name");
      const page = c.req.query("page");
      c.header("x-query", "hit");
      return c.text(`${id} ${name} ${page}`);
    });
  } else {
    if (
      caseName === "text-dirty" ||
      caseName === "text-dirty-correct" ||
      caseName === "text-dirty-fallback"
    ) {
      app.use("*", async (c, next) => {
        await next();
        c.header("x-late", "1");
      });
    }
    app.get("/text", (c) => {
      // Hono's bare dirty response is incorrect on Bun 1.4. This variant
      // pays Hono's public-API cost to produce the same text/plain contract
      // keala now restores internally.
      if (caseName === "text-dirty-correct" || caseName === "text-dirty-fallback") {
        c.header("content-type", "text/plain; charset=utf-8");
      }
      return c.text("hello");
    });
  }
  handle = (request) => app.fetch(request);
}

if (
  caseName === "body" ||
  caseName === "body-limited" ||
  caseName === "body-safe" ||
  caseName === "body-raw-safe"
) {
  makeRequest = () =>
    new Request("http://localhost/v1/echo", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "25" },
      body: '{"message":"hello world"}',
    });
} else if (caseName === "error" || caseName === "error-mw") {
  const shared = new Request("http://localhost/boom");
  makeRequest = () => shared;
} else {
  const path = caseName.startsWith("probe")
    ? "/livez"
    : caseName === "query"
      ? "/search/12345?name=keala&page=3"
      : "/text";
  const shared = new Request(`http://localhost${path}`);
  makeRequest = () => shared;
}

const isBodyCase =
  caseName === "body" ||
  caseName === "body-limited" ||
  caseName === "body-safe" ||
  caseName === "body-raw-safe";
const isErrorCase = caseName === "error" || caseName === "error-mw";
const warmup = isBodyCase || isErrorCase ? 20_000 : 60_000;
const batch = isBodyCase || isErrorCase ? 2_000 : 5_000;
const samples = 21;

const runOne = async (index: number): Promise<void> => {
  const response = await handle(makeRequest(index));
  const expectedStatus = isErrorCase ? 500 : 200;
  if (response.status !== expectedStatus) {
    throw new Error(`unexpected status ${response.status}`);
  }
  const body = await response.text();
  if (caseName.startsWith("probe") && body !== '{"status":"ok"}') {
    throw new Error("bad probe body");
  }
  if (isBodyCase && body !== '{"message":"hello world"}') {
    throw new Error("bad echo body");
  }
  if (caseName.startsWith("text") && body !== "hello") throw new Error("bad text body");
  if (caseName === "query" && body !== "12345 keala 3") throw new Error("bad query body");
  if (caseName === "query" && response.headers.get("x-query") !== "hit") {
    throw new Error("query header missing");
  }
  if (isErrorCase && body !== '{"error":{"code":"internal"}}') {
    throw new Error("bad error envelope");
  }
  if (caseName.includes("dirty") && response.headers.get("x-late") !== "1") {
    throw new Error("late header missing");
  }
  if (
    (caseName === "text-dirty-correct" || caseName === "text-dirty-fallback") &&
    !/^text\/plain(?:;|$)/i.test(response.headers.get("content-type") ?? "")
  ) {
    throw new Error("incorrect text content-type");
  }
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

// Untimed parity checks for the fair body comparison: the byte budget must
// hold on both frameworks, not just on the timed happy path. Malformed-JSON
// handling differs by framework default where parsing is not manual (keala
// maps it to an exposed 400; Hono's default onError turns the throw into a
// 500) — recorded, only the 413 budget parity is asserted.
if (caseName === "body-limited" || caseName === "body-safe" || caseName === "body-raw-safe") {
  const oversized = await handle(
    new Request("http://localhost/v1/echo", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "2048" },
      body: "x".repeat(2048),
    }),
  );
  if (oversized.status !== 413) {
    throw new Error(`declared-oversized must 413, got ${oversized.status}`);
  }
  // Lying length: declared 25, actually 2048. keala (body-safe semantics)
  // fails closed; official body-limit lets it through — the behavior gap
  // these cases exist to quantify, asserted per framework below.
  const lying = await handle(
    new Request("http://localhost/v1/echo", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "25" },
      body: '{"message":"' + "x".repeat(2048) + '"}',
    }),
  );
  const malformed = await handle(
    new Request("http://localhost/v1/echo", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "9" },
      body: "not-json{",
    }),
  );
  // Character count is not a byte budget: this payload stays below 1024 JS
  // code units while exceeding 1024 UTF-8 bytes. The strict comparator must
  // reject it exactly like keala; otherwise the benchmark is not semantic
  // parity for non-ASCII production traffic.
  const utf8Oversized = await handle(
    new Request("http://localhost/v1/echo", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "25" },
      body: JSON.stringify({ message: "界".repeat(400) }),
    }),
  );
  if ((caseName === "body-safe" || caseName === "body-raw-safe") && lying.status !== 413) {
    throw new Error(`lying-length must 413 under body-safe, got ${lying.status}`);
  }
  if ((caseName === "body-safe" || caseName === "body-raw-safe") && utf8Oversized.status !== 413) {
    throw new Error(`UTF-8 oversized body must 413 under body-safe, got ${utf8Oversized.status}`);
  }
  if (framework === "keala" && malformed.status !== 400) {
    throw new Error(`keala malformed must 400, got ${malformed.status}`);
  }
  if (framework === "hono" && malformed.status !== 400 && malformed.status !== 500) {
    throw new Error(`hono malformed must 400|500, got ${malformed.status}`);
  }
  console.log(
    JSON.stringify({
      framework,
      case: caseName,
      lyingStatus: lying.status,
      utf8OversizedStatus: utf8Oversized.status,
      malformedStatus: malformed.status,
    }),
  );
}
