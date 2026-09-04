// DIAG 3 — full-pipeline in-process micro (no HTTP, no client): app.handle
// vs app.fetch on the exact shootout table. Combined with diag/router-micro
// this decomposes each framework's per-request cost into router Δ vs
// context/dispatch/respond Δ.
//
// Run: bun bench/route-shootout/diag/pipeline-micro.ts
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
  ["trie 4-seg param", "GET", "/user/lookup/username/hey"],
  ["trie mixed", "GET", "/event/abcd1234/comments"],
  ["trie param-only", "GET", "/event/abcd1234"],
];

const requestOf = (method: string, path: string): Request =>
  method === "GET" ? new Request(`http://x${path}`) : new Request(`http://x${path}`, { method });

const bench = (label: string, fn: () => unknown): number => {
  for (let i = 0; i < 30_000; i++) void fn();
  const rounds: number[] = [];
  for (let r = 0; r < 5; r++) {
    const N = 200_000;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) void fn();
    rounds.push(((performance.now() - t0) * 1e6) / N);
  }
  rounds.sort((a, b) => a - b);
  const median = rounds[2] as number;
  console.log(`${label.padEnd(24)} ${median.toFixed(0).padStart(8)} ns/req`);
  return median;
};

// A returned Response with a consumed-once body must not be re-read, but the
// framework only CONSTRUCTS it here (the caller never reads) — identical on
// both sides, so the comparison stays fair.
const kealaNs: Record<string, number> = {};
const honoNs: Record<string, number> = {};
console.log("keala app.handle:");
for (const [label, method, path] of PROBES) {
  const req = requestOf(method, path);
  kealaNs[label] = bench(label, () => kealaApp.handle(req));
}
console.log("hono app.fetch:");
for (const [label, method, path] of PROBES) {
  const req = requestOf(method, path);
  honoNs[label] = bench(label, () => honoApp.fetch(req));
}
console.log("\nkeala/hono per shape (pipeline):");
for (const [label] of PROBES) {
  const k = kealaNs[label] as number;
  const h = honoNs[label] as number;
  console.log(`${label.padEnd(24)} ${(k / h).toFixed(2)}x  (Δ ${(k - h).toFixed(0)} ns)`);
}
console.log("\nrouter-share of the pipeline Δ (from diag/router-micro):");
// Router deltas re-measured after R413 (bench/route-shootout/diag/router-micro.ts).
const ROUTER_DELTA: Record<string, number> = {
  static: -5.0,
  "trie 4-seg param": 43.2,
  "trie mixed": 48.9,
  "trie param-only": 38.7,
};
for (const [label] of PROBES) {
  const k = kealaNs[label] as number;
  const h = honoNs[label] as number;
  const r = ROUTER_DELTA[label] as number;
  console.log(
    `${label.padEnd(24)} pipeline Δ ${(k - h).toFixed(0).padStart(5)} ns | router Δ ${r.toFixed(0).padStart(5)} ns | non-router Δ ${(k - h - r).toFixed(0).padStart(5)} ns`,
  );
}
