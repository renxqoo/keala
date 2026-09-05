// DIAG — bench the EXACT fetch closure startBunServer installs for Bun.serve
// (captured via the injectable serveImpl) against hono's app.fetch, both fed
// a ring of fresh Request objects. This is the full serve path minus
// Bun.serve itself: adapter glue + dispatch + context + respond.
//
// Run: bun bench/route-shootout/diag/adapter-fresh.ts
import { Hono } from "hono";
import { Keala } from "../../../src/index.ts";
import { startBunServer } from "../../../src/adapters/bun.ts";
import type { ServeImplementation } from "../../../src/adapters/bun.ts";

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

// Capture the fetch closure Bun.serve would receive.
let captured: ((req: Request, server: unknown) => Response | Promise<Response>) | undefined;
const fakeServe = ((options: unknown) => {
  const o = options as { fetch: typeof captured };
  captured = o.fetch;
  return {
    fetch: () => new Response("unused"),
    stop: () => undefined,
  };
}) as unknown as ServeImplementation;
startBunServer(kealaApp, { port: 0 }, undefined, fakeServe);
if (!captured) throw new Error("fetch closure not captured");
const kealaFetch = captured;
const fakeServer = {} as never; // runtime channel carrier arg

const PROBES: ReadonlyArray<readonly [string, string, string]> = [
  ["static", "GET", "/user"],
  ["same-radix static", "GET", "/user/comments"],
  ["long static", "GET", "/very/deeply/nested/route/hello/there"],
  ["wildcard", "GET", "/static/index.html"],
  ["trie mixed", "GET", "/event/abcd1234/comments"],
];

const RING = 4096;
const makeRing = (method: string, path: string): Request[] => {
  const ring: Request[] = [];
  for (let i = 0; i < RING; i++) {
    ring.push(
      method === "GET"
        ? new Request(`http://h${i}.x${path}`)
        : new Request(`http://h${i}.x${path}`, { method }),
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
  console.log(`${label.padEnd(24)} ${(rounds[2] as number).toFixed(0).padStart(8)} ns/req`);
  return rounds[2] as number;
};

const kealaNs: Record<string, number> = {};
const honoNs: Record<string, number> = {};
console.log("keala serve fetch closure (fresh):");
for (const [label, method, path] of PROBES) {
  const ring = makeRing(method, path);
  kealaNs[label] = bench(label, (req) => kealaFetch(req, fakeServer), ring);
}
console.log("hono app.fetch (fresh):");
for (const [label, method, path] of PROBES) {
  const ring = makeRing(method, path);
  honoNs[label] = bench(label, (req) => honoApp.fetch(req), ring);
}
console.log("\nkeala/hono per shape (adapter-level, fresh):");
for (const [label] of PROBES) {
  const k = kealaNs[label] as number;
  const h = honoNs[label] as number;
  console.log(`${label.padEnd(24)} ${(k / h).toFixed(2)}x  (Δ ${(k - h).toFixed(0)} ns)`);
}
