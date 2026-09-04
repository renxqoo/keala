/**
 * Memory-leak soak: three layers of sustained load with heap sampling.
 *
 *   A. in-process framework requests (allocation stress, no network)
 *   B. full-stack HTTP against a real Bun.serve (fetch keep-alive, retries)
 *   C. concurrent flood (mixed routes/errors/404s in flight together)
 *
 * Each layer forces GC before/after and asserts the retained-heap drift stays
 * under budget. Run: bun scripts/soak.ts
 */

import { Keala } from "../src/core/app.ts";

const ROUNDS = 24;
const PER_ROUND = 20_000;
const DRIFT_BUDGET_BYTES = 1_500; // allowed retained growth per request

const app = new Keala({ keys: ["soak"], env: "test" });
app.use(async (c, next) => {
  c.setHeader("X-Soak", "1");
  await next();
});
app.get("/text", (c) => c.text("hello world"));
app.get("/json", (c) => c.json({ hello: "world", list: [1, 2, 3] }));
app.get("/users/:id", (c) => c.text(`user ${c.params?.["id"]}`));
app.get("/boom", () => {
  throw new Error("soak-boom");
});
app.get("/cookies", (c) => {
  c.cookies.set("sid", "x".repeat(24), { signed: true });
  c.body = "ok";
});

const paths = ["/text", "/json", "/users/7", "/boom", "/cookies"] as const;
const requests = paths.map((p) => new Request(`http://soak.local${p}`));

const gc = (): void => {
  Bun.gc(true);
  Bun.gc(true);
};

const sample = (): number => process.memoryUsage().heapUsed;

const driveInProcess = async (label: string): Promise<void> => {
  gc();
  const before = sample();
  for (let i = 0; i < PER_ROUND; i++) {
    const res = await app.handle(requests[i % paths.length]!);
    await res.text();
  }
  gc();
  const drift = (sample() - before) / PER_ROUND;
  const pass = drift <= DRIFT_BUDGET_BYTES;
  console.log(
    `${pass ? "✓" : "✗"} ${label}: ${PER_ROUND.toLocaleString()} req, retained drift ${drift.toFixed(1)} B/req (budget ${DRIFT_BUDGET_BYTES})`,
  );
  if (!pass) process.exitCode = 1;
};

const fetchRetry = async (url: string, init?: RequestInit): Promise<Response> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      lastError = err; // Bun fetch keep-alive reconnect race — retry once
    }
  }
  throw lastError;
};

const freshApp = (): InstanceType<typeof Keala> => {
  const clone = new Keala({ keys: ["soak"], env: "test" });
  clone.use(async (c, next) => {
    await next();
    void c.get("x-soak");
  });
  clone.get("/text", (c) => c.text("hello world"));
  clone.get("/json", (c) => c.json({ hello: "world", list: [1, 2, 3] }));
  clone.get("/users/:id", (c) => c.text(`user ${c.params?.["id"]}`));
  clone.get("/boom", () => {
    throw new Error("boom");
  });
  clone.get("/cookies", (c) => {
    c.cookies.set("soak", "1", { signed: true });
    c.body = "ok";
  });
  return clone;
};

const driveHttp = async (label: string): Promise<void> => {
  const server = freshApp().listen({ port: 0, hostname: "127.0.0.1" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const base = `http://127.0.0.1:${server.port}`;
  gc();
  const before = sample();
  const total = 8_000;
  for (let i = 0; i < total; i++) {
    const path = paths[i % paths.length];
    const res = await fetchRetry(`${base}${path}`);
    await res.text();
  }
  gc();
  const drift = (sample() - before) / total;
  server.stop(true);
  const pass = drift <= DRIFT_BUDGET_BYTES;
  console.log(
    `${pass ? "✓" : "✗"} ${label}: ${total.toLocaleString()} req over HTTP, retained drift ${drift.toFixed(1)} B/req`,
  );
  if (!pass) process.exitCode = 1;
};

const driveConcurrent = async (label: string): Promise<void> => {
  gc();
  const before = sample();
  const batches = 40;
  const width = 64;
  for (let b = 0; b < batches; b++) {
    const inFlight = Array.from({ length: width }, (_, i) =>
      app.handle(requests[(b * width + i) % paths.length]!),
    );
    for (const p of inFlight) await (await p).text();
  }
  gc();
  const total = batches * width;
  const drift = (sample() - before) / total;
  const pass = drift <= DRIFT_BUDGET_BYTES;
  console.log(
    `${pass ? "✓" : "✗"} ${label}: ${total.toLocaleString()} concurrent req, retained drift ${drift.toFixed(1)} B/req`,
  );
  if (!pass) process.exitCode = 1;
};

console.log(`keala soak — ${ROUNDS} rounds x ${PER_ROUND.toLocaleString()} (Bun ${Bun.version})`);

for (let round = 0; round < ROUNDS; round++) {
  await driveInProcess(`round ${round} A in-process`);
  if (round % 6 === 0) await driveHttp(`round ${round} B http`);
  if (round % 6 === 3) await driveConcurrent(`round ${round} C concurrent`);
}

if (process.exitCode === 0 || process.exitCode === undefined) {
  console.log("SOAK OK — no retained-heap growth beyond budget");
  process.exit(0);
}
console.error("SOAK FAILED: retained-heap drift exceeded budget");
process.exit(1);
