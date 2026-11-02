// Published-artifact contracts for the minimum supported Node runtime.
// Run after build: node scripts/runtime-contracts.mjs
import assert from "node:assert/strict";
import { Keala } from "../dist/index.js";
import { listen } from "../dist/adapters/node.js";
import { createBodyParser, bodyOf } from "../dist/plugins/body-parser.js";
import { etag } from "../dist/middleware/etag.js";
import { requestId } from "../dist/middleware/headers.js";

const app = new Keala({ env: "test", requestTimeout: 50 });
app.use(createBodyParser());
app.use(async (c, next) => {
  await next();
  if (c.path === "/replace") return c.json({ public: true });
});
app.get("/replace", (c) => c.json({ secret: "internal" }));
app.get("/deadline", () => new Promise(() => {}));
app.post("/json", async (c) => c.json(await bodyOf(c).json()));
app.post("/raw", async (c) => c.text(await c.raw.text()));
app.post("/bytes", async (c) => c.text(String((await bodyOf(c).arrayBuffer()).byteLength)));
app.get("/tagged", requestId(), etag(), (c) => c.text("123456789"));
app.get("/response-bytes", async (c) => {
  const bytes = await c.text("hello").bytes();
  return c.text(new TextDecoder().decode(bytes));
});
const server = await listen(app, {
  hostname: "127.0.0.1",
  port: 0,
  maxRequestBodySize: 16,
}).ready();
const base = `http://127.0.0.1:${server.port}`;
try {
  const directJson = await app.handle(
    new Request(`${base}/json`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "11" },
      body: '{"ok":true}',
    }),
  );
  assert.deepEqual(await directJson.json(), { ok: true });
  assert.equal(await (await fetch(`${base}/response-bytes`)).text(), "hello");
  const tagged = await fetch(`${base}/tagged`);
  assert.equal(tagged.headers.get("etag"), 'W/"cbf43926"');
  assert.match(tagged.headers.get("x-request-id"), /^[0-9a-f-]{36}$/);
  assert.equal(await tagged.text(), "123456789");
  const cached = await fetch(`${base}/tagged`, { headers: { "if-none-match": 'W/"cbf43926"' } });
  assert.equal(cached.status, 304);
  assert.equal(await cached.text(), "");
  assert.deepEqual(await (await fetch(`${base}/replace`)).json(), { public: true });
  assert.deepEqual(
    await (
      await fetch(`${base}/json`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"ok":true}',
      })
    ).json(),
    { ok: true },
  );
  assert.equal(await (await fetch(`${base}/bytes`, { method: "POST", body: "123" })).text(), "3");
  const oversized = await fetch(`${base}/raw`, { method: "POST", body: "x".repeat(17) });
  assert.equal(oversized.status, 413);
  await oversized.text();
  const deadline = await fetch(`${base}/deadline`);
  assert.equal(deadline.status, 504);
  await deadline.text();
} finally {
  await app.close({ drain: 100 });
}

const queued = new Keala({ env: "test", overload: { maxConcurrency: 1, maxQueue: 1 } });
let release;
queued.get("/", async (c) => {
  if (!release)
    await new Promise((resolve) => {
      release = resolve;
    });
  return c.text("ok");
});
const first = queued.handle(new Request("http://localhost/"));
const second = queued.handle(new Request("http://localhost/"));
release();
assert.equal(await (await first).text(), "ok");
assert.equal(await (await second).text(), "ok");
assert.equal(queued.inFlight, 0);
await queued.close();
console.log(`runtime contracts passed on ${process.version}`);
