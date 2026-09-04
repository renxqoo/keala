// DIAG 2 — Node idle-RSS attribution for keala(node) vs hono(node).
//
// The shootout measured idle RSS 97.5MB (keala) vs 80.4MB (hono) with
// EQUAL heapUsed (~11.6/11.9MB) — the delta is not JS objects. This script
// attributes it stepwise in ONE process (cumulative) and confirms the
// two-process delta in isolation. Run under:
//
//   node --expose-gc bench/route-shootout/diag/node-memory.mjs
import { execSync } from "node:child_process";

const TABLE = [
  ["GET", "/user"],
  ["GET", "/user/comments"],
  ["GET", "/user/avatar"],
  ["GET", "/user/lookup/username/:username"],
  ["GET", "/user/lookup/email/:address"],
  ["GET", "/event/:id"],
  ["GET", "/event/:id/comments"],
  ["POST", "/event/:id/comment"],
  ["GET", "/map/:location/events"],
  ["GET", "/status"],
  ["GET", "/very/deeply/nested/route/hello/there"],
  ["GET", "/static/*"],
];

const v8 = await import("node:v8");
const MB = 1024 * 1024;

const sample = (label) => {
  globalThis.gc();
  const mu = process.memoryUsage();
  const spaces = Object.fromEntries(
    v8.getHeapSpaceStatistics().map((s) => [s.space_name, s.physical_space_size]),
  );
  console.log(
    `${label.padEnd(34)} rss=${(mu.rss / MB).toFixed(1).padStart(6)} heapTotal=${(mu.heapTotal / MB).toFixed(1).padStart(6)} heapUsed=${(mu.heapUsed / MB).toFixed(1).padStart(6)} external=${(mu.external / MB).toFixed(1).padStart(5)} arrayBuffers=${(mu.arrayBuffers / MB).toFixed(1).padStart(5)} | old=${((spaces.old_space ?? 0) / MB).toFixed(1)} code=${((spaces.code_space ?? 0) / MB).toFixed(1)} jit=${((spaces.code_range ?? 0) / MB).toFixed(1)}`,
  );
};

console.log("== stepwise (one process, cumulative) ==");
sample("bare node");

const { Hono } = await import("hono");
const honoApp = new Hono();
for (const [m, p] of TABLE) honoApp[m.toLowerCase()](p, (c) => c.text("x"));
sample("+ hono app built");

// Root-barrel entry (what the shootout server imports).
const { Keala } = await import("../../../src/index.ts");
const kealaApp = new Keala({ env: "production" });
for (const [m, p] of TABLE) kealaApp[m.toLowerCase()](p, () => new Response("x"));
sample("+ keala app built (root barrel)");

const { listen } = await import("../../../src/adapters/node.ts");
const handle = listen(kealaApp, { port: 0, hostname: "127.0.0.1" });
await handle.ready();
sample("+ keala listen (node adapter)");

const { serve } = await import("@hono/node-server");
const honoServer = serve({ fetch: honoApp.fetch, port: 0, hostname: "127.0.0.1" });
await new Promise((r) => setTimeout(r, 300));
sample("+ hono serve (@hono/node-server)");

console.log(`\nkeala listen port=${handle.port} hono port=${honoServer.port}`);
console.log(`node ${process.version}  bun-not-involved`);

// Isolated two-process confirmation of the shootout delta.
console.log("\n== isolated processes (shootout server shape) ==");
const probe = (cmd) => {
  const out = execSync(
    `node --expose-gc -e '
      process.env.NODE_ENV = "production";
      const done = (tag) => { globalThis.gc(); const m = process.memoryUsage();
        console.log(tag, (m.rss/1048576).toFixed(1), (m.heapUsed/1048576).toFixed(1)); };
      const args = process.argv.slice(1);
      const t = [];
      import(args[0]).then(async (mod) => {
        const { Keala } = mod; const { listen } = await import(args[1]);
        const app = new Keala({ env: "production" });
        for (const r of ${JSON.stringify(TABLE)}) app[r[0].toLowerCase()](r[1], () => new Response("x"));
        const h = listen(app, { port: 0, hostname: "127.0.0.1" });
        await h.ready(); setTimeout(() => { done("KEALA-ISOLATED"); process.exit(0); }, 200);
      });' ${cmd} `,
    { encoding: "utf8", cwd: process.cwd() },
  );
  console.log(out.trim());
};
probe("./src/index.ts ./src/adapters/node.ts");
const honoOut = execSync(
  `node --expose-gc -e '
    const { Hono } = await import("hono");
    const { serve } = await import("@hono/node-server");
    const app = new Hono();
    for (const r of ${JSON.stringify(TABLE)}) app[r[0].toLowerCase()](r[1], (c) => c.text("x"));
    serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    setTimeout(() => { globalThis.gc(); const m = process.memoryUsage();
      console.log("HONO-ISOLATED", (m.rss/1048576).toFixed(1), (m.heapUsed/1048576).toFixed(1)); process.exit(0); }, 200);
  ' --input-type=module`,
  { encoding: "utf8" },
);
console.log(honoOut.trim());

handle.stop(true);
honoServer.close();
process.exit(0);
