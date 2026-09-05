// DIAG — pipeline micro with FRESH Request objects per iteration.
// pipeline-micro.ts reuses ONE Request across 200k iterations, so any
// per-Request parsing/caching is paid once and the measured per-request
// cost hides URL work that real HTTP (a new Request per connection event)
// pays every time. This variant cycles a pre-allocated ring of distinct
// Request objects so both frameworks pay full per-request parsing, exactly
// like the serve path.
//
// Run: bun bench/route-shootout/diag/pipeline-fresh.ts
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

const kealaApp = new Keala({ env: "production" });
const honoApp = new Hono();
for (const [method, path] of TABLE) {
  if (method === "GET") {
    kealaApp.get(path, () => new Response("x"));
    honoApp.get(path, (c) => c.text("x"));
  } else {
    kealaApp.post(path, () => new Response("x"));
    honoApp.post(path, (c) => c.text("x"));
  }
}

const PROBES: ReadonlyArray<readonly [string, string, string]> = [
  ["static", "GET", "/user"],
  ["same-radix static", "GET", "/user/comments"],
  ["long static", "GET", "/very/deeply/nested/route/hello/there"],
  ["wildcard", "GET", "/static/index.html"],
  ["trie mixed", "GET", "/event/abcd1234/comments"],
];

const RING = 4096; // distinct live Request objects cycled per benchmark

const makeRing = (method: string, path: string): Request[] => {
  const ring: Request[] = [];
  for (let i = 0; i < RING; i++) {
    // Vary the host so no request object equals another; path bytes stay
    // identical so routing work per request is unchanged.
    const host = `h${i}.x`;
    ring.push(
      method === "GET"
        ? new Request(`http://${host}${path}`)
        : new Request(`http://${host}${path}`, { method }),
    );
  }
  return ring;
};

const bench = (label: string, fn: (req: Request) => unknown, ring: Request[]): number => {
  for (let i = 0; i < 20_000; i++) void fn(ring[i % RING] as Request);
  const rounds: number[] = [];
  for (let r = 0; r < 5; r++) {
    const N = 200_000;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) void fn(ring[i % RING] as Request);
    rounds.push(((performance.now() - t0) * 1e6) / N);
  }
  rounds.sort((a, b) => a - b);
  const median = rounds[2] as number;
  console.log(`${label.padEnd(24)} ${median.toFixed(0).padStart(8)} ns/req`);
  return median;
};

const kealaNs: Record<string, number> = {};
const honoNs: Record<string, number> = {};
console.log("keala app.handle (fresh requests):");
for (const [label, method, path] of PROBES) {
  const ring = makeRing(method, path);
  kealaNs[label] = bench(label, (req) => kealaApp.handle(req), ring);
}
console.log("hono app.fetch (fresh requests):");
for (const [label, method, path] of PROBES) {
  const ring = makeRing(method, path);
  honoNs[label] = bench(label, (req) => honoApp.fetch(req), ring);
}
console.log("\nkeala/hono per shape (fresh-request pipeline):");
for (const [label] of PROBES) {
  const k = kealaNs[label] as number;
  const h = honoNs[label] as number;
  console.log(`${label.padEnd(24)} ${(k / h).toFixed(2)}x  (Δ ${(k - h).toFixed(0)} ns)`);
}
