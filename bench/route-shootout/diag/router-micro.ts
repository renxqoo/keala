// DIAG 1 — router-isolated microbenchmark (no HTTP, no context machinery).
//
// Question: is the mixed-scenario gap (/event/:id/comments, hono +12-14%)
// in ROUTING itself, and which route shape pays? Same 12-route table on
// both routers; keala via matchRoute(app.router, path), hono via its
// SmartRouter (app.router.match(method, path) — the public entry Hono's
// own dispatch calls).
//
// Run: bun bench/route-shootout/diag/router-micro.ts
import { Keala } from "../../../src/index.ts";
import { matchRoute } from "../../../src/router/router.ts";
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
  const kealaHandler = () => new Response("x");
  const honoHandler = (c: { text: (s: string) => Response }) => c.text("x");
  if (method === "GET") {
    kealaApp.get(path, kealaHandler);
    honoApp.get(path, honoHandler as never);
  } else {
    kealaApp.post(path, kealaHandler);
    honoApp.post(path, honoHandler as never);
  }
}

// Shape probes (bucket-fast status noted from indexPattern's rules):
// - /user            static bucket hit (staticMap)
// - /map/…/events    bucket.fast ACTIVE (single dynamic def in "map")
// - /user/lookup/…   trie walk (bucket "user" has 2 dynamic defs)
// - /event/…         trie walk (bucket "event" has 3 dynamic defs + static
//                    children under the :id param node)
const PROBES: ReadonlyArray<readonly [string, string, string]> = [
  ["static", "GET", "/user"],
  ["bucket-fast (map)", "GET", "/map/berlin/events"],
  ["trie 4-seg param", "GET", "/user/lookup/username/hey"],
  ["trie mixed", "GET", "/event/abcd1234/comments"],
  ["trie param-only", "GET", "/event/abcd1234"],
  ["wildcard fallback", "GET", "/static/index.html"],
];

const medOf = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
};

/** One measurement round; warmup on the first call only. */
const benchRounds = (fn: () => unknown, warmup: boolean): number => {
  if (warmup) for (let i = 0; i < 100_000; i++) fn();
  const N = 500_000;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) fn();
  return ((performance.now() - t0) * 1e6) / N;
};

// ABAB per shape: keala and hono samples interleave within every probe so
// machine drift between the halves cannot masquerade as a framework delta.
const kealaNs: Record<string, number> = {};
const honoNs: Record<string, number> = {};
for (const [label, method, path] of PROBES) {
  const k: number[] = [];
  const h: number[] = [];
  for (let round = 0; round < 5; round++) {
    k.push(benchRounds(() => matchRoute(kealaApp.router, path), round === 0));
    h.push(benchRounds(() => honoApp.router.match(method, path), round === 0));
  }
  kealaNs[label] = medOf(k);
  honoNs[label] = medOf(h);
  console.log(
    `${label.padEnd(24)} keala ${kealaNs[label].toFixed(1).padStart(7)} ns  hono ${honoNs[label].toFixed(1).padStart(7)} ns`,
  );
}
console.log("\nkeala/hono per shape:");
for (const [label] of PROBES) {
  const ratio = (kealaNs[label] as number) / (honoNs[label] as number);
  console.log(
    `${label.padEnd(24)} ${ratio.toFixed(2)}x  (Δ ${((kealaNs[label] as number) - (honoNs[label] as number)).toFixed(1)} ns)`,
  );
}
