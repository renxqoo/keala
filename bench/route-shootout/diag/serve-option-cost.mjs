// DIAG — which Bun.serve option costs per-request native time?
// Variants: plain / +error handler / +websocket handlers (keala installs
// ws unconditionally, hono has neither). Short paired fires (drift-proof):
// per-round ratio medians + IQR.
//
// Run: node bench/route-shootout/diag/serve-option-cost.mjs
import { spawn } from "node:child_process";
import autocannon from "autocannon";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROUNDS = Number(process.argv[2] ?? 12);
const DUR = Number(process.argv[3] ?? 3);

const fetchFn = `const fetchFn = (req) => new Response("user", { headers: { "content-type": "text/plain;charset=utf-8" } });`;
const VARIANTS = [
  {
    name: "plain",
    port: 4350,
    src: `${fetchFn}
Bun.serve({ port: PORT, hostname: "127.0.0.1", fetch: fetchFn });
process.on("SIGINT", () => process.exit(0));`,
  },
  {
    name: "+error",
    port: 4351,
    src: `${fetchFn}
Bun.serve({
  port: PORT, hostname: "127.0.0.1", fetch: fetchFn,
  error: (e) => new Response("boom:" + e.message, { status: 500 }),
});
process.on("SIGINT", () => process.exit(0));`,
  },
  {
    name: "+ws",
    port: 4352,
    src: `${fetchFn}
Bun.serve({
  port: PORT, hostname: "127.0.0.1", fetch: fetchFn,
  websocket: { message(ws, m) { void ws; void m; }, open(ws) { void ws; }, close(ws) { void ws; } },
});
process.on("SIGINT", () => process.exit(0));`,
  },
];

const fire = (port) =>
  autocannon({
    url: `http://127.0.0.1:${port}/user`,
    connections: 200,
    duration: DUR,
    workers: 4,
    warmup: { connections: 200, duration: 1 },
  });

for (const v of VARIANTS) {
  v.child = spawn("bun", ["-e", v.src.replaceAll("PORT", String(v.port))], { stdio: "ignore" });
}
const med = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
try {
  for (const v of VARIANTS) {
    for (let i = 0; i < 40; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${v.port}/user`)).ok) break;
      } catch {}
      await sleep(250);
    }
  }
  await sleep(1500);
  // 轮内三变体背靠背 → 每轮得到 plain:error:ws 同频窗三元组，漂移被配对抵消
  const perRound = VARIANTS.map(() => []);
  for (let round = 0; round < ROUNDS; round++) {
    // 每轮轮换首发，消除首发位偏置
    const order = [...VARIANTS.keys()];
    const shifted = [...order.slice(round % order.length), ...order.slice(0, round % order.length)];
    for (const vi of shifted) {
      const res = await fire(VARIANTS[vi].port);
      perRound[vi].push(res.requests.average);
      process.stdout.write(
        VARIANTS[vi].name[0] === "+" ? VARIANTS[vi].name[1] : VARIANTS[vi].name[0],
      );
    }
    process.stdout.write("|");
  }
  console.log("");
  for (let vi = 0; vi < VARIANTS.length; vi++) {
    const v = VARIANTS[vi];
    const rounds = perRound[vi];
    console.log(
      `${v.name.padEnd(7)} 中位 ${Math.round(med(rounds))}  轮值 [${rounds.map((x) => Math.round(x / 1000) + "k").join(",")}]`,
    );
  }
  // 配对比值（同轮 plain 基准）
  const ratios = VARIANTS.slice(1).map(() => []);
  for (let r = 0; r < ROUNDS; r++) {
    const base = perRound[0][r];
    for (let vi = 1; vi < VARIANTS.length; vi++) ratios[vi - 1].push(perRound[vi][r] / base);
  }
  VARIANTS.slice(1).forEach((v, i) => {
    const rs = ratios[i];
    const sorted = [...rs].sort((a, b) => a - b);
    const q1 = sorted[Math.floor(sorted.length * 0.25)];
    const q3 = sorted[Math.floor(sorted.length * 0.75)];
    console.log(
      `${v.name}/plain 配对中位 ${med(rs).toFixed(3)}x  IQR [${q1.toFixed(3)}, ${q3.toFixed(3)}]`,
    );
  });
} finally {
  for (const v of VARIANTS) v.child.kill("SIGINT");
  await sleep(1000);
}
