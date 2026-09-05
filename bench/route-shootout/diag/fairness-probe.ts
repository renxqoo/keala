// DIAG — fairness probe for the void-vs-await micro methodology.
// If a framework defers real work to microtasks, a `void fn()` tight loop
// undercounts it (continuations only run when the loop yields). Compare:
//   A) void loop (what pipeline-fresh / adapter-fresh measure)
//   B) batched-await loop (every N calls fully settled before t1)
// per framework on a static and a dynamic probe.
import { Keala } from "../../../src/index.ts";
import { Hono } from "hono";

const TABLE: ReadonlyArray<readonly [string, string]> = [
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
const keala = new Keala({ env: "production" });
const hono = new Hono();
for (const [m, p] of TABLE) {
  if (m === "GET") {
    keala.get(p, () => new Response("x"));
    hono.get(p, (c) => c.text("x"));
  } else {
    keala.post(p, () => new Response("x"));
    hono.post(p, (c) => c.text("x"));
  }
}

const RING = 1024;
const ringOf = (path: string) =>
  Array.from({ length: RING }, (_, i) => new Request(`http://h${i}.x${path}`));

const timeVoid = (fn: (req: Request) => unknown, ring: Request[]): number => {
  const rounds: number[] = [];
  for (let r = 0; r < 5; r++) {
    const N = 100_000;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) fn(ring[i % RING] as Request);
    rounds.push(((performance.now() - t0) * 1e6) / N);
  }
  rounds.sort((a, b) => a - b);
  return rounds[2] as number;
};

const timeAwaited = async (fn: (req: Request) => unknown, ring: Request[]): Promise<number> => {
  const BATCH = 512;
  const rounds: number[] = [];
  for (let r = 0; r < 5; r++) {
    const N = 100_000;
    const t0 = performance.now();
    for (let i = 0; i < N; i += BATCH) {
      for (let j = 0; j < BATCH; j++) fn(ring[(i + j) % RING] as Request);
      await null; // 排空 microtask 队列（含所有已 resolve 的 promise 续体）
    }
    rounds.push(((performance.now() - t0) * 1e6) / N);
  }
  rounds.sort((a, b) => a - b);
  return rounds[2] as number;
};

for (const [label, path] of [
  ["static /user", "/user"],
  ["mixed /event/:id/comments", "/event/abcd1234/comments"],
] as const) {
  const ring = ringOf(path);
  // 预热
  for (let i = 0; i < 20_000; i++) {
    void keala.handle(ring[i % RING] as Request);
    void hono.fetch(ring[i % RING] as Request);
  }
  const kv = timeVoid((req) => void keala.handle(req), ring);
  const ka = await timeAwaited((req) => void keala.handle(req), ring);
  const hv = timeVoid((req) => void hono.fetch(req), ring);
  const ha = await timeAwaited((req) => void hono.fetch(req), ring);
  console.log(
    `${label}\n  keala handle: void ${kv.toFixed(0)} ns | awaited ${ka.toFixed(0)} ns (Δ ${(ka - kv).toFixed(0)})\n  hono fetch : void ${hv.toFixed(0)} ns | awaited ${ha.toFixed(0)} ns (Δ ${(ha - hv).toFixed(0)})`,
  );
}
