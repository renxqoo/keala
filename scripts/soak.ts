/**
 * Memory-leak soak test (run under Bun).
 *
 * Drives hundreds of thousands of requests through every allocation-heavy
 * path (text / JSON / params / cookies / errors / redirects / query parsing),
 * forces GC between rounds and asserts that heap usage stabilizes.
 *
 * Run: bun scripts/soak.ts   (exit code 0 = no leak detected)
 */

import { createApp } from "../src/application/app.ts";
import { createRouter } from "../src/router/router.ts";

const ROUNDS = Number(process.argv[2] ?? 8);
const PER_ROUND = Number(process.argv[3] ?? 150_000);
const HTTP_ROUNDS = 4;
const HTTP_PER_ROUND = 20_000;
const TOLERANCE = 0.03; // 3% drift allowed after stabilization

const buildApp = (opts: { pooling?: boolean } = {}) => {
  // biome-ignore lint: options flow through to createApp below
  const app = createApp({ keys: ["soak-key"], env: "test", pooling: opts.pooling });
  const router = createRouter({ prefix: "/api" });

  router.get("/text", (ctx) => {
    ctx.body = "hello world";
  });
  router.get("/json", (ctx) => {
    ctx.body = { hello: "world", n: 42 };
  });
  router.get("/users/:id(\\d+)", (ctx) => {
    ctx.body = `user ${ctx.params.id}`;
  });
  router.get(
    "/state",
    async (ctx, next) => {
      ctx.state.step = 1;
      await next();
      ctx.set("X-Done", "yes");
    },
    (ctx) => {
      ctx.cookies.set("seen", "1", { httpOnly: true, signed: true });
      ctx.body = `q=${String(ctx.query.q ?? "-")}`;
    },
  );
  router.get("/error", () => {
    throw new Error("planned failure");
  });
  router.get("/redirect", (ctx) => {
    ctx.redirect("/api/text");
  });
  router.get("/cookies", (ctx) => {
    ctx.body = ctx.cookies.get("seen") ?? "none";
  });
  app.use(router.routes()).use(router.allowedMethods());
  return app;
};

const gc = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) {
    Bun.gc(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const heap = (): number => process.memoryUsage().heapUsed;
const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(2)}MB`;

let failures = 0;
const check = (name: string, condition: boolean, detail: string): void => {
  const mark = condition ? "✓" : "✗";
  if (!condition) failures += 1;
  console.log(`  ${mark} ${name} ${detail}`);
};

// Bun's fetch client occasionally races keep-alive reconnects under
// sustained concurrent load; retry a few times on transport errors.
const fetchRetry = async (url: string): Promise<Response> => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url);
    } catch (err) {
      if (attempt >= 2) throw err;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
};

const main = async (): Promise<void> => {
  console.log(
    `bun-koa soak test — ${ROUNDS} rounds x ${PER_ROUND} in-process requests (Bun ${Bun.version})`,
  );

  // ---------- Layer A: in-process framework allocations ----------
  const app = buildApp();
  const paths = [
    "http://localhost:3000/api/text",
    "http://localhost:3000/api/json",
    "http://localhost:3000/api/users/12345",
    "http://localhost:3000/api/state?q=soak",
    "http://localhost:3000/api/error",
    "http://localhost:3000/api/redirect",
    "http://localhost:3000/api/cookies",
  ];
  const requests = paths.map(
    (url) =>
      new Request(url, {
        headers: { Accept: "text/html,application/json", Cookie: "seen=soak" },
      }),
  );
  app.on("error", () => {});

  // warmup (JIT, caches, hidden classes)
  for (let i = 0; i < 30_000; i++) {
    const request = requests[i % requests.length] as Request;
    const res = await app.handle(request);
    await res.text();
  }
  await gc();

  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round++) {
    for (let i = 0; i < PER_ROUND; i++) {
      const request = requests[i % requests.length] as Request;
      const res = await app.handle(request);
      await res.text();
    }
    await gc();
    const used = heap();
    samples.push(used);
    console.log(`  round ${round + 1}/${ROUNDS}: heap ${mb(used)}`);
  }

  const first = samples[0] as number;
  const last = samples[samples.length - 1] as number;
  const drift = (last - first) / first;
  check(
    "in-process heap stabilized",
    Math.abs(drift) < TOLERANCE,
    `drift ${(drift * 100).toFixed(2)}% (${mb(first)} -> ${mb(last)})`,
  );

  // ---------- Layer B: full stack through a real Bun.serve ----------
  console.log(`full-stack soak — ${HTTP_ROUNDS} rounds x ${HTTP_PER_ROUND} HTTP requests`);
  const serverApp = buildApp();
  serverApp.on("error", () => {});
  const server = serverApp.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${server.port}`;

  const httpSamples: number[] = [];
  for (let round = 0; round < HTTP_ROUNDS; round++) {
    const batch = 32;
    for (let sent = 0; sent < HTTP_PER_ROUND; sent += batch) {
      await Promise.all(
        Array.from({ length: batch }, async (_, i) => {
          const res = await fetchRetry(
            `${base}${paths[(sent + i) % paths.length]?.slice("http://localhost:3000".length) ?? "/api/text"}`,
          );
          await res.text();
        }),
      );
    }
    await gc();
    const used = heap();
    httpSamples.push(used);
    console.log(`  round ${round + 1}/${HTTP_ROUNDS}: heap ${mb(used)}`);
  }
  server.stop();

  const httpFirst = httpSamples[0] as number;
  const httpLast = httpSamples[httpSamples.length - 1] as number;
  const httpDrift = (httpLast - httpFirst) / httpFirst;
  check(
    "full-stack heap stabilized",
    Math.abs(httpDrift) < TOLERANCE,
    `drift ${(httpDrift * 100).toFixed(2)}% (${mb(httpFirst)} -> ${mb(httpLast)})`,
  );

  // ---------- Layer C: pooled mode under load ----------
  console.log(`pooled soak — ${ROUNDS} rounds x ${PER_ROUND} in-process requests (pooling on)`);
  const pooledApp = buildApp({ pooling: true });
  pooledApp.on("error", () => {});
  const warm = await pooledApp.handle(requests[0] as Request);
  await warm.text();
  await gc();
  const pooledSamples: number[] = [];
  for (let round = 0; round < ROUNDS; round++) {
    for (let i = 0; i < PER_ROUND; i++) {
      const request = requests[i % requests.length] as Request;
      const res = await pooledApp.handle(request);
      await res.text();
    }
    await gc();
    pooledSamples.push(heap());
  }
  const pooledDrift =
    ((pooledSamples[pooledSamples.length - 1] as number) - (pooledSamples[0] as number)) /
    (pooledSamples[0] as number);
  check(
    "pooled heap stabilized",
    Math.abs(pooledDrift) < TOLERANCE,
    `drift ${(pooledDrift * 100).toFixed(2)}% (${mb(pooledSamples[0] as number)} -> ${mb(pooledSamples[pooledSamples.length - 1] as number)})`,
  );

  const rss = process.memoryUsage.rss();
  console.log(`final rss: ${mb(rss)}`);

  if (failures === 0) {
    console.log("SOAK OK — no memory leak detected");
    process.exit(0);
  }
  console.error(`SOAK FAILED (${failures} checks)`);
  process.exit(1);
};

void main();
