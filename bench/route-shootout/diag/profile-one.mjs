// 用法: node profile-one.mjs <serverTs> <port> <probePath> <profDir>
// 启动 bun --cpu-prof 服务器 → 压测 → SIGINT 收 profile
import { spawn } from "node:child_process";
import autocannon from "autocannon";

const [, , serverTs, portArg, probe, profDir] = process.argv;
const port = Number(portArg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn("bun", ["--cpu-prof", `--cpu-prof-dir=${profDir}`, serverTs, String(port)], {
  stdio: "ignore",
  detached: false,
});
const waitReady = async () => {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/status`);
      if (r.ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error("server never ready");
};
try {
  await waitReady();
  await sleep(500);
  const res = await autocannon({
    url: `http://127.0.0.1:${port}${probe}`,
    connections: 200,
    duration: 10,
    workers: 4,
    warmup: { connections: 200, duration: 2 },
  });
  console.log(`${serverTs} ${probe}: ${Math.round(res.requests.average)} req/s`);
} finally {
  child.kill("SIGINT");
  await sleep(2000);
  try {
    child.kill("SIGTERM");
  } catch {}
  await sleep(1500);
}
